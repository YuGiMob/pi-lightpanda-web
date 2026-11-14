import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./agent-dir.ts";

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(file, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function pickNumber(data: Record<string, unknown>, paths: string[][]): number | undefined {
  for (const path of paths) {
    let cur: unknown = data;
    for (const key of path) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[key];
      else {
        cur = undefined;
        break;
      }
    }
    const n = toNumber(cur);
    if (n !== undefined) return n;
  }
  return undefined;
}

function pickBoolean(data: Record<string, unknown>, paths: string[][]): boolean | undefined {
  for (const path of paths) {
    let cur: unknown = data;
    for (const key of path) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[key];
      else {
        cur = undefined;
        break;
      }
    }
    if (typeof cur === "boolean") return cur;
  }
  return undefined;
}

function pickNumberRecord(data: Record<string, unknown>, paths: string[][]): Record<string, number> | undefined {
  for (const path of paths) {
    let cur: unknown = data;
    for (const key of path) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[key];
      else {
        cur = undefined;
        break;
      }
    }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) continue;
    const record: Record<string, number> = {};
    for (const [key, value] of Object.entries(cur as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) record[key] = value;
    }
    if (Object.keys(record).length) return record;
  }
  return undefined;
}

function pickStringArray(data: Record<string, unknown>, paths: string[][]): string[] | undefined {
  for (const path of paths) {
    let cur: unknown = data;
    for (const key of path) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[key];
      else {
        cur = undefined;
        break;
      }
    }
    if (!Array.isArray(cur)) continue;
    const values = cur.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (values.length) return values;
  }
  return undefined;
}

function pickString(data: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const path of paths) {
    let cur: unknown = data;
    for (const key of path) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[key];
      else {
        cur = undefined;
        break;
      }
    }
    if (typeof cur === "string" && cur.trim()) return cur.trim();
  }
  return undefined;
}

const MAX_RESULTS = 5;

const MAX_RESULTS_PATHS: string[][] = [
  ["piLightpanda", "maxResults"],
  ["webSearch", "maxResults"],
];

const FETCH_TIMEOUT_PATHS: string[][] = [
  ["piLightpanda", "timeoutMs"],
  ["webFetch", "timeoutMs"],
];

const ALLOW_PRIVATE_ADDRESSES_PATHS: string[][] = [
  ["piLightpanda", "allowPrivateAddresses"],
  ["webFetch", "allowPrivateAddresses"],
];

const ALLOW_LOCAL_FILES_PATHS: string[][] = [
  ["piLightpanda", "allowLocalFiles"],
  ["webFetch", "allowLocalFiles"],
];

const ALLOW_REMOTE_PDF_PATHS: string[][] = [
  ["piLightpanda", "allowRemotePdf"],
  ["webFetch", "allowRemotePdf"],
];

const LIGHTPANDA_ENABLED_PATHS: string[][] = [
  ["piLightpanda", "lightpandaEnabled"],
  ["webRender", "lightpandaEnabled"],
];

const LIGHTPANDA_PATH_PATHS: string[][] = [
  ["piLightpanda", "lightpandaPath"],
  ["webRender", "lightpandaPath"],
];

const LIGHTPANDA_COMMAND_PATHS: string[][] = [
  ["piLightpanda", "lightpandaCommand"],
  ["webRender", "lightpandaCommand"],
];

const ENGINE_WEIGHTS_PATHS: string[][] = [
  ["piLightpanda", "engineWeights"],
  ["webSearch", "engineWeights"],
];

const MAX_PER_HOST_PATHS: string[][] = [
  ["piLightpanda", "maxPerHost"],
  ["webSearch", "maxPerHost"],
];

const ENGINE_PATHS: string[][] = [
  ["piLightpanda", "engines"],
  ["webSearch", "engines"],
];

function clampMaxResults(value: number): number {
  return Math.min(20, Math.max(1, value));
}

function settingsFiles(cwd?: string): string[] {
  const base = agentDir();
  const globalFile = base ? join(base, "settings.json") : "";
  const files = globalFile ? [globalFile] : [];
  if (cwd) files.push(join(cwd, ".pi", "settings.json"));
  return files;
}

async function settingsEntries(cwd?: string): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (const file of settingsFiles(cwd)) {
    const data = await readJson(file);
    if (data) entries.push(data);
  }
  return entries;
}

export async function loadDefaultMaxResults(cwd?: string): Promise<number> {
  let result = MAX_RESULTS;
  for (const data of await settingsEntries(cwd)) {
    const candidate = pickNumber(data, MAX_RESULTS_PATHS);
    if (candidate !== undefined) result = clampMaxResults(candidate);
  }
  return result;
}

export async function loadSearchSettings(cwd?: string): Promise<{
  engines: string[] | undefined;
  sourceFile: string | null;
}> {
  let engines: string[] | undefined;
  let sourceFile: string | null = null;
  for (const file of settingsFiles(cwd)) {
    const data = await readJson(file);
    if (!data) continue;
    const candidate = pickStringArray(data, ENGINE_PATHS);
    if (candidate !== undefined) {
      engines = candidate;
      sourceFile = file;
    }
  }
  return { engines, sourceFile };
}

export async function loadDefaultEngines(cwd?: string): Promise<string[] | undefined> {
  return (await loadSearchSettings(cwd)).engines;
}

export async function loadDefaultEngineWeights(cwd?: string): Promise<Record<string, number> | undefined> {
  let result: Record<string, number> | undefined;
  for (const data of await settingsEntries(cwd)) {
    const candidate = pickNumberRecord(data, ENGINE_WEIGHTS_PATHS);
    if (candidate !== undefined) result = candidate;
  }
  return result;
}

export async function loadDefaultMaxPerHost(cwd?: string): Promise<number | undefined> {
  return loadFetchSetting(cwd, MAX_PER_HOST_PATHS, (n) => n >= 0);
}

async function loadFetchSetting(cwd: string | undefined, paths: string[][], valid: (n: number) => boolean): Promise<number | undefined> {
  let result: number | undefined;
  for (const data of await settingsEntries(cwd)) {
    const candidate = pickNumber(data, paths);
    if (candidate !== undefined && valid(candidate)) result = candidate;
  }
  return result;
}

export async function loadDefaultFetchTimeoutMs(cwd?: string): Promise<number | undefined> {
  return loadFetchSetting(cwd, FETCH_TIMEOUT_PATHS, (n) => n >= 1000);
}

export async function loadDefaultFetchSettings(cwd?: string): Promise<{
  timeoutMs?: number;
  allowPrivateAddresses: boolean;
  allowLocalFiles: boolean;
  allowRemotePdf: boolean;
}> {
  let timeoutMs: number | undefined;
  let allowPrivateAddresses = true;
  let allowLocalFiles = true;
  let allowRemotePdf = true;
  for (const data of await settingsEntries(cwd)) {
    const t = pickNumber(data, FETCH_TIMEOUT_PATHS);
    if (t !== undefined && t >= 1000) timeoutMs = t;
    const p = pickBoolean(data, ALLOW_PRIVATE_ADDRESSES_PATHS);
    if (p !== undefined) allowPrivateAddresses = p;
    const l = pickBoolean(data, ALLOW_LOCAL_FILES_PATHS);
    if (l !== undefined) allowLocalFiles = l;
    const r = pickBoolean(data, ALLOW_REMOTE_PDF_PATHS);
    if (r !== undefined) allowRemotePdf = r;
  }
  return { timeoutMs, allowPrivateAddresses, allowLocalFiles, allowRemotePdf };
}

export async function loadLightpandaSettings(cwd?: string): Promise<{
  enabled: boolean;
  binaryPath: string | null;
  command: string[] | null;
}> {
  let enabled = true;
  let binaryPath: string | null = null;
  let command: string[] | null = null;
  for (const data of await settingsEntries(cwd)) {
    const e = pickBoolean(data, LIGHTPANDA_ENABLED_PATHS);
    if (e !== undefined) enabled = e;
    const p = pickString(data, LIGHTPANDA_PATH_PATHS);
    if (p !== undefined) binaryPath = p;
    const c = pickStringArray(data, LIGHTPANDA_COMMAND_PATHS);
    if (c !== undefined) command = c;
  }
  return { enabled, binaryPath, command };
}
