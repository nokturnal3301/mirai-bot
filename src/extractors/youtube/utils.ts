import type { Flow } from "lib/flow";
import type { StrategyContext } from "lib";
import type { Caption, Media } from "extractors/types";
import type {
	Client,
	InnertubeFormat,
	InnertubeResponse,
	InnertubeResult,
	Session,
	TokenMinter,
} from "extractors/youtube/types";

import { JSDOM } from "jsdom";
import {
	extractionError,
	F,
	HttpStatusError,
	HttpTimeoutError,
	chain,
	createSingleFlight,
	getHttpContext,
	http,
	isRetryableHttpStatus,
	logger,
	strategyFact,
	withCpuAdmission,
	type ExtractionError,
} from "lib";
import { isPublicHttpUrl } from "lib/url";
import {
	ATTESTATION_API_URL,
	ATTESTATION_HEADERS,
	BOTGUARD_REQUEST_KEY,
	CHROME_UA,
	CLIENTS,
	ENGAGEMENT_GRACE_MS,
	ENGAGEMENT_TIMEOUT_MS,
	MINTER_RETRY_DELAY_MS,
	MINTER_TTL_MS,
	NEXT_CLIENT,
	NEXT_ENDPOINT,
	PLAYER_ENDPOINT,
	PLAYER_RESPONSE_TTL_MS,
	REQUEST_TIMEOUT_MS,
	SESSION_TTL_MS,
	TRUSTED_BOTGUARD_HOSTS,
	VIDEO_ID_PATTERNS,
	YOUTUBE_HOME_URL,
} from "extractors/youtube/constants";
import {
	InnertubeResponseSchema,
	NextResponseSchema,
} from "extractors/youtube/schemas";

export const extractVideoId = (url: string): string | null => {
	for (const pattern of VIDEO_ID_PATTERNS) {
		const match = url.match(pattern);
		if (match?.[1]) return match[1];
	}
	return null;
};

export const captionOf = (data: InnertubeResponse): Caption => {
	const details = data.videoDetails;
	const views = details?.viewCount ? Number(details.viewCount) : Number.NaN;
	const text = [details?.title, details?.shortDescription]
		.map((part) => part?.trim())
		.filter(Boolean)
		.join("\n\n");
	return {
		name: details?.author,
		text: text || undefined,
		...(Number.isFinite(views) ? { stats: { views } } : {}),
	};
};

type Engagement = { likes?: number; comments?: number; postedAt?: number };

const COUNT_SCALES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };

export const parseCount = (text?: string): number | undefined => {
	const match = text?.trim().match(/^([\d.,]+)\s*([KMB])?$/i);
	if (!match?.[1]) return undefined;
	const value =
		Number(match[1].replace(/,/g, "")) *
		(COUNT_SCALES[match[2]?.toUpperCase() ?? ""] ?? 1);
	return Number.isFinite(value) ? Math.round(value) : undefined;
};

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

// "Sep 17, 2026" or "Premiered Sep 17, 2026"; noon UTC keeps the calendar day.
export const parsePublishDate = (text?: string): number | undefined => {
	const match = text?.match(/\b([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\b/);
	const month = match?.[1] ? MONTHS.indexOf(match[1]) : -1;
	if (!match || month < 0) return undefined;
	return Date.UTC(Number(match[3]), month, Number(match[2]), 12) / 1000;
};

const LIKE_PATTERNS = [
	/"likeCountIfIndifferentNumber":"(\d+)"/,
	/"accessibilityText":"like this video along with ([\d,]+) other people"/,
];

export const parseEngagement = (text: string): Engagement => {
	const likes = parseCount(
		LIKE_PATTERNS.map((pattern) => text.match(pattern)?.[1]).find(Boolean),
	);
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { likes };
	}
	const parsed = NextResponseSchema.safeParse(json);
	if (!parsed.success) return { likes };
	const comments = parsed.data.engagementPanels
		?.map((panel) => panel.engagementPanelSectionListRenderer)
		.find(
			(panel) => panel?.panelIdentifier === "engagement-panel-comments-section",
		)?.header?.engagementPanelTitleHeaderRenderer?.contextualInfo
		?.runs?.[0]?.text;
	const date =
		parsed.data.contents?.twoColumnWatchNextResults?.results?.results?.contents
			?.map((content) => content.videoPrimaryInfoRenderer?.dateText?.simpleText)
			.find(Boolean);
	return {
		likes,
		comments: parseCount(comments),
		postedAt: parsePublishDate(date),
	};
};

// Metadata only: unlike media URLs it is not bound to the player's proxy route,
// so it goes direct and never spends residential bandwidth.
const fetchEngagement = async (
	videoId: string,
	signal: AbortSignal,
): Promise<Engagement> =>
	parseEngagement(
		await http(NEXT_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": CHROME_UA },
			body: JSON.stringify({ videoId, context: { client: NEXT_CLIENT } }),
			responseType: "text",
			attempts: 1,
			timeout: ENGAGEMENT_TIMEOUT_MS,
			signal,
		}),
	);

const withEngagementCaption = (
	caption: Caption | undefined,
	{ likes, comments, postedAt }: Engagement,
): Caption => ({
	...caption,
	stats: { ...caption?.stats, likes, comments },
	postedAt: postedAt ?? caption?.postedAt,
});

// Starts with the extraction and waits at most ENGAGEMENT_GRACE_MS once the
// video is ready, so likes and comments never delay delivery.
export const prefetchEngagement = (
	url: string,
): ((media: Media) => Promise<Media>) => {
	const controller = new AbortController();
	const videoId = extractVideoId(url);
	const pending = videoId
		? fetchEngagement(videoId, controller.signal).catch((error) => {
				logger.warn(`[youtube] engagement skipped: ${errorMessage(error)}`);
				return undefined;
			})
		: Promise.resolve(undefined);
	return async (media) => {
		const engagement = await Promise.race([
			pending,
			Bun.sleep(ENGAGEMENT_GRACE_MS).then(() => undefined),
		]);
		controller.abort();
		return engagement && media.type === "video"
			? { ...media, caption: withEngagementCaption(media.caption, engagement) }
			: media;
	};
};

export const declaredBytesOf = (
	format: InnertubeFormat,
): number | undefined => {
	const declared = Number(format.contentLength);
	return Number.isFinite(declared) && declared > 0 ? declared : undefined;
};

export const estimatedBytesOf = (
	format: InnertubeFormat,
	durationSeconds?: number,
): number | undefined => {
	const declared = declaredBytesOf(format);
	if (declared !== undefined) return declared;
	if (!format.bitrate || !durationSeconds) return undefined;
	return Math.ceil((format.bitrate * durationSeconds) / 8);
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const encodeBase64Url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

const decodeBase64 = (encoded: string): Uint8Array => {
	const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
};

let cachedSession: Session | null = null;
const loadSession = createSingleFlight<Session>();

const currentRouteKey = (): string => {
	const context = getHttpContext();
	return context?.forceProxy
		? `proxy:${context.proxySession ?? "shared"}`
		: "direct";
};

const fetchSession = async (): Promise<Session> => {
	if (cachedSession && Date.now() - cachedSession.fetchedAt < SESSION_TTL_MS) {
		return cachedSession;
	}

	return loadSession(currentRouteKey(), async () => {
		if (
			cachedSession &&
			Date.now() - cachedSession.fetchedAt < SESSION_TTL_MS
		) {
			return cachedSession;
		}

		const html = await http(YOUTUBE_HOME_URL, {
			headers: {
				"User-Agent": CHROME_UA,
				"Accept-Language": "en-US,en;q=0.9",
			},
			responseType: "text",
			attempts: 1,
			timeout: REQUEST_TIMEOUT_MS,
		});

		const visitorData = html.match(/"visitorData"\s*:\s*"([^"]+)"/)?.[1] ?? "";
		cachedSession = { visitorData, fetchedAt: Date.now() };

		logger.info(
			`[youtube/session] visitorData=${visitorData ? `${visitorData.slice(0, 12)}...` : "MISSING"}`,
		);
		return cachedSession;
	});
};

type ChallengeData = {
	globalName: string;
	challengeProgram: string;
	challengeScript: string;
};

type SandboxResult = {
	sandbox: JSDOM;
	botGuardSnapshot: string;
	proofOfOriginSignalOutput: unknown[];
};

type AsyncSnapshotFn = (
	callback: (snapshot: string) => void,
	args: unknown[],
) => Promise<void>;

let cachedMinter: TokenMinter | null = null;
let pendingMinter: Promise<TokenMinter | null> | null = null;
let minterRetryAt = 0;

const descrambleChallenge = (scrambled: string): unknown[] => {
	const bytes = decodeBase64(scrambled);
	const descrambled = new TextDecoder().decode(bytes.map((b) => b + 97));
	return JSON.parse(descrambled) as unknown[];
};

const resolveChallengeScriptUrl = (scriptUrl: string): string | null => {
	const fullUrl = scriptUrl.startsWith("http")
		? scriptUrl
		: `https://www.youtube.com${scriptUrl}`;

	if (!isPublicHttpUrl(fullUrl)) return null;
	if (!TRUSTED_BOTGUARD_HOSTS.test(new URL(fullUrl).hostname)) return null;
	return fullUrl;
};

const fetchBotGuardChallenge = async (): Promise<
	Flow<ChallengeData, ExtractionError>
> => {
	logger.info("[botguard] initializing...");

	const raw = await http<unknown[]>(`${ATTESTATION_API_URL}/Create`, {
		method: "POST",
		headers: ATTESTATION_HEADERS,
		body: JSON.stringify([BOTGUARD_REQUEST_KEY]),
	});

	const payload =
		raw.length > 1 && typeof raw[1] === "string"
			? descrambleChallenge(raw[1])
			: [];

	const [, wrappedScript, wrappedUrl, , challengeProgram, globalName] =
		payload as [
			unknown,
			unknown[] | null,
			unknown[] | null,
			unknown,
			string,
			string,
		];

	const pickString = (v: unknown[] | null | undefined): string | undefined =>
		Array.isArray(v)
			? (v.find((x) => x && typeof x === "string") as string | undefined)
			: undefined;

	const scriptUrl = pickString(wrappedUrl);
	const inlineScript = pickString(wrappedScript);

	if (scriptUrl) {
		const safeUrl = resolveChallengeScriptUrl(scriptUrl);
		if (!safeUrl) {
			return F.fail(
				extractionError("UPSTREAM_REJECTED", "unsafe BotGuard challenge URL"),
			);
		}
		const challengeScript = await http(safeUrl, { responseType: "text" });
		return F.of({ globalName, challengeProgram, challengeScript });
	}
	if (inlineScript) {
		return F.of({
			globalName,
			challengeProgram,
			challengeScript: inlineScript,
		});
	}
	return F.fail(
		extractionError("UPSTREAM_REJECTED", "no BotGuard challenge script"),
	);
};

const executeBotGuardProgram = async (
	challenge: ChallengeData,
): Promise<Flow<SandboxResult, ExtractionError>> => {
	return withCpuAdmission(async () => {
		const { globalName, challengeProgram, challengeScript } = challenge;

		const sandbox = new JSDOM(
			"<!DOCTYPE html><html><head></head><body></body></html>",
			{
				url: "https://www.youtube.com",
				pretendToBeVisual: true,
				runScripts: "dangerously",
			},
		);
		try {
			const sandboxWindow = sandbox.window as unknown as Record<
				string,
				unknown
			>;
			(sandbox.window as unknown as { eval: (code: string) => void }).eval(
				challengeScript,
			);

			const botGuardVm = sandboxWindow[globalName] as {
				a: (
					program: string,
					vmFunctionsCallback: (asyncSnapshotFn: AsyncSnapshotFn) => void,
					useAsync: boolean,
					userInteractionElement: undefined,
					onReady: () => void,
					signalArrays: [unknown[], unknown[]],
				) => unknown[];
			};

			const asyncSnapshotFn = await new Promise<AsyncSnapshotFn>((resolve) => {
				botGuardVm.a(
					challengeProgram,
					(fn) => resolve(fn),
					true,
					undefined,
					() => {},
					[[], []],
				);
			});

			const proofOfOriginSignalOutput: unknown[] = [];
			const botGuardSnapshot = await new Promise<string>((resolve, reject) => {
				try {
					asyncSnapshotFn(
						(snap) => resolve(snap),
						[undefined, undefined, proofOfOriginSignalOutput, undefined],
					);
				} catch (error) {
					reject(error);
				}
			});

			return F.of({ sandbox, botGuardSnapshot, proofOfOriginSignalOutput });
		} catch (error) {
			sandbox.window.close();
			throw error;
		}
	});
};

const acquireTokenMinter = async (
	result: SandboxResult,
): Promise<Flow<TokenMinter, ExtractionError>> => {
	const { sandbox, botGuardSnapshot, proofOfOriginSignalOutput } = result;

	let mintProofOfOrigin: unknown;
	try {
		const [integrityToken] = await http<[string]>(
			`${ATTESTATION_API_URL}/GenerateIT`,
			{
				method: "POST",
				headers: ATTESTATION_HEADERS,
				body: JSON.stringify([BOTGUARD_REQUEST_KEY, botGuardSnapshot]),
			},
		);

		const createTokenMinter = proofOfOriginSignalOutput[0] as (
			integrityBytes: Uint8Array,
		) => Promise<(contentBinding: Uint8Array) => Promise<Uint8Array>>;

		mintProofOfOrigin = await withCpuAdmission(() =>
			createTokenMinter(decodeBase64(integrityToken)),
		);
	} finally {
		sandbox.window.close();
	}

	if (typeof mintProofOfOrigin !== "function") {
		return F.fail(
			extractionError("SCHEMA_MISMATCH", "BotGuard minter callback invalid"),
		);
	}

	logger.info("[botguard] ready");
	return F.of({
		mint: async (videoId) =>
			withCpuAdmission(async () =>
				encodeBase64Url(
					await mintProofOfOrigin(new TextEncoder().encode(videoId)),
				),
			),
		createdAt: Date.now(),
	});
};

const resolveMinter = async (): Promise<TokenMinter | null> => {
	if (cachedMinter && Date.now() - cachedMinter.createdAt < MINTER_TTL_MS) {
		return cachedMinter;
	}
	if (pendingMinter) return pendingMinter;
	if (Date.now() < minterRetryAt) return null;

	pendingMinter = (async () => {
		try {
			cachedMinter = await chain(fetchBotGuardChallenge())
				.pipe(executeBotGuardProgram)
				.pipe(acquireTokenMinter)
				.result();
		} catch (error) {
			logger.warn(`[botguard] minter failed: ${errorMessage(error)}`);
			cachedMinter = null;
		}
		minterRetryAt = cachedMinter ? 0 : Date.now() + MINTER_RETRY_DELAY_MS;
		return cachedMinter;
	})().finally(() => {
		pendingMinter = null;
	});
	return pendingMinter;
};

const getPoToken = async (videoId: string): Promise<string | null> => {
	const minter = await resolveMinter();
	if (!minter) return null;
	try {
		return await minter.mint(videoId);
	} catch (error) {
		logger.warn(`[botguard] mint failed: ${errorMessage(error)}`);
		return null;
	}
};

const buildPlayerRequest = (
	videoId: string,
	client: Client,
	session: Session,
	poToken: string | null,
): { body: string; headers: Record<string, string> } => {
	const body = JSON.stringify({
		videoId,
		context: {
			client: {
				...client.client,
				...(session.visitorData ? { visitorData: session.visitorData } : {}),
			},
			...(client.embedUrl ? { thirdParty: { embedUrl: client.embedUrl } } : {}),
		},
		contentCheckOk: true,
		racyCheckOk: true,
		...(poToken ? { serviceIntegrityDimensions: { poToken } } : {}),
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-YouTube-Client-Name": client.id,
		"X-YouTube-Client-Version": client.client.clientVersion,
		"User-Agent": client.userAgent,
		Origin: "https://www.youtube.com",
		Referer: "https://www.youtube.com/",
		...(session.visitorData
			? { "X-Goog-Visitor-Id": session.visitorData }
			: {}),
	};

	return { body, headers };
};

const tryClient = async (
	videoId: string,
	client: Client,
	session: Session,
	poToken: string | null,
): Promise<InnertubeResult | null> => {
	if (client.poToken === "player" && !poToken) {
		logger.info(`[youtube/${client.name}] skipping: needs PO token`);
		return null;
	}

	const { body, headers } = buildPlayerRequest(
		videoId,
		client,
		session,
		poToken,
	);

	try {
		const raw = await http<unknown>(PLAYER_ENDPOINT, {
			method: "POST",
			headers,
			body,
			attempts: 1,
			timeout: REQUEST_TIMEOUT_MS,
		});

		const parsed = InnertubeResponseSchema.safeParse(raw);
		if (!parsed.success) {
			logger.warn(`[youtube/${client.name}] schema: ${parsed.error.message}`);
			return null;
		}

		const data: InnertubeResponse = parsed.data;
		const status = data.playabilityStatus?.status ?? "NO_STATUS";
		const reason = data.playabilityStatus?.reason ?? "";
		const formats = data.streamingData?.formats?.length ?? 0;
		const adaptive = data.streamingData?.adaptiveFormats?.length ?? 0;
		const direct = [
			...(data.streamingData?.formats ?? []),
			...(data.streamingData?.adaptiveFormats ?? []),
		].filter((format) => format.url).length;

		logger.info(
			`[youtube/${client.name}] ${status} ${reason} (f=${formats}, a=${adaptive}, direct=${direct})`,
		);

		if (status !== "OK") return null;
		if (direct === 0) return null;

		return {
			data,
			client: { name: client.name, userAgent: client.userAgent },
		};
	} catch (error) {
		logger.warn(`[youtube/${client.name}] error: ${errorMessage(error)}`);
		if (
			error instanceof HttpTimeoutError ||
			(error instanceof HttpStatusError &&
				isRetryableHttpStatus(error.status)) ||
			error instanceof TypeError
		) {
			throw error;
		}
		return null;
	}
};

const runPlayerCascade = async (
	videoId: string,
	skip: Set<string>,
): Promise<InnertubeResult | null> => {
	const session = await fetchSession();

	for (const client of CLIENTS) {
		if (skip.has(client.name) || client.poToken !== "none") continue;
		const result = await tryClient(videoId, client, session, null);
		if (result) return result;
	}

	const poToken = await getPoToken(videoId);
	if (!poToken) return null;

	for (const client of CLIENTS) {
		if (skip.has(client.name) || client.poToken !== "player") continue;
		const result = await tryClient(videoId, client, session, poToken);
		if (result) return result;
	}
	return null;
};

const playerCache = new Map<
	string,
	{ result: InnertubeResult; fetchedAt: number }
>();
const inflight = new Map<string, Promise<InnertubeResult | null>>();
const MAX_PLAYER_CACHE_ENTRIES = 256;

const cacheKey = (videoId: string, skip: string[]): string =>
	`${currentRouteKey()}|${videoId}|${[...skip].sort().join(",")}`;

export const fetchVideoData = async (
	videoId: string,
	skipClients: string[] = [],
): Promise<Flow<InnertubeResult, ExtractionError>> => {
	const key = cacheKey(videoId, skipClients);

	const cached = playerCache.get(key);
	if (cached && Date.now() - cached.fetchedAt < PLAYER_RESPONSE_TTL_MS) {
		playerCache.delete(key);
		playerCache.set(key, cached);
		return F.of(cached.result);
	}
	if (cached) playerCache.delete(key);

	let pending = inflight.get(key);
	if (!pending) {
		pending = runPlayerCascade(videoId, new Set(skipClients)).finally(() => {
			inflight.delete(key);
		});
		inflight.set(key, pending);
	}

	const result = await pending;
	if (!result) {
		return F.fail(
			extractionError("UPSTREAM_REJECTED", "all YouTube clients blocked"),
		);
	}

	playerCache.set(key, { result, fetchedAt: Date.now() });
	while (playerCache.size > MAX_PLAYER_CACHE_ENTRIES) {
		const oldest = playerCache.keys().next().value;
		if (oldest === undefined) break;
		playerCache.delete(oldest);
	}
	return F.of(result);
};

const playerResponseFact = strategyFact<Flow<InnertubeResult, ExtractionError>>(
	"youtube-player-response",
);

export const resolveVideoData = (
	videoId: string,
	context: StrategyContext,
): Promise<Flow<InnertubeResult, ExtractionError>> =>
	context.resolve(playerResponseFact, () => fetchVideoData(videoId));
