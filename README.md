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

Only public content is supported. The bot caps each downloaded media file at
50 MB; Telegram also applies its own per-method limits. Carousel extraction
considers up to 20 items and retains up to 50 MB of downloaded photo/video data,
skipping unavailable or over-budget items. Carousels are sent as native rich
message collages, with up to 50 attachments per message.

## Highlights

- Native Telegram rich cards: media first, platform logo and name, author,
  and a collapsed description (including hashtags).
- No third-party downloader service, `yt-dlp`, or headless browser. Extraction
  talks directly to platform pages, internal endpoints, and media CDNs.
- Native YouTube BotGuard flow for minting content-bound PO tokens, with an
  ordered InnerTube client cascade and session rollover.
- Native TikTok WAF proof-of-work solver for posts that do not expose usable
  media in the first SSR response.
- Crawler-facing SSR extraction for anonymous Instagram and Threads posts.
- DASH parsing plus parallel ranged downloads and FFmpeg muxing when video and
  audio are published as separate streams.
- Sequential and hedged extraction strategies: delayed alternatives can race
  slow requests, with adaptive delays and circuit breakers on selected routes.
- Retrying HTTP client, optional proxy reruns, bounded response bodies, and
  download deadlines that cover both metadata probes and media transfer.
- Single-flight coalescing for concurrent requests to the same post and reuse
  of the first successful video upload's Telegram `file_id` across chats.
- Optional 30-day Redis cache of Telegram `file_id` values for instant repeat
  delivery of individual videos, photos, and audio.
- Custom `Flow` result type for a typed, railway-oriented bot pipeline, plus a
  discriminated `Media` union with exhaustive dispatch.
- Runtime response validation with Zod and focused Bun unit/integration tests.
- Four runtime dependencies: GramIO, Zod, JSDOM, and Consola.

## Requirements

- [Bun](https://bun.sh) 1.3.2 or newer
- [FFmpeg](https://ffmpeg.org) for split video/audio streams
- A Telegram bot token
- Redis and an HTTP(S) proxy are optional

The Docker image installs FFmpeg automatically.

## Message appearance

Videos, photos, carousels and text posts use Telegram's
[Rich Messages](https://core.telegram.org/bots/api/rich-messages.md):

```text
Reddit title [flair]
[ Video / photo / collage ]
↩ Replying to @handle
❝ Caption, expandable after a few lines ❞
❝ Quoted post — @author ❞
[logo] Name ✓ @author · 720p
[views] 579K · [likes] 77K · [comments] 930 · Nov 12
[music] Song — Artist
```

The caption is an expandable `<blockquote>`; very long ones continue in more
quotes rather than being truncated. The `<footer>` shows what the platform
returns: name, verified mark and handle (`u/` on Reddit, the channel name on
YouTube), quality for a single video, views, likes or Reddit score, comments,
the post date as `<tg-time>` in the reader's locale, and the track. The handle
links to the original post. Automatic entity detection is off, so mentions and
hashtags link to the source platform instead of Telegram users or searches.
Carousels use `<tg-collage>` grids of up to ten items each, which mobile apps
can draw. NSFW and spoiler posts are sent under `tg-spoiler`. Audio tracks use
the standard audio player.

Logos and stat icons come from the bot's own adaptive custom emoji set,
[Mirai Icons](https://t.me/addemoji/mirai_icons_by_mirai_downloader_bot), which
clients repaint in the text color. IDs live in `src/bot/constants.ts`; no pack
installation or runtime lookup is needed. Telegram requires a Premium bot owner
for custom emoji in private/group chats, or an additional username purchased on
Fragment.

Use a current Telegram client to view rich messages. These cards are forwardable;
they do not use protected HTML widgets. `src/bot/rich-message.ts` renders the
card and sends it through GramIO, which uploads the nested media.

## Quick start

Install dependencies:

```bash
bun install
```

Create `.env` in the project root:

```dotenv
TELEGRAM_BOT_TOKEN=your_token_here

# Optional: used by YouTube/Reddit requests and for retryable extraction
# failures on other platforms.
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

Container logs are lost on every redeploy, so the bot also keeps the last
1,000 failed links in Redis with their platform and reason, newest first:

```bash
docker compose exec redis redis-cli LRANGE mirai:failures 0 49
```

## Quality checks

```bash
bun run lint
bun run typecheck
TELEGRAM_BOT_TOKEN=test REDIS_URL='' PROXY_URL='' bun test

# Include a coverage report:
TELEGRAM_BOT_TOKEN=test REDIS_URL='' PROXY_URL='' bun test --coverage
```

Tests use local HTTP servers and mocked platform responses, Telegram calls,
and FFmpeg processes. Rich-card tests cover collapsed content, escaping,
multipart attachments, API error handling and concurrent `file_id` reuse.
They do not need real credentials, Redis, a proxy, or FFmpeg installed.
Integration tests cover URL routing and the YouTube
metadata → download → mux fallback path. Live platform availability depends on
upstream behavior and the source IP.

The GitHub Actions pipeline runs lint, typecheck, and tests on pull requests.
Pushes to `master` additionally build the image, publish it to GHCR, and deploy
the commit-tagged image to the configured VPS.

## Request pipeline

1. Find the first HTTP(S) URL in an incoming Telegram message.
2. Match it against the extractor registry and apply the per-user rate limit.
3. Return a cached Telegram `file_id` when Redis has a matching entry.
4. Run the platform's sequential or hedged strategy plan and materialize the
   selected media. Concurrent requests for the same normalized URL share this
   work. YouTube includes downloading in each strategy, so a failed combined
   download can fall back to adaptive streams.
5. For a retryable extraction failure, make up to two additional attempts with
   fresh sticky proxy sessions when `PROXY_URL` is configured. YouTube also has
   its own route retries; some CDN downloads explicitly try a direct connection
   before the proxy.
6. Enforce download size limits and deadlines. Terminal errors stop the
   extraction strategy runner and whole-extractor proxy retries.
7. Send a rich card with embedded media and collapsed description, or a standard
   audio message. Read returned rich media blocks to cache their `file_id`.

The rate limiter currently allows five supported-link requests per user per
minute. Unsupported links and messages without URLs are ignored.

### Resource limits

- Text, JSON, and text-with-headers responses default to a 5 MB body limit.
  Buffered binary responses default to 50 MB. An explicit `maxBytes` overrides
  these limits; streaming reads stop as soon as they exceed the limit.
- Ordinary HTTP attempts have a 30-second timeout unless overridden. Raw
  responses hand body reading to the caller, which owns its limits and deadline.
- Ranged downloads have an overall deadline from the start of the operation,
  including probes and body reads when a server ignores `Range`. By default it
  is capped at 90 seconds and adjusted to the known size and target minimum
  speed; an explicit download timeout overrides that budget.
- FFmpeg jobs are limited to two concurrent operations, with a 120-second
  deadline covering queueing, input downloads, and muxing.

Limits are configured in `src/config/app.ts` and the relevant download helpers.

## Extraction details

### Instagram

Instagram races four metadata strategies with staggered starts:

- `embed` reads the captioned embed page immediately.
- `ssr` reads crawler-facing HTML after an adaptive delay and searches embedded
  `data-sjs` JSON for the post.
- `mobile` queries the mobile media-info endpoint after 1.5 seconds.
- `graphql` obtains page tokens and queries the logged-out GraphQL endpoint
  after 2.5 seconds.

Definite failures can start alternatives earlier. The first successful media
plan wins and cancels the remaining metadata requests. SSR, mobile, and GraphQL
have circuit breakers for repeated upstream failures.

The normalized result supports videos, photos, and mixed carousels. DASH video
selection prefers H.264 within the 720p cap, then muxes it with audio. Combined
video URLs provide a fallback. Video downloads try the direct CDN route first
and retain the proxy route as a fallback.

### YouTube Shorts

The bot accepts Shorts URLs and calls the InnerTube player endpoint. The
`combined` strategy first tries a stream that already contains video and audio.
The `adaptive` strategy runs if no combined format is usable or its download
fails with a non-terminal error. It selects separate streams, preferring H.264
video up to 1080p and original audio, and muxes them with FFmpeg. A terminal size
failure stops the attempt.

Player requests try `visionos`, then `web_embedded`, and finally `ios` when a
PO token is available. The iOS client uses a native BotGuard implementation:

1. Fetch and decode the BotGuard challenge.
2. Evaluate the challenge program in JSDOM and produce a snapshot.
3. Exchange the snapshot for an integrity token.
4. Mint a content-bound PO token for the video ID.
5. Attach the token to the InnerTube player request.

Both strategies share the first player response within a route attempt. Up to
three route attempts are made for retryable failures, each with a fresh sticky
proxy session when a proxy is configured. Downloads stay inside that session.

The token minter, visitor session, and player responses are cached in memory;
player responses are keyed by route. No YouTube account or cookies are required,
but availability still depends on the source IP, video restrictions, and
upstream client behavior.

### TikTok

TikTok starts `web` immediately and hedges with `ssr` after an adaptive delay
of 100–600 ms, or earlier when `web` fails:

- `web` resolves direct and short links, parses hydration JSON, and downloads
  media with cookies returned by the page response.
- `ssr` reconstructs the post URL and, when needed, solves TikTok's SHA-256
  proof-of-work challenge before parsing the hydration payload.

Video posts return a video with author and description. Photo posts return a
carousel and, when available, the original track as a separate Telegram audio
message. Video selection prefers H.264 renditions within a 720p / 16 MB latency
budget when available. Video bytes are downloaded directly first, with a proxy
fallback, even when metadata was fetched through a proxy.

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

Reddit tries `image`, `vredd`, and then `json`, skipping inapplicable strategies:

- `image` downloads bare `i.redd.it` image links directly.
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
|-- extractors/    # Platform strategies, typed media plans, materialization
`-- lib/           # Flow, strategy execution, HTTP/downloads, FFmpeg, cache

tests/
|-- unit/          # Pipeline, library, registry, and extractor tests
`-- integration/   # URL routing and YouTube download/mux fallback
```

## License

[MIT](LICENSE)
