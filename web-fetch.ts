import { getCached, isFresh, setCached, staleNotice } from "./cache.ts";
import {
  renderPageWithLightpanda,
  type LightpandaRenderOptions,
  type LightpandaSettings,
  type LightpandaSpawn,
} from "./lightpanda.ts";
import { parseLocalPath, readLocalFile } from "./local-file.ts";
import { truncatePageText } from "./page-text.ts";
import { normalizeUrlScheme, type WebsitePolicy } from "./web-access.ts";

export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const LIGHTPANDA_MISSING =
  "(Lightpanda is not installed; run bash scripts/install-lightpanda.sh to enable web_fetch)";

export interface FetchPageOptions {
  timeoutMs?: number;
  deadlineMs?: number;
  nowMs?: () => number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  maxChars?: number;
  maxBytes?: number;
  maxPdfBytes?: number;
  allowPrivateAddresses?: boolean;
  allowLocalFiles?: boolean;
  useCache?: boolean;
  settings?: LightpandaSettings | null;
  spawn?: LightpandaSpawn;
  binaryPath?: string | null;
  command?: string[] | null;
}

function failed(text: string): boolean {
  return (
    text.startsWith("Failed to ") ||
    text.startsWith("(PDF content") ||
    text.startsWith("(binary content") ||
    text === "(page returned no readable text)"
  );
}

async function cachedFallback(url: string, now: () => number): Promise<string | null> {
  try {
    const cached = await getCached(url);
    if (!cached) return null;
    const notice = isFresh(cached, now())
      ? "\n\n*Served from cache — the local renderer failed*"
      : staleNotice(cached);
    return cached.body + notice;
  } catch {
    return null;
  }
}

export async function fetchPageText(url: string, options: FetchPageOptions = {}): Promise<string> {
  const now = options.nowMs ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const remaining = options.deadlineMs !== undefined
    ? Math.max(1, options.deadlineMs - now())
    : timeoutMs;
  if (options.allowLocalFiles !== false) {
    const localPath = parseLocalPath(url);
    if (localPath !== null) {
      if (!localPath) return "Failed to read file: invalid file URL.";
      return readLocalFile(localPath, {
        signal: options.signal,
        maxChars: options.maxChars,
        maxBytes: options.maxBytes,
        maxPdfBytes: options.maxPdfBytes,
      });
    }
  }
  const normalized = normalizeUrlScheme(url);
  const renderOptions: LightpandaRenderOptions = {
    timeoutMs: remaining,
    signal: options.signal,
    websitePolicy: options.websitePolicy ?? null,
    settings: options.settings ?? null,
    allowPrivateAddresses: options.allowPrivateAddresses,
    spawn: options.spawn,
    binaryPath: options.binaryPath,
    command: options.command,
  };
  const useCache = options.useCache ?? options.spawn === undefined;
  const text = await renderPageWithLightpanda(normalized, renderOptions);
  if (text === null) {
    if (useCache) {
      const cached = await cachedFallback(normalized, now);
      if (cached !== null) return truncatePageText(cached, options.maxChars);
    }
    return LIGHTPANDA_MISSING;
  }
  if (failed(text)) {
    if (useCache && !text.startsWith("Blocked:")) {
      const cached = await cachedFallback(normalized, now);
      if (cached !== null) return truncatePageText(cached, options.maxChars);
    }
    return text;
  }
  if (useCache) await setCached(normalized, text, "text/markdown");
  return truncatePageText(text, options.maxChars);
}

export { parseLocalPath, truncatePageText };
