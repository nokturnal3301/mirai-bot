# Mirai Bot

Self-hosted Telegram bot for downloading public videos, photos, carousels, and
audio from Instagram, TikTok, YouTube Shorts, Threads, Twitter/X, and Reddit.
Send a supported link to the bot and it returns the media directly in Telegram.

![Mirai Bot](assets/mirai-bot.png)

## Supported platforms

| Platform    | Accepted links                                                                   | Output                                                                    |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Instagram   | Reels and posts (`/reel`, `/reels`, `/p`, `/tv`)                                 | Videos, photos, mixed carousels                                           |
| TikTok      | Video and photo posts, including `vm.tiktok.com` and `vt.tiktok.com` short links | Videos, photo slideshows, slideshow audio                                 |
| YouTube     | `youtube.com/shorts/...`                                                         | Combined video or FFmpeg-muxed adaptive video and audio                   |
| Threads     | Post links from `threads.com` and `threads.net`                                  | Videos, photos, carousels, text-only posts                                |
| Twitter / X | Tweet status links from `twitter.com` and `x.com`                                | Videos, photos, animated GIFs, multi-photo posts, text-only tweets        |
| Reddit      | Post, share, `redd.it`, `i.redd.it`, and `v.redd.it` links                       | Images, galleries, native videos with audio, text and external-link posts |

Only public content is supported. Telegram's cloud Bot API limits uploads to
50 MB. Each media group can contain at most 10 items, so longer carousels are
split across multiple sends.

## Highlights

- No third-party downloader service, `yt-dlp`, or headless browser. Extraction
  talks directly to platform pages, internal endpoints, and media CDNs.
- Native YouTube BotGuard flow for minting content-bound PO tokens, with an
  ordered InnerTube client cascade and session rollover.
- Native TikTok WAF proof-of-work solver for posts that do not expose usable
  media in the first SSR response.
- Crawler-facing SSR extraction for anonymous Instagram and Threads posts.
- DASH parsing plus parallel ranged downloads and FFmpeg muxing when video and
  audio are published as separate streams.
- Ordered extraction strategies, retrying HTTP client, and an optional proxy
  rerun after a direct extraction failure.
- Bounded media downloads that stop at Telegram's size limit, plus single-flight
  coalescing for concurrent requests to the same post.
- Optional 30-day Redis cache of Telegram `file_id` values for instant repeat
  delivery of individual videos, photos, and audio.
- Custom `Flow` result type for a typed, railway-oriented bot pipeline, plus a
  discriminated `Media` union with exhaustive dispatch.
- Runtime response validation with Zod and focused Bun unit/integration tests.
- Four runtime dependencies: GramIO, Zod, JSDOM, and Consola.

## Requirements

- [Bun](https://bun.sh) 1.0 or newer
- [FFmpeg](https://ffmpeg.org) for split video/audio streams
- A Telegram bot token
- Redis and an HTTP(S) proxy are optional

The Docker image installs FFmpeg automatically.

## Quick start

Install dependencies:

```bash
bun install
```

Create `.env` in the project root:

```dotenv
TELEGRAM_BOT_TOKEN=your_token_here

# Optional: used by proxy-aware platform requests and as a full extraction
# fallback when the direct attempt fails.
PROXY_URL=http://user:pass@host:port

# Optional: caches Telegram file_id values for 30 days.
REDIS_URL=redis://localhost:6379
```

Start Redis locally when caching is needed:

```bash
docker compose up -d redis
```

Run the bot in development:

```bash
bun run dev
```

For a normal process without hot reload:

```bash
bun run start
```

## Docker

The production Compose profile runs the published image together with Redis:

```bash
TELEGRAM_BOT_TOKEN=your_token \
  docker compose --profile prod up -d
```

Set `IMAGE` to use another image tag and `PROXY_URL` when a proxy is available:

```bash
IMAGE=ghcr.io/nokturnal3301/mirai-bot:latest \
TELEGRAM_BOT_TOKEN=your_token \
PROXY_URL=http://user:pass@host:port \
  docker compose --profile prod up -d
```

## Quality checks

```bash
bun run lint
bunx tsc --noEmit
bun test
```

The GitHub Actions pipeline runs lint and tests on pull requests. Pushes to
`master` additionally build the image, publish it to GHCR, and deploy it to the
configured VPS.

## Request pipeline

1. Find the first HTTP(S) URL in an incoming Telegram message.
2. Match it against the extractor registry and apply the per-user rate limit.
3. Return a cached Telegram `file_id` when Redis has a matching entry.
4. Run the platform's extraction strategies in order until one succeeds.
5. If extraction fails and `PROXY_URL` is configured, rerun the complete
   extractor inside a forced-proxy context.
6. Enforce the 50 MB limit while downloading media and stop terminal failures
   without retrying another strategy or the proxy route.
7. Dispatch the typed media result to the matching Telegram method, splitting
   long carousels into valid media groups.

The rate limiter currently allows five supported-link requests per user per
minute. Unsupported links and messages without URLs are ignored.

## Extraction details

### Instagram

Instagram uses one `ssr` strategy. It requests crawler-facing HTML with a
Googlebot user agent and searches the embedded `data-sjs` JSON for the node that
matches the post shortcode.

- `video_versions` produces a regular video.
- `image_versions2` produces a photo.
- `carousel_media` produces a mixed photo/video carousel.
- `video_dash_manifest` is parsed and muxed; if that fails, the extractor falls
  back to a combined `video_versions` URL.

Instagram sometimes returns HTML without a usable media node or without a
complete DASH manifest to datacenter IPs. When a proxy is configured, the SSR
strategy makes up to three proxy attempts before failing.

### YouTube Shorts

The bot accepts Shorts URLs and calls the InnerTube player endpoint. The
`combined` strategy first tries a stream that already contains video and audio.
The `adaptive` strategy is a fallback: it selects separate streams up to 1080p
and muxes them with FFmpeg.

Player requests cascade through `android_vr`, `tv_simply`, `ios`, and `mweb`.
Clients that require a PO token use a native BotGuard implementation:

1. Fetch and decode the BotGuard challenge.
2. Evaluate the challenge program in JSDOM and produce a snapshot.
3. Exchange the snapshot for an integrity token.
4. Mint a content-bound PO token for the video ID.
5. Attach the token to the InnerTube player request.

The token minter, YouTube session, and player responses are cached in memory.
No YouTube account or cookies are required, but availability still depends on
the source IP, video restrictions, and upstream client behavior.

### TikTok

TikTok tries `web` and then `ssr`:

- `web` resolves direct and short links, parses hydration JSON, and downloads
  media with cookies returned by the page response.
- `ssr` reconstructs the post URL and, when needed, solves TikTok's SHA-256
  proof-of-work challenge before parsing the hydration payload.

Video posts return a video with author and description. Photo posts return a
carousel and, when available, the original track as a separate Telegram audio
message.

### Threads

Threads uses crawler-facing SSR because anonymous browser pages do not reliably
contain the post payload. The extractor walks embedded JSON for the requested
post code and handles videos, photos, mixed carousels, quoted attachments, and
text-only posts.

### Twitter / X

Twitter uses the public syndication payload consumed by the official embed
widget. The endpoint token is derived deterministically from the tweet ID.
Photos are downloaded directly; video variants are sorted by bitrate and probed
so the highest variant that fits Telegram's 50 MB limit can be selected.

### Reddit

Reddit tries `vredd` and then `json`:

- `vredd` handles bare `v.redd.it` URLs by parsing the DASH manifest and muxing
  its best video representation with audio when available.
- `json` resolves post/share/short links, fetches the public `.json` listing,
  validates it, and dispatches galleries, native images, native videos, or a
  text fallback.

The Reddit path solves the current lightweight page challenge to obtain cookies,
caches them in memory for 30 minutes, and refreshes them after an authorization
failure.

## Project structure

```text
src/
|-- bot/           # GramIO handlers, Flow transforms, Telegram media dispatch
|-- config/        # Zod environment schema and application limits
|-- extractors/    # Platform registry and platform-specific strategies
`-- lib/           # Flow, HTTP, proxy context, FFmpeg, Redis cache, utilities

tests/
|-- unit/          # Pipeline, library, registry, and extractor tests
`-- integration/   # URL detection and extractor routing
```

## License

[MIT](LICENSE)
