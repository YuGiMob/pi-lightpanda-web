import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAllOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { ClientRequest } from "node:http";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { extractPdfText } from "./pdf.ts";
import {
  checkUrlAccess,
  isPublicIp,
  stripIpv6Brackets,
  type WebsitePolicy,
} from "./web-access.ts";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_REQUESTS = 5;
const MAX_DNS_ATTEMPTS = 2;
const DNS_RETRY_BACKOFF_MS = 250;
const PDF_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PDF_MAGIC = Buffer.from("%PDF-");
const TRUNCATED_BODY_NOTICE = "\n\n... (page truncated at the download limit)";
const CANCELLED_MESSAGE = "Failed to fetch URL: cancelled.";
const TIMEOUT_MESSAGE = "Failed to fetch URL: timed out.";
const TRANSIENT_DNS_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

class PdfCancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

class PdfTimeoutError extends Error {
  constructor() {
    super("timed out");
  }
}

export interface PdfResolvedHost {
  ok: boolean;
  reason: string;
  ip: string;
  family: number;
  alternates?: { ip: string; family: number }[];
}

export interface PdfHopOptions {
  url: URL;
  pinnedIp: string;
  family: number;
  headers: Record<string, string>;
  maxBytes: number;
  inactivityMs: number;
  deadlineMs: number;
  nowMs?: () => number;
  signal?: AbortSignal;
}

export interface PdfHopResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
  encoding: string;
}

export interface PdfFetchSeams {
  resolve?: (hostname: string, signal?: AbortSignal, allowPrivateAddresses?: boolean) => Promise<PdfResolvedHost>;
  request?: (options: PdfHopOptions) => Promise<PdfHopResponse>;
}

export interface PdfFetchOptions {
  timeoutMs?: number;
  deadlineMs?: number;
  nowMs?: () => number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  allowPrivateAddresses?: boolean;
  maxPdfBytes?: number;
  seams?: PdfFetchSeams;
}

export type PdfFetchOutcome = { text: string } | { error: string } | null;

function isTransientDnsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && TRANSIENT_DNS_ERROR_CODES.has(code);
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function resolveAndValidateHost(
  hostname: string,
  signal?: AbortSignal,
  allowPrivateAddresses = true,
): Promise<PdfResolvedHost> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_DNS_ATTEMPTS; attempt++) {
    if (signal?.aborted) break;
    if (attempt > 0) {
      await sleepAbortable(DNS_RETRY_BACKOFF_MS, signal);
      if (signal?.aborted) break;
    }
    try {
      const lookupOptions: LookupAllOptions & { signal?: AbortSignal } = {
        all: true,
        verbatim: true,
        signal,
      };
      const addresses = await dnsLookup(hostname, lookupOptions);
      if (!addresses.length) {
        return { ok: false, reason: `Failed to resolve host: no addresses for '${hostname}'`, ip: "", family: 0 };
      }
      for (const entry of addresses) {
        if (!allowPrivateAddresses && !isPublicIp(entry.address)) {
          return {
            ok: false,
            reason: `Blocked: refusing to fetch the non-public address ${entry.address}.`,
            ip: "",
            family: 0,
          };
        }
      }
      addresses.sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1));
      const first = addresses[0];
      return {
        ok: true,
        reason: "",
        ip: first.address,
        family: first.family,
        alternates: addresses.slice(1).map((entry) => ({ ip: entry.address, family: entry.family })),
      };
    } catch (err) {
      lastError = err;
      if (!isTransientDnsError(err)) break;
    }
  }
  return {
    ok: false,
    reason: lastError === null ? "Failed to resolve host: cancelled" : `Failed to resolve host: ${lastError}`,
    ip: "",
    family: 0,
  };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function statusError(status: number): string {
  const reason = http.STATUS_CODES[status] ?? "";
  return `Failed to fetch URL: HTTP ${status}${reason ? ` ${reason}` : ""}`;
}

export function looksLikePdfUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const path = url.pathname.toLowerCase();
  if (path.endsWith(".pdf") || /\/pdf\//.test(path)) return true;
  for (const value of url.searchParams.values()) {
    if (value.toLowerCase().endsWith(".pdf")) return true;
  }
  return (url.searchParams.get("format") ?? "").toLowerCase() === "pdf";
}

function hasPdfMagic(data: Buffer): boolean {
  let start = 0;
  while (start < data.length && [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].includes(data[start])) start++;
  for (const bom of [
    Buffer.from([0xff, 0xfe, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0xfe, 0xff]),
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0xfe, 0xff]),
    Buffer.from([0xef, 0xbb, 0xbf]),
  ]) {
    if (data.subarray(start).length >= bom.length && data.subarray(start, start + bom.length).equals(bom)) {
      start += bom.length;
      while (start < data.length && [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].includes(data[start])) start++;
      break;
    }
  }
  const magic = data.subarray(start);
  return magic.length >= PDF_MAGIC.length && magic.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  if (!encoding) return body;
  try {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return gunzipSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    }
    if (encoding === "deflate") {
      try {
        return inflateSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
      } catch {
        return inflateRawSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
      }
    }
    if (encoding === "br") {
      return brotliDecompressSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    }
  } catch {
    return body;
  }
  return body;
}

function requestPdfHop(options: PdfHopOptions): Promise<PdfHopResponse> {
  return new Promise((resolve, reject) => {
    const url = options.url;
    const transport = url.protocol === "https:" ? https : http;
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const hostname = stripIpv6Brackets(url.hostname);
    const hostHeader = hostname.includes(":")
      ? `[${hostname}]${url.port ? `:${url.port}` : ""}`
      : hostname + (url.port ? `:${url.port}` : "");
    const headers: Record<string, string> = {
      "User-Agent": PDF_USER_AGENT,
      Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
      "Accept-Encoding": "identity",
      Host: hostHeader,
      ...options.headers,
    };
    const requestOptions: https.RequestOptions = {
      method: "GET",
      host: hostname,
      port,
      path: url.pathname + url.search,
      headers,
      timeout: options.inactivityMs,
    };
    if (url.protocol === "https:" && !isIP(hostname)) requestOptions.servername = hostname;
    requestOptions.lookup = ((_hostname: string, _lookupOptions: unknown, _callback: unknown) => {
      const done = (typeof _lookupOptions === "function" ? _lookupOptions : _callback) as (
        err: unknown,
        address: unknown,
        family?: unknown,
      ) => void;
      if ((_lookupOptions as { all?: boolean } | undefined)?.all) {
        done(null, [{ address: options.pinnedIp, family: options.family }]);
      } else {
        done(null, options.pinnedIp, options.family);
      }
    }) as typeof requestOptions.lookup;
    let settled = false;
    let requestRef: ClientRequest | null = null;
    let responseRef: IncomingMessage | null = null;
    const now = options.nowMs ?? Date.now;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => {
      responseRef?.destroy();
      requestRef?.destroy();
      finish(() => reject(new PdfCancelledError()));
    };
    const deadlineTimer = setTimeout(() => {
      responseRef?.destroy();
      requestRef?.destroy();
      finish(() => reject(new PdfTimeoutError()));
    }, Math.max(1, options.deadlineMs - now()));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    requestRef = transport.request(requestOptions, (response: IncomingMessage) => {
      responseRef = response;
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      const encoding = String(response.headers["content-encoding"] ?? "")
        .split(",", 1)[0]
        .trim()
        .toLowerCase();
      const finishResponse = () =>
        finish(() =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
            truncated,
            encoding,
          }),
        );
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (total + chunk.length > options.maxBytes) {
          const take = chunk.subarray(0, options.maxBytes - total);
          chunks.push(take);
          total += take.length;
          truncated = true;
          finishResponse();
          response.destroy();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      response.on("end", () => finishResponse());
      response.on("aborted", () => finish(() => reject(new Error("response aborted"))));
      response.on("close", () => {
        if (!response.complete) finish(() => reject(new Error("response closed")));
      });
      response.on("error", (err) => finish(() => reject(err)));
    });
    requestRef.on("timeout", () => {
      responseRef?.destroy();
      requestRef?.destroy();
      finish(() => reject(new PdfTimeoutError()));
    });
    requestRef.on("error", (err) => finish(() => reject(err)));
    requestRef.end();
  });
}

export async function fetchRemotePdf(
  url: string,
  options: PdfFetchOptions = {},
): Promise<PdfFetchOutcome> {
  const now = options.nowMs ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = options.deadlineMs ?? now() + timeoutMs;
  const signal = options.signal;
  const policy = options.websitePolicy ?? null;
  const allowPrivateAddresses = options.allowPrivateAddresses ?? true;
  const maxPdfBytes = options.maxPdfBytes ?? MAX_PDF_BYTES;
  const resolve = options.seams?.resolve ?? resolveAndValidateHost;
  const request = options.seams?.request ?? requestPdfHop;
  let currentUrl = url;
  for (let hop = 0; hop < MAX_REQUESTS; hop++) {
    if (signal?.aborted) return { error: CANCELLED_MESSAGE };
    if (now() >= deadline) return { error: TIMEOUT_MESSAGE };
    const access = checkUrlAccess(currentUrl, policy);
    if (!access[0]) return { error: access[1] };
    const hostname = access[2];
    const resolved = await resolve(hostname, signal, allowPrivateAddresses);
    if (!resolved.ok) return { error: resolved.reason };
    const candidates = [{ ip: resolved.ip, family: resolved.family }, ...(resolved.alternates ?? [])];
    let response: PdfHopResponse | null = null;
    let failure: unknown = null;
    for (const candidate of candidates) {
      try {
        response = await request({
          url: new URL(currentUrl),
          pinnedIp: candidate.ip,
          family: candidate.family,
          headers: {},
          maxBytes: maxPdfBytes,
          inactivityMs: Math.max(1, deadline - now()),
          deadlineMs: deadline,
          nowMs: now,
          signal,
        });
        break;
      } catch (err) {
        if (err instanceof PdfCancelledError) return { error: CANCELLED_MESSAGE };
        if (err instanceof PdfTimeoutError) return { error: TIMEOUT_MESSAGE };
        if (signal?.aborted) return { error: CANCELLED_MESSAGE };
        if (now() >= deadline) return { error: TIMEOUT_MESSAGE };
        failure = err;
      }
    }
    if (!response) {
      return {
        error: `Failed to fetch URL: ${failure instanceof Error ? failure.message : String(failure ?? "no transport could reach the target")}`,
      };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      if (!location) return { error: "Failed to fetch URL: the redirect is missing a Location header." };
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return { error: "Failed to fetch URL: the redirect has an invalid Location." };
      }
      continue;
    }
    if (response.status !== 200) return { error: statusError(response.status) };
    const contentType = headerValue(response.headers, "content-type").toLowerCase();
    const declaredPdf = contentType.includes("pdf");
    const declaredLength = Number(headerValue(response.headers, "content-length"));
    if (declaredPdf && !response.encoding && Number.isFinite(declaredLength) && declaredLength > maxPdfBytes) {
      return { error: "(PDF content exceeds the download limit; not readable as text)" };
    }
    const decoded = decodeBody(response.body, response.encoding);
    const truncated = response.truncated || decoded.length > maxPdfBytes;
    const body = decoded.length > maxPdfBytes ? decoded.subarray(0, maxPdfBytes) : decoded;
    if (!declaredPdf && !hasPdfMagic(body)) return null;
    let pdfText: string;
    try {
      pdfText = await extractPdfText(body);
    } catch {
      return {
        error: truncated
          ? "(PDF content could not be read as text; the download was truncated at the download limit)"
          : "(PDF content could not be read as text)",
      };
    }
    if (!pdfText) return { error: "(PDF contains no extractable text)" };
    return { text: truncated ? pdfText + TRUNCATED_BODY_NOTICE : pdfText };
  }
  return { error: "Failed to fetch URL: too many redirects." };
}
