# Pi Lightpanda Web

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that provides `web_search` and
`web_fetch`, powered entirely by a **local [Lightpanda](https://github.com/lightpanda-io/browser)
browser**. It is a fork of
[`pi-unsloth-webtools`](https://github.com/YuGiMob/pi-unsloth-webtools): the extraction pipeline,
HTML→Markdown conversion, entity decoding, PDF layer, settings, and tests are derived from that
project, but the network stack is replaced with Lightpanda.

There is no direct Node HTTP transport, no `wreq-js` browser-fingerprint tier, and no third-party
rendering service. Every remote page — whether fetched by `web_fetch` or used as a search result
page — is loaded by the local browser.

> The package name is **`pi-lightpanda-web`**. The npm package `pi-lightpanda` is a different,
> unrelated project, so this package uses the `-web` suffix to stay unique.

## Requirements

- Node.js >= 22.19.0.
- A Lightpanda binary (1.0.x recommended). `bash scripts/install-lightpanda.sh` downloads the newest
  stable release and writes `webRender.lightpandaPath` into the global pi settings. Set
  `PI_LIGHTPANDA_BIN` or `webRender.lightpandaPath` / `webRender.lightpandaCommand` to use your own.
- Optional: `mupdf` for local PDF text extraction. Without it, local PDFs return a clear message.

## Install

From a checkout:

```sh
pi install /path/to/pi-lightpanda-web
```

Once the package is published to npm, `pi install npm:pi-lightpanda-web` installs it under the
unique `-web` name. Either way, add the path (or package name) to the `packages` array in
`~/.pi/agent/settings.json`. From the checkout:

```sh
npm install
bash scripts/install-lightpanda.sh
```

The installer supports Linux (glibc; musl needs a source build), macOS, and Windows through WSL2.
On Linux it can bundle a newer glibc into the install directory when the system one is too old, so
Lightpanda 1.0.x runs without touching system libraries.

## Tools

Both tools show their target in the pi TUI: `web_search "query"` and `web_fetch <url>`.

### web_search

`web_search` renders each engine's result page with Lightpanda, parses the dump, and fuses the
results with weighted reciprocal-rank fusion (k=60):

- Default engines: **Brave** and **Ecosia**.
- Results are deduplicated by canonicalized href (`utm_*` and tracking parameters stripped,
  fragments dropped, default ports removed), then capped per registrable domain
  (`webSearch.maxPerHost`, off by default).
- A transient empty render is retried once inside the sweep budget. Engines still in flight are
  aborted once enough results have arrived.
- `websitePolicy` is enforced before rendering and again on every result URL; when a policy
  restricts domains, the query is scoped with rotating `site:` filters and the sweep overfetches.
- Failure messages are stable and documented below.

The engine set was verified live with Lightpanda 1.0.4 from a normal residential connection.
Lightpanda identifies itself honestly and `--user-agent` rejects any value containing `Mozilla`, so
some engines cannot be used:

| Engine | Status | Backend |
|---|---|---|
| Brave | Default | Brave's own independent index |
| Ecosia | Default | Google-provided results (each result is labelled `provider="GOOGLE"`); may answer with a 403 bot challenge |
| Yahoo | Opt-in | Bing's index with Yahoo's ranking; in our runs it was much better than Bing for developer queries |
| Bing | Opt-in | Bing's index; in our runs it returned generic entity pages for developer queries (for example `python.org` instead of the 3.14 release notes, `linux.org` instead of `io_uring` documentation) |
| DuckDuckGo | Unavailable | Anomaly / bot challenge |
| Startpage | Unavailable | Anubis proof-of-work challenge |
| Google | Unavailable | Consent interstitial |
| Mojeek | Unavailable | Captcha |

`npm run engine:eval` measures the engines against a hand-labelled developer query set. On that set:
top-5 URL overlap (mean Jaccard) is **0.37 Brave/Ecosia**, **0.35 Brave/Yahoo**, **0.09 Bing/Ecosia**,
and **0.17 Bing/Yahoo**. Brave and Ecosia are different indexes with moderate overlap; Bing's low
overlap comes from returning generic pages, not from adding useful coverage. Yahoo is Bing-backed but
ranked much better than Bing through Lightpanda, so it remains available as an opt-in fallback.

The same set exposes Bing's specificity problem. **topic@5** (top-5 results whose URL or title contains
a query-specific term such as `3.14`, `hnsw`, or `io_uring`) is Brave **0.97**, Yahoo **0.97**, Ecosia
**0.72**, and Bing **0.25**. Bing's domain-level precision (0.42) looks close to the others only because
broad entity pages such as `python.org` still land on an expected domain; it is not answering the query.
Ecosia answered 6 of 8 queries; the other two came back as `403 BotChallenge`, and the sweep falls back
to Brave for those. That is why the defaults are Brave + Ecosia, with Bing and Yahoo opt-in.

Use `/search-config` to enable or disable engines; Bing and Yahoo are available as opt-ins. At least one engine must stay on.

### web_fetch

- Renders the requested URL with `lightpanda fetch --json --dump html --wait-until networkidle`.
  `--json` supplies the real HTTP status, response headers, and final URL, so errors are reported as
  `Failed to fetch URL: HTTP 404 Not Found` instead of returning an error page as content.
- Converts HTML to Markdown with the ported Studio pipeline: `<article>`/`<main>` scoping,
  hidden-element stripping, header link-density stripping, boilerplate removal, and page metadata
  (`Title:`, `Author:`, `Date:`, `Site:`).
- Adds `URL:` and `Rendered via Lightpanda (local browser; nothing sent to a third party).` to every
  rendered page.
- Local files are read directly (`file://` URLs, absolute paths, `~/`, `./`): HTML is converted,
  text is returned raw, local PDFs are extracted with MuPDF, binary files are rejected. Lightpanda
  itself does not support `file://`, so this is the only non-browser read path.
- Results are cached for 1 hour (128 entries, 128 MiB); a stale entry from the last 24 hours is
  served when a render fails. The cache is never used for blocked URLs or local files.
- `maxChars` truncates the returned text with a `... (truncated, N chars total)` notice.
- Remote PDFs are **not** read: Lightpanda returns no text for `application/pdf`, so `web_fetch`
  reports `(PDF content cannot be read by the local renderer)`. Use a local copy if you need MuPDF
  extraction.

## Local and private access

Private/loopback/link-local targets are allowed by default, so `http://localhost:3000` and LAN hosts
work. Lightpanda blocks unsafe ports (for example port 1) and `file://`; local files still work
through the fs path. Set `webFetch.allowPrivateAddresses: false` to pass
`--block-private-networks` to Lightpanda and restore the SSRF guard. Set
`webFetch.allowLocalFiles: false` to refuse local paths.

## Proxies

`HTTPS_PROXY`, `HTTP_PROXY`, and `ALL_PROXY` are honored when they name an **HTTP(S)** proxy: the
URL is passed to Lightpanda's `--http-proxy`. `NO_PROXY` exclusions are applied before launching.
SOCKS5 proxies (including Tor) are not supported by this fork, because Lightpanda's proxy flag is
HTTP-only.

## Configuration

Settings live in `~/.pi/agent/settings.json` or `.pi/settings.json` (project overrides global).

```json
{
  "piLightpanda": {
    "maxResults": 5,
    "maxChars": 50000,
    "timeoutMs": 60000,
    "allowPrivateAddresses": true,
    "allowLocalFiles": true
  },
  "webFetch": {
    "maxChars": 50000,
    "timeoutMs": 60000,
    "allowPrivateAddresses": true,
    "allowLocalFiles": true
  },
  "webSearch": {
    "engines": ["brave", "ecosia"],
    "engineWeights": { "brave": 1, "ecosia": 1 },
    "maxPerHost": 0
  },
  "webRender": {
    "lightpandaEnabled": true,
    "lightpandaPath": "/home/you/.local/share/pi-lightpanda-web/lightpanda/lightpanda-run"
  }
}
```

| Key | Default | Description |
|---|---|---|
| `piLightpanda.maxResults` / `webSearch.maxResults` | `5` | Default `maxResults` for `web_search` (clamped 1–20) |
| `piLightpanda.maxChars` / `webFetch.maxChars` | tool param | Default `maxChars` for `web_fetch` |
| `piLightpanda.timeoutMs` / `webFetch.timeoutMs` | `60000` fetch, `300000` search | Default `timeoutMs` when the tool param is absent (>= 1000) |
| `piLightpanda.allowPrivateAddresses` / `webFetch.allowPrivateAddresses` | `true` | Set `false` to pass `--block-private-networks` and refuse localhost/LAN targets |
| `piLightpanda.allowLocalFiles` / `webFetch.allowLocalFiles` | `true` | Set `false` to refuse `file://`, absolute, `~/`, and `./` paths |
| `webSearch.engines` / `piLightpanda.engines` | `["brave","ecosia"]` | Enabled engines; unknown names are ignored, an empty match falls back to defaults |
| `webSearch.engineWeights` / `piLightpanda.engineWeights` | all `1` | Positive per-engine RRF weight |
| `webSearch.maxPerHost` / `piLightpanda.maxPerHost` | `0` (no cap) | Most results one registrable domain may contribute |
| `webRender.lightpandaEnabled` / `piLightpanda.lightpandaEnabled` | `true` | Disable the local renderer entirely |
| `webRender.lightpandaPath` / `piLightpanda.lightpandaPath` | installed launcher, else `lightpanda` on `PATH` | Path to the Lightpanda binary |
| `webRender.lightpandaCommand` / `piLightpanda.lightpandaCommand` | none | Command prefix, for WSL (`["wsl.exe","-e","<path>"]`) or containers; overrides `lightpandaPath` |

Environment overrides:

- `PI_LIGHTPANDA_BIN` — renderer binary path.
- `PI_LIGHTPANDA_CACHE_DIR` (or legacy `PI_UNSLOTH_CACHE_DIR`) — fetch cache directory.
- `PI_CODING_AGENT_DIR` / `PI_AGENT_DIR` — global settings directory.
- `PI_LIGHTPANDA_E2E=1` / `PI_LIGHTPANDA_E2E_BIN` — enable and point the live test suite.

## Troubleshooting

| Symptom | Exact string | Action |
|---|---|---|
| Empty query | `No query provided.` | Pass `query`. |
| Cancelled | `Search cancelled.` / `Failed to render URL: cancelled.` | Retry only if unintended. |
| Search timeout | `Search failed: the search engines (...) did not respond within N seconds.` | Retry, narrow the query, or raise `timeoutMs`. |
| No results | `No results found.` | Rephrase, or enable another engine. |
| Policy filtered everything | `No results found within the website access limits.` | Widen `websitePolicy`. |
| Blocked URL | `Blocked: ...` | Respect it. |
| Missing renderer | `(Lightpanda is not installed; run bash scripts/install-lightpanda.sh to enable web_fetch)` | Install Lightpanda or set `PI_LIGHTPANDA_BIN`. |
| Local render failure | `Failed to render URL: Lightpanda exited with code N.` | Check the binary by hand. |
| Bot challenge | `Failed to render URL: the page served a bot challenge instead of content.` | Hard anti-bot walls cannot be bypassed by Lightpanda's honest user agent. |
| HTTP failure | `Failed to fetch URL: HTTP 404 Not Found` | Fix the URL. |
| Remote PDF | `(PDF content cannot be read by the local renderer)` | Use a local PDF. |
| maxChars cut | `... (truncated, N chars total)` | Raise `maxChars`. |
| Cache fallback | `Served from cache` / `STALE cache from YYYY-MM-DD` | The render failed; output is the cached copy. |

## Development

```sh
npm install
npm run typecheck
npm run test:unit
PI_LIGHTPANDA_E2E=1 PI_LIGHTPANDA_E2E_BIN="$(bash scripts/install-lightpanda.sh --print-path)" npm run test:live
npm run engine:eval
npm run lint
npm run check:package
```

`npm run test:unit` runs the offline suite with stubbed renderer processes. `npm run test:live` needs
a real Lightpanda binary and skips itself unless `PI_LIGHTPANDA_E2E=1` is set. CI runs both on Linux,
with the unit suite also on Windows and Node 22.19/24/26.

## License

The ported logic derives from Unsloth Studio
([AGPL-3.0-only](https://github.com/unslothai/unsloth/blob/main/studio/LICENSE.AGPL-3.0)), so this
package is released under the same AGPL-3.0-only license.
