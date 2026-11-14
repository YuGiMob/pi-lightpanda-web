import net from "node:net";

const HTTPS_PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
const HTTP_PROXY_VARS = ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const NO_PROXY_VARS = ["NO_PROXY", "no_proxy"];

function firstEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function noProxyEntries(): string[] {
  const raw = firstEnv(NO_PROXY_VARS);
  if (!raw) return [];
  return raw.split(/[\s,]+/).filter((entry) => entry.length > 0);
}

function splitHostPort(entry: string): { host: string; port: number | null } {
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end === -1) return { host: entry, port: null };
    const host = entry.slice(1, end);
    const rest = entry.slice(end + 1);
    if (rest.startsWith(":") && /^\d+$/.test(rest.slice(1))) return { host, port: Number(rest.slice(1)) };
    return { host, port: null };
  }
  const colon = entry.lastIndexOf(":");
  if (colon > 0 && entry.indexOf(":") === colon && /^\d+$/.test(entry.slice(colon + 1))) {
    return { host: entry.slice(0, colon), port: Number(entry.slice(colon + 1)) };
  }
  return { host: entry, port: null };
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function bypassesProxy(hostname: string, port: number): boolean {
  const host = stripIpv6Brackets(hostname.toLowerCase());
  for (const rawEntry of noProxyEntries()) {
    const entry = rawEntry.toLowerCase();
    if (entry === "*") return true;
    const { host: rawHost, port: entryPort } = splitHostPort(entry);
    if (entryPort !== null && entryPort !== port) continue;
    const pattern = rawHost.replace(/^\./, "").replace(/\.$/, "");
    if (!pattern) continue;
    if (host === pattern) return true;
    if (!net.isIP(pattern) && host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

export function proxyForUrl(url: URL): string | null {
  const raw = firstEnv(url.protocol === "https:" ? HTTPS_PROXY_VARS : HTTP_PROXY_VARS);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (bypassesProxy(url.hostname, port)) return null;
  return parsed.toString();
}
