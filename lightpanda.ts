import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_CODES } from "node:http";
import { pagePrefixedMarkdown, pageVisibleText, visibleChars } from "./html-to-md.ts";
import {
  checkUrlAccess,
  MAX_SIGNAL_TIMEOUT_MS,
  normalizeUrlScheme,
  type WebsitePolicy,
} from "./web-access.ts";
import { proxyForUrl } from "./proxy.ts";

const DEFAULT_BINARY = "lightpanda";
const DEFAULT_WAIT_UNTIL = "networkidle";
const DEFAULT_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const METADATA_LINE_RE = /^(?:Title|Author|Date|Site|URL|Rendered via): /;
const PROVENANCE = "Rendered via Lightpanda (local browser; nothing sent to a third party).";
const CANCELLED_MESSAGE = "Failed to render URL: cancelled.";
const TIMED_OUT_MESSAGE = "Failed to render URL: timed out.";
const NO_TEXT_MESSAGE = "(page returned no readable text)";
export const PDF_MESSAGE = "(PDF content cannot be read by the local renderer)";
const CHALLENGE_MESSAGE = "Failed to render URL: the page served a bot challenge instead of content.";
const INTERSTITIAL_MAX_PROSE_CHARS = 4000;
const INTERSTITIAL_MARKERS = [
  "just a moment",
  "attention required",
  "you have been blocked",
  "enable javascript and cookies to continue",
  "checking if the site connection is secure",
  "access denied",
  "please enable cookies",
  "cf-error-details",
  "are you a robot",
  "captcha",
  "anomaly",
  "anubis",
  "unfortunately, bots use",
  "complete the following challenge",
  "select all squares",
  "challenge required",
];

export type LightpandaDump = "html" | "markdown";
export type LightpandaWaitUntil = "networkidle" | "load" | "domcontentloaded" | "done";

export interface LightpandaSettings {
  enabled: boolean;
  binaryPath: string | null;
  command: string[] | null;
}

interface LightpandaProcess {
  stdout: AsyncIterable<Buffer> | null;
  stderr: AsyncIterable<Buffer> | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: string): unknown;
}

export type LightpandaSpawn = (
  binary: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "pipe"] },
) => LightpandaProcess;

export interface LightpandaRenderOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  settings?: LightpandaSettings | null;
  binaryPath?: string | null;
  command?: string[] | null;
  dump?: LightpandaDump;
  waitUntil?: LightpandaWaitUntil;
  allowPrivateAddresses?: boolean;
  spawn?: LightpandaSpawn;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  missing: boolean;
}

interface LightpandaJson {
  url?: string;
  http_status?: number;
  headers?: { name?: string; value?: string }[];
  content?: string;
  error?: string | null;
  bot_challenge?: string | null;
}

type DumpOutcome =
  | { ok: true; raw: string; contentType: string; finalUrl: string; status: number }
  | { ok: false; message: string }
  | null;

interface ProbeEntry {
  probe: Promise<boolean>;
  verdict: boolean | null;
  checkedAt: number;
}

const NEGATIVE_PROBE_TTL_MS = 10_000;
const availability = new Map<string, ProbeEntry>();
let installPromise: Promise<boolean> | null = null;

function binaryAvailable(launch: string[], spawn: LightpandaSpawn): Promise<boolean> {
  const key = launch.join(" ");
  const cached = availability.get(key);
  if (cached) {
    if (cached.verdict !== false || Date.now() - cached.checkedAt < NEGATIVE_PROBE_TTL_MS) {
      return cached.probe;
    }
  }
  const entry: ProbeEntry = { probe: Promise.resolve(false), verdict: null, checkedAt: 0 };
  entry.probe = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.verdict = value;
      entry.checkedAt = Date.now();
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(false);
    }, PROBE_TIMEOUT_MS);
    let child: LightpandaProcess;
    try {
      child = spawn(launch[0], [...launch.slice(1), "version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
  availability.set(key, entry);
  return entry.probe;
}

function runLightpanda(
  launch: string[],
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; spawn: LightpandaSpawn },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const state = {
      code: null as number | null,
      stdout: [] as Buffer[],
      stderr: [] as string[],
      timedOut: false,
      cancelled: false,
      missing: false,
    };
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") state.missing = true;
      const stdout = Buffer.concat(state.stdout).toString("utf-8");
      resolve({ ...state, stdout, stderr: state.stderr.join("") });
    };
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const onAbort = () => {
      state.cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      state.timedOut = true;
      kill();
    }, options.timeoutMs);
    let child: LightpandaProcess;
    try {
      child = options.spawn(launch[0], [...launch.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const collect = async (stream: AsyncIterable<Buffer> | null, push: (chunk: Buffer) => void): Promise<void> => {
      if (!stream) return;
      try {
        for await (const chunk of stream) push(chunk);
      } catch {}
    };
    const stdoutDone = collect(child.stdout, (chunk) => state.stdout.push(chunk));
    const stderrDone = collect(child.stderr, (chunk) => state.stderr.push(chunk.toString("utf-8")));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      state.code = code;
      void Promise.all([stdoutDone, stderrDone]).then(() => finish(null));
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function headerValue(headers: LightpandaJson["headers"], name: string): string {
  for (const header of headers ?? []) {
    if ((header.name ?? "").toLowerCase() === name) return header.value ?? "";
  }
  return "";
}

function failureFor(result: RunResult): string | null {
  if (result.missing) return null;
  if (result.cancelled) return CANCELLED_MESSAGE;
  if (result.timedOut) return TIMED_OUT_MESSAGE;
  return null;
}

function failedDumpMessage(stdout: string): string | null {
  let data: LightpandaJson;
  try {
    data = JSON.parse(stdout) as LightpandaJson;
  } catch {
    return null;
  }
  if (data.bot_challenge || /bot.?challenge/i.test(String(data.error ?? ""))) {
    return CHALLENGE_MESSAGE;
  }
  const status = Number(data.http_status ?? 0);
  return status >= 400 ? httpError(status) : null;
}

function httpError(status: number): string {
  const reason = STATUS_CODES[status] ?? "";
  return `Failed to fetch URL: HTTP ${status}${reason ? ` ${reason}` : ""}`;
}

function looksLikeMarkup(content: string, contentType: string): boolean {
  if (contentType.includes("html") || contentType.includes("xml")) return true;
  return content.trimStart().startsWith("<");
}

function looksLikeInterstitial(text: string): boolean {
  if (visibleChars(text) > INTERSTITIAL_MAX_PROSE_CHARS) return false;
  const lowered = text.toLowerCase();
  return INTERSTITIAL_MARKERS.some((marker) => lowered.includes(marker));
}

function withProvenance(prefixed: string, url: string): string {
  const lines = prefixed.split("\n");
  let index = 0;
  while (index < lines.length && METADATA_LINE_RE.test(lines[index])) index++;
  const header = [`URL: ${url}`, PROVENANCE];
  if (index === 0) return `${header.join("\n")}\n\n${prefixed}`;
  return [...lines.slice(0, index), ...header, ...lines.slice(index)].join("\n");
}

function bodyChars(text: string): number {
  const body = text
    .split("\n")
    .filter((line) => !METADATA_LINE_RE.test(line))
    .join("\n");
  return visibleChars(body);
}

function installedLauncher(): string | null {
  let dataHome = process.env.XDG_DATA_HOME?.trim();
  if (!dataHome) {
    try {
      const home = homedir();
      if (!home) return null;
      dataHome = join(home, ".local", "share");
    } catch {
      return null;
    }
  }
  const dir = join(dataHome, "pi-lightpanda-web", "lightpanda");
  for (const name of ["lightpanda-run", "lightpanda"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function lightpandaBinary(options: LightpandaRenderOptions = {}): string {
  return (
    options.binaryPath ??
    options.settings?.binaryPath ??
    process.env.PI_LIGHTPANDA_BIN?.trim() ??
    installedLauncher() ??
    DEFAULT_BINARY
  );
}

export function lightpandaLaunch(options: LightpandaRenderOptions = {}): string[] {
  const command = options.command ?? options.settings?.command ?? null;
  if (command && command.length) return command;
  return [lightpandaBinary(options)];
}

function runInstaller(): Promise<boolean> {
  const script = fileURLToPath(new URL("./scripts/install-lightpanda.sh", import.meta.url));
  if (!existsSync(script)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawnProcess> | null = null;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {}
      finish(false);
    }, 10 * 60 * 1000);
    try {
      child = spawnProcess("bash", [script, "--no-configure"], { stdio: "ignore" });
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.unref();
  });
}

export interface EnsureLightpandaOptions extends LightpandaRenderOptions {
  installer?: () => Promise<boolean>;
}

function awaitInstall(signal?: AbortSignal): Promise<boolean> {
  const pending = installPromise;
  if (!pending) return Promise.resolve(false);
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const onAbort = () => finish(() => resolve(false));
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function ensureLightpandaInstalled(options: EnsureLightpandaOptions = {}): Promise<boolean> {
  if (options.settings && options.settings.enabled === false) return false;
  const spawn = options.spawn ?? (spawnProcess as unknown as LightpandaSpawn);
  if (options.command || options.settings?.command) {
    return binaryAvailable(lightpandaLaunch(options), spawn);
  }
  if (options.binaryPath || options.settings?.binaryPath || process.env.PI_LIGHTPANDA_BIN?.trim()) {
    return binaryAvailable(lightpandaLaunch(options), spawn);
  }
  if (installPromise) return awaitInstall(options.signal);
  if (!options.installer && (process.platform === "win32" || options.spawn)) {
    return binaryAvailable(lightpandaLaunch(options), spawn);
  }
  installPromise = (async () => {
    if (await binaryAvailable(lightpandaLaunch(options), spawn)) return true;
    const install = options.installer ?? runInstaller;
    if (!(await install())) return false;
    availability.clear();
    return binaryAvailable(lightpandaLaunch(options), spawn);
  })().finally(() => {
    installPromise = null;
  });
  return awaitInstall(options.signal);
}

function renderArgs(
  normalized: string,
  options: LightpandaRenderOptions,
  timeoutMs: number,
  dump: LightpandaDump,
): string[] {
  const args = [
    "fetch",
    "--json",
    "--dump",
    dump,
    "--wait-until",
    options.waitUntil ?? DEFAULT_WAIT_UNTIL,
    "--http-timeout",
    String(timeoutMs),
  ];
  if (options.allowPrivateAddresses === false) args.push("--block-private-networks");
  try {
    const proxy = proxyForUrl(new URL(normalized));
    if (proxy) args.push("--http-proxy", proxy);
  } catch {}
  args.push(normalized);
  return args;
}

async function fetchDump(
  url: string,
  options: LightpandaRenderOptions,
  dump: LightpandaDump,
): Promise<DumpOutcome> {
  if (options.settings && options.settings.enabled === false) return null;
  const target = typeof url === "string" ? url.trim() : "";
  const policy = options.websitePolicy ?? null;
  if (!target) return { ok: false, message: checkUrlAccess("", policy)[1] };
  const normalized = normalizeUrlScheme(target);
  const access = checkUrlAccess(normalized, policy);
  if (!access[0]) return { ok: false, message: access[1] };
  const spawn = options.spawn ?? (spawnProcess as unknown as LightpandaSpawn);
  if (!(await ensureLightpandaInstalled({ ...options, spawn }))) {
    return options.signal?.aborted ? { ok: false, message: CANCELLED_MESSAGE } : null;
  }
  const launch = lightpandaLaunch(options);
  const timeoutMs = Math.min(
    MAX_SIGNAL_TIMEOUT_MS,
    Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const result = await runLightpanda(launch, renderArgs(normalized, options, timeoutMs, dump), {
    timeoutMs,
    signal: options.signal,
    spawn,
  });
  if (result.missing) return null;
  const failure = failureFor(result);
  if (failure) return { ok: false, message: failure };
  if (result.code !== 0) {
    const known = failedDumpMessage(result.stdout);
    if (known) return { ok: false, message: known };
    const detail = result.stderr.trim().split("\n").at(-1) ?? "";
    return {
      ok: false,
      message: `Failed to render URL: Lightpanda exited with code ${result.code ?? "unknown"}${detail ? ` (${detail.slice(0, 200)})` : ""}.`,
    };
  }
  let data: LightpandaJson;
  try {
    data = JSON.parse(result.stdout) as LightpandaJson;
  } catch {
    return { ok: false, message: "Failed to render URL: the local renderer returned unreadable output." };
  }
  if (data.error) {
    return { ok: false, message: `Failed to render URL: ${data.error}.` };
  }
  const status = Number(data.http_status ?? 0);
  if (status >= 400) return { ok: false, message: httpError(status) };
  const contentType = headerValue(data.headers, "content-type").toLowerCase();
  const finalUrl = data.url || normalized;
  const finalAccess = checkUrlAccess(finalUrl, policy);
  if (!finalAccess[0]) return { ok: false, message: finalAccess[1] };
  if (contentType.includes("pdf")) return { ok: false, message: PDF_MESSAGE };
  const content = data.content ?? "";
  if (!content.trim()) return { ok: false, message: NO_TEXT_MESSAGE };
  return { ok: true, raw: content, contentType, finalUrl, status };
}

export async function renderPageWithLightpanda(
  url: string,
  options: LightpandaRenderOptions = {},
): Promise<string | null> {
  const dump = options.dump ?? "html";
  const fetched = await fetchDump(url, options, dump);
  if (fetched === null) return null;
  if (!fetched.ok) return fetched.message;
  const rendered =
    dump === "html" && looksLikeMarkup(fetched.raw, fetched.contentType)
      ? pagePrefixedMarkdown(fetched.raw)
      : fetched.raw.trim();
  if (bodyChars(rendered) === 0) return NO_TEXT_MESSAGE;
  if (looksLikeInterstitial(rendered)) return CHALLENGE_MESSAGE;
  return withProvenance(rendered, fetched.finalUrl);
}

export type HtmlRenderOutcome = { ok: true; html: string } | { ok: false; message: string } | null;

export async function renderPageHtmlOutcome(
  url: string,
  options: LightpandaRenderOptions = {},
): Promise<HtmlRenderOutcome> {
  const fetched = await fetchDump(url, options, "html");
  if (fetched === null) return null;
  if (!fetched.ok) return { ok: false, message: fetched.message };
  const html = fetched.raw.trim();
  if (!html) return { ok: false, message: NO_TEXT_MESSAGE };
  const text = looksLikeMarkup(html, fetched.contentType) ? pageVisibleText(html) : html;
  if (looksLikeInterstitial(text)) return { ok: false, message: CHALLENGE_MESSAGE };
  return { ok: true, html };
}

export async function renderPageHtml(
  url: string,
  options: LightpandaRenderOptions = {},
): Promise<string | null> {
  const outcome = await renderPageHtmlOutcome(url, options);
  return outcome !== null && outcome.ok ? outcome.html : null;
}
