import { getCached, isFresh, setCached, staleNotice } from "./cache.ts";
import {
  PDF_MESSAGE,
  renderPageWithLightpanda,
  type LightpandaRenderOptions,
  type LightpandaSettings,
  type LightpandaSpawn,
} from "./lightpanda.ts";
import { fetchRemotePdf, looksLikePdfUrl, type PdfFetchOutcome } from "./pdf-fetch.ts";
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
  allowRemotePdf?: boolean;
  useCache?: boolean;
  settings?: LightpandaSettings | null;
  spawn?: LightpandaSpawn;
  binaryPath?: string | null;
  command?: string[] | null;
  pdfFetcher?: typeof fetchRemotePdf;
}

function failed(text: string): boolean {
  return (
    text.startsWith("Failed to ") ||
    text.startsWith("(PDF ") ||
    text.startsWith("(binary content") ||
    text === "(page returned no readable text)"
  );
}

async function finishPdf(
  outcome: Exclude<PdfFetchOutcome, null>,
  context: { url: string; useCache: boolean; now: () => number; maxChars?: number },
): Promise<string> {
  if ("error" in outcome) {
    if (context.useCache && !outcome.error.startsWith("Blocked:")) {
      const cached = await cachedFallback(context.url, context.now);
      if (cached !== null) return truncatePageText(cached, context.maxChars);
    }
    return outcome.error;
  }
  if (context.useCache) await setCached(context.url, outcome.text, "text/markdown");
  return truncatePageText(outcome.text, context.maxChars);
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
  const allowRemotePdf = options.allowRemotePdf !== false;
  const pdfFetcher = options.pdfFetcher ?? fetchRemotePdf;
  const pdfOptions = {
    timeoutMs: remaining,
    deadlineMs: options.deadlineMs,
    nowMs: now,
    signal: options.signal,
    websitePolicy: options.websitePolicy ?? null,
    allowPrivateAddresses: options.allowPrivateAddresses,
    maxPdfBytes: options.maxPdfBytes,
  };
  const pdfContext = { url: normalized, useCache, now, maxChars: options.maxChars };
  if (allowRemotePdf && looksLikePdfUrl(normalized)) {
    const outcome = await pdfFetcher(normalized, pdfOptions);
    if (outcome !== null) return finishPdf(outcome, pdfContext);
  }
  const text = await renderPageWithLightpanda(normalized, renderOptions);
  if (text === PDF_MESSAGE && allowRemotePdf) {
    const outcome = await pdfFetcher(normalized, pdfOptions);
    if (outcome !== null) return finishPdf(outcome, pdfContext);
  }
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
