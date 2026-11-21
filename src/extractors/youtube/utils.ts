import type { Flow } from "lib/flow";
import type { StrategyContext } from "lib";
import type { Caption, Media } from "extractors/types";
import type {
	Client,
	ClientAnswer,
	InnertubeFormat,
	InnertubeResponse,
	InnertubeResult,
	Refusal,
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
	withStickyProxy,
	type ExtractionError,
} from "lib";
import { isPublicHttpUrl } from "lib/url";
import { CHROME_UA } from "extractors/constants";
import {
	AGE_GATE_PATTERN,
	ATTESTATION_API_URL,
	ATTESTATION_HEADERS,
	BOTGUARD_REQUEST_KEY,
	CLIENTS,
	ENGAGEMENT_GRACE_MS,
	ENGAGEMENT_TIMEOUT_MS,
	MINTER_RETRY_DELAY_MS,
	MINTER_TTL_MS,
	NEXT_CLIENT,
	NEXT_ENDPOINT,
	PLAYER_ENDPOINT,
	PLAYER_RESPONSE_TTL_MS,
	REMOVED_PATTERN,
	REQUEST_TIMEOUT_MS,
	SESSION_TTL_MS,
	TRUSTED_BOTGUARD_HOSTS,
	UNAVAILABLE_PATTERN,
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
		stats: Number.isFinite(views) ? { views } : undefined,
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

const isFresh = (session: Session | null): session is Session =>
	!!session && Date.now() - session.fetchedAt < SESSION_TTL_MS;

const refreshSession = (): Promise<Session> =>
	loadSession(currentRouteKey(), async () => {
		if (isFresh(cachedSession)) return cachedSession;

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

// An expired visitorData still works, so requests use it while a fresh one
// loads in the background instead of waiting for the YouTube homepage.
const fetchSession = async (): Promise<Session> => {
	if (!cachedSession) return refreshSession();
	if (!isFresh(cachedSession)) {
		refreshSession().catch((error) =>
			logger.warn(`[youtube/session] refresh failed: ${errorMessage(error)}`),
		);
	}
	return cachedSession;
};

// Same route as extraction, which always runs through a sticky proxy.
export const warmYouTubeSession = async (): Promise<void> => {
	try {
		await withStickyProxy(refreshSession);
	} catch (error) {
		logger.warn(`[youtube/session] warm-up failed: ${errorMessage(error)}`);
	}
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
	// JSON drops the fields left undefined.
	const body = JSON.stringify({
		videoId,
		context: {
			client: {
				...client.client,
				visitorData: session.visitorData || undefined,
			},
			thirdParty: client.embedUrl ? { embedUrl: client.embedUrl } : undefined,
		},
		contentCheckOk: true,
		racyCheckOk: true,
		serviceIntegrityDimensions: poToken ? { poToken } : undefined,
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

const UNDECIDED: ClientAnswer = { refusal: null };

const refusalOf = (status: string, reason: string): Refusal | null => {
	if (AGE_GATE_PATTERN.test(reason)) return "age-restricted";
	if (REMOVED_PATTERN.test(reason)) return "removed";
	return status === "ERROR" && UNAVAILABLE_PATTERN.test(reason)
		? "unavailable"
		: null;
};

const tryClient = async (
	videoId: string,
	client: Client,
	session: Session,
	poToken: string | null,
): Promise<ClientAnswer> => {
	if (client.poToken === "player" && !poToken) {
		logger.info(`[youtube/${client.name}] skipping: needs PO token`);
		return UNDECIDED;
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
			return UNDECIDED;
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

		if (status !== "OK") return { refusal: refusalOf(status, reason) };
		if (direct === 0) return UNDECIDED;

		return {
			playable: {
				data,
				client: { name: client.name, userAgent: client.userAgent },
			},
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
		return UNDECIDED;
	}
};

// Rolling to another address is pointless once YouTube itself says the video
// is gone or age-gated, so those answers end the extraction.
const cascadeFailure = (
	refusals: readonly (Refusal | null)[],
	fullCascade: boolean,
): ExtractionError => {
	if (refusals.includes("age-restricted")) {
		return extractionError(
			"AGE_RESTRICTED",
			"YouTube shows this video only to signed-in adults",
		);
	}

	const unanimous =
		fullCascade &&
		refusals.length > 1 &&
		refusals.every((refusal) => refusal !== null);
	if (refusals.includes("removed") || unanimous) {
		return extractionError("NO_MEDIA", "YouTube video is private or removed", {
			retryable: false,
			terminal: true,
		});
	}

	return extractionError("UPSTREAM_REJECTED", "all YouTube clients blocked");
};

const runPlayerCascade = async (
	videoId: string,
	skip: Set<string>,
): Promise<Flow<InnertubeResult, ExtractionError>> => {
	const session = await fetchSession();
	const clients = CLIENTS.filter((client) => !skip.has(client.name));
	const refusals: (Refusal | null)[] = [];

	for (const client of clients.filter(({ poToken }) => poToken === "none")) {
		const answer = await tryClient(videoId, client, session, null);
		if ("playable" in answer) return F.of(answer.playable);
		refusals.push(answer.refusal);
	}

	const poToken = await getPoToken(videoId);
	const tokenClients = poToken
		? clients.filter((client) => client.poToken === "player")
		: [];
	for (const client of tokenClients) {
		const answer = await tryClient(videoId, client, session, poToken);
		if ("playable" in answer) return F.of(answer.playable);
		refusals.push(answer.refusal);
	}

	return F.fail(cascadeFailure(refusals, skip.size === 0));
};

const playerCache = new Map<
	string,
	{ result: InnertubeResult; fetchedAt: number }
>();
const playerFlight =
	createSingleFlight<Flow<InnertubeResult, ExtractionError>>();
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

	const result = await playerFlight(key, () =>
		runPlayerCascade(videoId, new Set(skipClients)),
	);
	if (result._tag !== "Continue") return result;

	playerCache.set(key, { result: result.value, fetchedAt: Date.now() });
	while (playerCache.size > MAX_PLAYER_CACHE_ENTRIES) {
		const oldest = playerCache.keys().next().value;
		if (oldest === undefined) break;
		playerCache.delete(oldest);
	}
	return result;
};

const playerResponseFact = strategyFact<Flow<InnertubeResult, ExtractionError>>(
	"youtube-player-response",
);

export const resolveVideoData = (
	videoId: string,
	context: StrategyContext,
): Promise<Flow<InnertubeResult, ExtractionError>> =>
	context.resolve(playerResponseFact, () => fetchVideoData(videoId));
