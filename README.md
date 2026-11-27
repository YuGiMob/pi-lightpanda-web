# Pi Lightpanda Web

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that provides `web_search` and
`web_fetch`, powered entirely by a **local [Lightpanda](https://github.com/lightpanda-io/browser)
browser**. It is a fork of
[`pi-unsloth-webtools`](https://github.com/YuGiMob/pi-unsloth-webtools): the extraction pipeline,
HTML→Markdown conversion, entity decoding, PDF layer, settings, and tests are derived from that
project, but the network stack is replaced with Lightpanda.

There is no direct Node HTTP transport for HTML, no `wreq-js` browser-fingerprint tier, and no
third-party rendering service. Every remote HTML page — whether fetched by `web_fetch` or used as a
search result page — is loaded by the local browser. PDFs are the one documented exception: a narrow
direct downloader fetches them for MuPDF extraction, and it can be disabled.

> The package name is **`pi-lightpanda-web`**. The npm package `pi-lightpanda` is a different,
> unrelated project, so this package uses the `-web` suffix to stay unique.

## Requirements

- Node.js >= 22.19.0.
- A Lightpanda binary. The extension checks at `session_start` and, when no renderer is configured,
  runs `scripts/install-lightpanda.sh` in the background; the first tool call waits for that
  install. There is no postinstall. Set `PI_LIGHTPANDA_BIN` or `webRender.lightpandaPath` /
  `webRender.lightpandaCommand` to use your own binary and suppress the automatic install.
- Optional: `mupdf` for the full PDF engine. Without it, PDF extraction falls back to a limited regular-expression extractor.

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
```

The extension downloads Lightpanda automatically at the next Pi startup. To pre-install it
yourself, run:

```sh
bash scripts/install-lightpanda.sh
```

### Automatic renderer installation

At `session_start`, the extension checks whether a runnable Lightpanda is already available. If
none is configured, it runs `scripts/install-lightpanda.sh --no-configure` in the background. Every
`web_fetch` or `web_search` call that arrives while the install runs waits for it rather than probing,
and cancelling a call stops only that wait: the install keeps running in the background. There is no
postinstall and no bundled binary.

Explicit configuration is respected and suppresses auto-install: `PI_LIGHTPANDA_BIN`,
`webRender.lightpandaPath`, `webRender.lightpandaCommand`, or `webRender.lightpandaEnabled: false`.
The installer supports Linux (glibc; musl needs a source build), macOS, and Windows through WSL2.
Native Windows has no Lightpanda binary. On Linux the installer can bundle a newer glibc into the
install directory when the system one is too old, so Lightpanda 1.0.x runs without touching system
libraries.

## Tools

Both tools show their target in the pi TUI: `web_search "query"` and `web_fetch <url>`.

### web_search

`web_search` renders each engine's result page with Lightpanda, parses the dump, and fuses the
results with weighted reciprocal-rank fusion (k=60):

- Default engines: **Brave** and **Yep**.
- Results are deduplicated by canonicalized href (`utm_*` and tracking parameters stripped,
  fragments dropped, default ports removed), then capped per registrable domain
  (`webSearch.maxPerHost`, off by default).
- A transient empty render is retried once inside the sweep budget.
- Sweeps are serialized inside one process: overlapping `web_search` calls queue and run one at a
  time, so the engines never see concurrent bursts from the same host.
- `websitePolicy` is enforced before rendering and again on every result URL; when a policy
  restricts domains, the query is scoped with rotating `site:` filters and the sweep overfetches.
- Failure messages are stable and documented below.

The engine set was verified live with Lightpanda 1.0.4 from a normal residential connection.
Lightpanda identifies itself honestly and `--user-agent` rejects any value containing `Mozilla`, so
some engines cannot be used:

| Engine | Status | Backend |
|---|---|---|
| Brave | Default | Brave's own independent index; result links are cloaked behind `/go/v1` and resolved through the interstitial page |
| Yep | Default | Yep's own independent index; returns absolute deep links, answers in about 1 second, and occasionally serves a bot challenge that a retry clears |
| Ecosia | Opt-in | Google-provided results (each result is labelled `provider="GOOGLE"`); answers with a 403 Cloudflare bot challenge from some networks |
| Yahoo | Opt-in | Bing-backed index with Yahoo's ranking; ranks well on developer queries |
| DuckDuckGo | Unavailable | Anomaly / bot challenge |
| Startpage | Unavailable | Anubis proof-of-work challenge |
| Google | Unavailable | Consent interstitial |
| Mojeek | Unavailable | Captcha |
| Qwant | Unavailable | Answers 403 Forbidden through Lightpanda |

`npm run engine:eval` measures the engines against a hand-labelled developer query set. On that set:
top-5 URL overlap (mean Jaccard) is **0.37 Brave/Ecosia** and **0.35 Brave/Yahoo**. Brave and Ecosia are
different indexes with moderate overlap. Yahoo is Bing-backed but ranks well for developer queries, so it
remains available as an opt-in fallback.

Ecosia answers intermittently: the rest of the time Cloudflare returns `403 BotChallenge`, which Lightpanda
reports as `the page served a bot challenge instead of content`. Bing was removed because through Lightpanda
it served result pages belonging to unrelated queries, and that poisoned a sweep so thoroughly that it could
preempt the other engine. The sweep now lets every engine finish, so results are fused rather than first-come.
Yahoo and Ecosia remain opt-in.

Use `/search-config` to enable or disable engines; Ecosia and Yahoo are available as opt-ins. At least one engine must stay on.

### web_fetch

- Renders the requested URL with `lightpanda fetch --json --dump html --wait-until networkidle`.
  `--json` supplies the real HTTP status, response headers, and final URL, so errors are reported as
  `Failed to fetch URL: HTTP 404 Not Found` instead of returning an error page as content.
- Converts HTML to Markdown with the ported Studio pipeline: `<article>`/`<main>` scoping,
  hidden-element stripping, header link-density stripping, boilerplate removal, and page metadata
  (`Title:`, `Author:`, `Date:`, `Site:`).
- Adds a `URL:` line only when a redirect lands on a different final URL, so the real address of a
  redirected page stays visible.
- Local files are read directly (`file://` URLs, absolute paths, `~/`, `./`): HTML is converted,
  text is returned raw, local PDFs are extracted with MuPDF, binary files are rejected. Lightpanda
  itself does not support `file://`, so this is the only non-browser read path.
- Results are cached for 1 hour (128 entries, 128 MiB); a stale entry from the last 24 hours is
  served when a render fails. The cache is never used for blocked URLs or local files.
- Remote PDFs are the one direct-network exception. When a URL looks like a PDF (`.pdf`, `/pdf/`,
  or `format=pdf`) or Lightpanda reports `application/pdf`, `web_fetch` downloads it with a
  DNS-pinned, policy-checked, redirect-validated direct request and extracts it with MuPDF. The
  downloader has no page or byte cap, handles gzip/deflate/brotli, and sends a normal browser
  User-Agent. Set `webFetch.allowRemotePdf: false` to disable the exception; PDFs then report
  `(PDF content cannot be read by the local renderer)` again. The PDF downloader uses a direct
  connection and does not apply proxy environment variables.
- There is no character or page cap on `web_fetch` output. HTML, local files, and PDFs are returned in
  full; the tool does not truncate them. Only `web_search` has a result-count limit (`maxResults`).

## Local and private access

Private/loopback/link-local targets are allowed by default, so `http://localhost:3000` and LAN hosts
work. Lightpanda blocks unsafe ports (for example port 1) and `file://`; local files still work
through the fs path. Set `webFetch.allowPrivateAddresses: false` to pass
`--block-private-networks` to Lightpanda and restore the SSRF guard; the direct PDF downloader then
validates every resolved address with the same guard. Set `webFetch.allowLocalFiles: false` to refuse
local paths.

## Proxies

`HTTPS_PROXY`, `HTTP_PROXY`, and `ALL_PROXY` are honored when they name an **HTTP(S)** proxy: the
URL is passed to Lightpanda's `--http-proxy`. `NO_PROXY` exclusions are applied before launching.
SOCKS5 proxies (including Tor) are not supported by this fork, because Lightpanda's proxy flag is
HTTP-only. The direct PDF downloader is an exception to this proxy handling: it connects directly and
does not read proxy environment variables.

## Configuration

Settings live in `~/.pi/agent/settings.json` or `.pi/settings.json` (project overrides global).

```json
{
  "piLightpanda": {
    "maxResults": 5,
    "timeoutMs": 60000,
    "allowPrivateAddresses": true,
    "allowLocalFiles": true,
    "allowRemotePdf": true
  },
  "webFetch": {
    "timeoutMs": 60000,
    "allowPrivateAddresses": true,
    "allowLocalFiles": true,
    "allowRemotePdf": true
  },
  "webSearch": {
    "timeoutMs": 300000,
    "engines": ["brave", "yep"],
    "engineWeights": { "brave": 1, "yep": 1 },
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
| `piLightpanda.timeoutMs` / `webFetch.timeoutMs` | `60000` | Default `timeoutMs` for `web_fetch` when the tool param is absent (>= 1000) |
| `piLightpanda.searchTimeoutMs` / `webSearch.timeoutMs` | `300000` | Default `timeoutMs` for a `web_search` sweep (>= 1000) |
| `piLightpanda.allowPrivateAddresses` / `webFetch.allowPrivateAddresses` | `true` | Set `false` to pass `--block-private-networks` and refuse localhost/LAN targets |
| `piLightpanda.allowLocalFiles` / `webFetch.allowLocalFiles` | `true` | Set `false` to refuse `file://`, absolute, `~/`, and `./` paths |
| `piLightpanda.allowRemotePdf` / `webFetch.allowRemotePdf` | `true` | Set `false` to disable the direct PDF downloader and keep Lightpanda as the only network transport |
| `webSearch.engines` / `piLightpanda.engines` | `["brave","yep"]` | Enabled engines; unknown names are ignored, an empty match falls back to defaults |
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
| Engines refused the burst | `Search failed: brave (Failed to fetch URL: HTTP 429 Too Many Requests), ecosia (Failed to render URL: the page served a bot challenge instead of content).` | Retry later, space the queries out, or enable another engine with `/search-config`. |
| No local renderer | `Search failed: the local renderer is not installed or is disabled.` | Run `bash scripts/install-lightpanda.sh`, set `PI_LIGHTPANDA_BIN` or `webRender.lightpandaPath`, or re-enable `webRender.lightpandaEnabled`. |
| No results | `No results found.` | Rephrase, or enable another engine. |
| Policy filtered everything | `No results found within the website access limits.` | Widen `websitePolicy`. |
| Blocked URL | `Blocked: ...` | Respect it. |
| Missing renderer | `(Lightpanda is not installed; run bash scripts/install-lightpanda.sh to enable web_fetch)` | Install Lightpanda or set `PI_LIGHTPANDA_BIN`. |
| Local render failure | `Failed to render URL: Lightpanda exited with code N.` | Check the binary by hand. |
| Bot challenge | `Failed to render URL: the page served a bot challenge instead of content.` | Hard anti-bot walls cannot be bypassed by Lightpanda's honest user agent. |
| HTTP failure | `Failed to fetch URL: HTTP 404 Not Found` | Fix the URL. |
| Remote PDF disabled | `(PDF content cannot be read by the local renderer)` | Set `webFetch.allowRemotePdf: true`, or use a local PDF. |
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
a real Lightpanda binary and skips itself unless `PI_LIGHTPANDA_E2E=1` is set; it also exercises the
direct PDF downloader. Its search assertion skips itself, printing the reason, when no engine answers
from the runner's network. CI runs both on Linux, with the unit suite also on Windows and Node
22.19/24/26.

## License

The ported logic derives from Unsloth Studio
([AGPL-3.0-only](https://github.com/unslothai/unsloth/blob/main/studio/LICENSE.AGPL-3.0)), so this
package is released under the same AGPL-3.0-only license.
