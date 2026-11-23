import { checkUrlAccess, scopeSearchQuery, type WebsitePolicy } from "./web-access.ts";
import { collapseWhitespace } from "./html-to-md.ts";
import {
  autoTextSearch,
  EmptySweepError,
  SearchCancelled,
  SearchRenderError,
  SearchTimeoutError,
  type SearchEngineOptions,
  type SearchRenderPage,
  type SearchResult,
} from "./engines.ts";
import { renderPageHtmlOutcome, type LightpandaSettings } from "./lightpanda.ts";
import { loadDefaultMaxResults, loadDefaultSearchTimeoutMs, loadLightpandaSettings } from "./settings.ts";

export { EmptySweepError, SearchCancelled, SearchRenderError, SearchTimeoutError } from "./engines.ts";

export const SEARCH_TIMEOUT_MS = 300_000;
const MAX_RESULTS = 5;
const POLICY_OVERFETCH = 4;

export const EMPTY_SEARCH_RESULTS = [
  "No results found.",
  "No results found within the website access limits.",
];

export interface SearchClientOptions extends SearchEngineOptions {
  cwd?: string;
  settings?: LightpandaSettings | null;
}

export type SearchClient = (
  query: string,
  maxResults: number,
  signal?: AbortSignal,
  timeoutMs?: number,
  options?: SearchClientOptions,
) => Promise<SearchResult[]>;

async function configuredRenderPage(
  cwd?: string,
  settings?: LightpandaSettings | null,
): Promise<SearchRenderPage | undefined> {
  const resolved = settings ?? (await loadLightpandaSettings(cwd).catch(() => null));
  if (!resolved?.enabled) return undefined;
  return async (url, options) => {
    const outcome = await renderPageHtmlOutcome(url, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      websitePolicy: options.websitePolicy,
      allowPrivateAddresses: options.allowPrivateAddresses,
      settings: resolved,
    });
    if (outcome === null) return null;
    return outcome.ok ? outcome.html : { error: outcome.message };
  };
}

export async function searchSweep(
  query: string,
  maxResults = MAX_RESULTS,
  signal?: AbortSignal,
  timeoutMs = SEARCH_TIMEOUT_MS,
  options: SearchClientOptions = {},
): Promise<SearchResult[]> {
  if (signal?.aborted) throw new SearchCancelled();
  const renderPage = options.renderPage ?? (await configuredRenderPage(options.cwd, options.settings));
  if (!renderPage) throw new SearchRenderError({}, "the local renderer is not installed or is disabled");
  return autoTextSearch(query, maxResults, timeoutMs, signal, { ...options, renderPage });
}

export interface WebSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  client?: SearchClient;
  cwd?: string;
  engines?: string[];
  engineWeights?: Record<string, number>;
  maxPerHost?: number;
  renderPage?: SearchRenderPage;
  allowPrivateAddresses?: boolean;
  settings?: LightpandaSettings | null;
}

export { loadDefaultMaxResults };

export async function webSearch(
  query: string | undefined,
  options: WebSearchOptions = {},
): Promise<string> {
  const rawMaxResults = options.maxResults ?? (await loadDefaultMaxResults(options.cwd));
  const saneMax = Number.isFinite(rawMaxResults) ? Math.floor(rawMaxResults as number) : MAX_RESULTS;
  const maxResults = Math.min(20, Math.max(1, saneMax));
  const rawTimeout = options.timeoutMs ?? (await loadDefaultSearchTimeoutMs(options.cwd)) ?? SEARCH_TIMEOUT_MS;
  const flooredTimeout = Number.isFinite(rawTimeout) ? Math.floor(rawTimeout as number) : SEARCH_TIMEOUT_MS;
  const timeoutMs = flooredTimeout >= 1 ? flooredTimeout : SEARCH_TIMEOUT_MS;
  const signal = options.signal;
  const policy = options.websitePolicy ?? null;
  const client = options.client ?? searchSweep;

  if (!query || !query.trim()) return "No query provided.";
  if (signal?.aborted) return "Search cancelled.";
  try {
    const effectiveQuery = scopeSearchQuery(query, policy);
    const restricted = Boolean(
      (policy?.allowedDomains?.length ?? 0) > 0 ||
        (policy?.blockedDomains?.length ?? 0) > 0,
    );
    const wanted = restricted ? maxResults * POLICY_OVERFETCH : maxResults;
    const renderPage =
      options.renderPage ?? (await configuredRenderPage(options.cwd, options.settings));
    const results = await client(effectiveQuery, wanted, signal, timeoutMs, {
      policy,
      engines: options.engines,
      engineWeights: options.engineWeights,
      maxPerHost: options.maxPerHost,
      renderPage,
      allowPrivateAddresses: options.allowPrivateAddresses,
      cwd: options.cwd,
      settings: options.settings,
    });
    if (signal?.aborted) return "Search cancelled.";
    if (!results.length) return EMPTY_SEARCH_RESULTS[0];
    const allowed: SearchResult[] = [];
    for (const result of results) {
      if (allowed.length >= maxResults) break;
      const href = String(result.href ?? "").trim();
      if (!href) continue;
      if (!checkUrlAccess(href, policy)[0]) continue;
      allowed.push(result);
    }
    if (!allowed.length) return EMPTY_SEARCH_RESULTS[1];
    return formatSearchResults(allowed);
  } catch (err) {
    if (signal?.aborted) return "Search cancelled.";
    return searchFailureMessage(err, timeoutMs);
  }
}

function stripTrailingPeriods(text: string): string {
  return text.replace(/\.+$/, "");
}

export function searchFailureMessage(exc: unknown, timeoutMs = SEARCH_TIMEOUT_MS): string {
  if (exc instanceof SearchCancelled) return "Search cancelled.";
  if (exc instanceof SearchTimeoutError) {
    const providers = [...((exc as SearchTimeoutError).providers ?? [])].sort();
    if (providers.length) return `Search failed: the search engines (${providers.join(", ")}) did not respond within ${Math.round(timeoutMs / 1000)} seconds.`;
    return `Search failed: the search engines did not respond within ${Math.round(timeoutMs / 1000)} seconds.`;
  }
  if (exc instanceof EmptySweepError || (exc instanceof Error && exc.message.includes("No results found"))) {
    return EMPTY_SEARCH_RESULTS[0];
  }
  if (exc instanceof SearchRenderError) {
    const entries = Object.keys(exc.failures ?? {})
      .sort()
      .map((name) => `${name} (${stripTrailingPeriods(exc.failures[name] ?? "")})`);
    const detail = entries.length ? entries.join(", ") : stripTrailingPeriods(exc.detail || exc.message);
    return `Search failed: ${detail}.`;
  }
  return `Search failed: ${exc instanceof Error ? exc.message : String(exc)}`;
}

export function formatSearchResults(results: SearchResult[]): string {
  const parts = results.map((result) => {
    const title = collapseWhitespace(String(result.title ?? ""));
    const href = collapseWhitespace(String(result.href ?? ""));
    const snippet = collapseWhitespace(String(result.body ?? ""));
    return `Title: ${title}\nURL: ${href}\nSnippet: ${snippet}`;
  });
  const text = parts.join("\n\n---\n\n");
  return (
    text +
    "\n\n---\n\nThese are only short snippets. " +
    "To read a page, call web_fetch with its URL."
  );
}
