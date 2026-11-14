import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { openSearchConfig } from "./search-config.ts";
import { collapseWhitespace } from "./html-to-md.ts";
import { SEARCH_TIMEOUT_MS, webSearch as defaultWebSearch } from "./web-search.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchPageText as defaultFetchPageText,
} from "./web-fetch.ts";
import {
  loadDefaultEngineWeights,
  loadDefaultEngines,
  loadDefaultFetchSettings,
  loadDefaultMaxPerHost,
  loadLightpandaSettings,
} from "./settings.ts";

function toolCallLine(theme: Theme, name: string, detail: string) {
  const line = theme.fg("toolTitle", theme.bold(name)) + (detail ? ` ${theme.fg("accent", detail)}` : "");
  return { render: (width: number) => [truncateToWidth(line, width)], invalidate: () => {} };
}

function collapsedArg(value: unknown): string {
  return collapseWhitespace(typeof value === "string" ? value : "");
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

async function fetchDefaults(cwd: string | undefined, params: { timeoutMs?: unknown; maxChars?: unknown }) {
  const timeoutParam = positiveNumber(params.timeoutMs);
  const maxCharsParam = positiveNumber(params.maxChars);
  const defaults = await loadDefaultFetchSettings(cwd);
  return {
    timeoutMs: timeoutParam ?? defaults.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    maxChars: maxCharsParam ?? defaults.maxChars,
    allowPrivateAddresses: defaults.allowPrivateAddresses,
    allowLocalFiles: defaults.allowLocalFiles,
  };
}

const WebSearchParams = Type.Object({
  query: Type.Optional(
    Type.String({ description: "The search query" }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      description: "Maximum number of search results to return (default: 5)",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1000,
      description: "Overall timeout in milliseconds for the search or fetch",
    }),
  ),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL of the page to fetch" }),
  maxChars: Type.Optional(
    Type.Number({
      description: "Truncate the returned content to this many characters (default: no limit)",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1000,
      description: "Overall timeout in milliseconds (default: 60000)",
    }),
  ),
});

export interface WebToolsDeps {
  fetchPageText?: typeof defaultFetchPageText;
  webSearch?: typeof defaultWebSearch;
}

export function createWebTools(deps: WebToolsDeps = {}) {
  const webSearch = deps.webSearch ?? defaultWebSearch;
  const fetchPageText = deps.fetchPageText ?? defaultFetchPageText;

  return {
    webSearchTool: defineTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web and return snippets for the top results. Every engine page is rendered by the " +
        "local Lightpanda browser; no search API or third-party rendering service is used. " +
        "Use web_fetch to read a page found in the results.",
      promptSnippet: "Search the web and return snippets",
      promptGuidelines: [
        "Web tool order: web_search to discover, then web_fetch to read a page.",
      ],
      parameters: WebSearchParams,
      renderCall(args, theme) {
        const query = collapsedArg(args.query);
        return toolCallLine(theme, "web_search", query ? `"${query}"` : "");
      },
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: "Searching the web..." }], details: {} });
        const cwd = (_ctx as ExtensionContext | undefined)?.cwd;
        const timeoutParam = positiveNumber(params.timeoutMs);
        const [fetchSettings, engines, engineWeights, maxPerHost, lightpanda] = await Promise.all([
          loadDefaultFetchSettings(cwd),
          loadDefaultEngines(cwd),
          loadDefaultEngineWeights(cwd),
          loadDefaultMaxPerHost(cwd),
          loadLightpandaSettings(cwd),
        ]);
        const text = await webSearch(params.query, {
          signal: signal ?? undefined,
          timeoutMs: timeoutParam ?? fetchSettings.timeoutMs ?? SEARCH_TIMEOUT_MS,
          maxResults: positiveNumber(params.maxResults),
          cwd,
          engines,
          engineWeights,
          maxPerHost,
          allowPrivateAddresses: fetchSettings.allowPrivateAddresses,
          settings: lightpanda,
        });
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
    webFetchTool: defineTool({
      name: "web_fetch",
      label: "Web Fetch",
      description:
        "Fetch a URL and return its readable text. Pages are rendered by the locally installed " +
        "Lightpanda browser, so JavaScript-heavy pages are rendered too; nothing is sent to a " +
        "third-party rendering service. HTML is converted to Markdown using a main-content heuristic: " +
        "article/main scoping plus hidden-element and boilerplate stripping. Local files (file:// URLs, " +
        "absolute, ~/ or ./ paths, including PDFs) are read directly. Remote PDFs cannot be read by the " +
        "local renderer. The result is cached and truncated with maxChars when given.",
      promptGuidelines: [
        "web_fetch renders pages locally with Lightpanda; it never calls a third-party rendering service.",
      ],
      promptSnippet: "Fetch a web page and return readable text content",
      parameters: WebFetchParams,
      renderCall(args, theme) {
        return toolCallLine(theme, "web_fetch", collapsedArg(args.url));
      },
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: {} });
        const cwd = (_ctx as ExtensionContext | undefined)?.cwd;
        const [defaults, lightpanda] = await Promise.all([
          fetchDefaults(cwd, params),
          loadLightpandaSettings(cwd),
        ]);
        const text = await fetchPageText(params.url, {
          timeoutMs: defaults.timeoutMs,
          signal: signal ?? undefined,
          maxChars: defaults.maxChars,
          allowPrivateAddresses: defaults.allowPrivateAddresses,
          allowLocalFiles: defaults.allowLocalFiles,
          settings: lightpanda,
        });
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
  };
}

export default function (pi: ExtensionAPI) {
  const { webSearchTool, webFetchTool } = createWebTools();
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
  pi.registerCommand("search-config", {
    description: "Configure web_search: enable or disable the Lightpanda-rendered engines",
    handler: async (_args, ctx) => {
      await openSearchConfig(ctx);
    },
  });
}
