import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPageText } from "../web-fetch.ts";
import { setCached, type CacheEntry } from "../cache.ts";
import { makePdf, makeSpawn, spawnFailing, spawnRendering } from "./helpers.ts";

const PAGE =
  "<html><head><title>Stub Page</title></head><body><article><h1>Doc</h1>" +
  "<p>Readable stub body text.</p></article></body></html>";

let dir: string;
let cacheDir: string;
const initialCacheDir = process.env.PI_LIGHTPANDA_CACHE_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lightpanda-fetch-"));
  cacheDir = join(dir, "cache");
  process.env.PI_LIGHTPANDA_CACHE_DIR = cacheDir;
});

afterEach(async () => {
  if (initialCacheDir === undefined) delete process.env.PI_LIGHTPANDA_CACHE_DIR;
  else process.env.PI_LIGHTPANDA_CACHE_DIR = initialCacheDir;
  await rm(dir, { recursive: true, force: true });
});

describe("remote fetches", () => {
  it("renders the full page without a character cap", async () => {
    const padding = "padding ".repeat(200);
    const { spawnImpl } = spawnRendering(PAGE + "<p>" + padding + "</p>");
    const out = await fetchPageText("https://example.com/doc", {
      spawn: spawnImpl,
      timeoutMs: 5000,
    });
    expect(out).toContain("Stub Page");
    expect(out).toContain(padding.trim());
    expect(out).not.toContain("(truncated");
  });

  it("reports http errors", async () => {
    const { spawnImpl } = spawnRendering("<html><body>missing</body></html>", { status: 404 });
    const out = await fetchPageText("https://example.com/missing", { spawn: spawnImpl });
    expect(out).toBe("Failed to fetch URL: HTTP 404 Not Found");
  });

  it("reports remote pdfs as unreadable when the exception is disabled", async () => {
    const { spawnImpl } = spawnRendering("", { headers: { "content-type": "application/pdf" } });
    const out = await fetchPageText("https://example.com/doc.pdf", {
      spawn: spawnImpl,
      allowRemotePdf: false,
    });
    expect(out).toBe("(PDF content cannot be read by the local renderer)");
  });

  it("uses the direct PDF fetcher for PDF-looking URLs", async () => {
    const pdfFetcher = vi.fn(async () => ({ text: "Remote PDF text" }));
    const out = await fetchPageText("https://example.com/doc.pdf", { pdfFetcher, useCache: false });
    expect(out).toBe("Remote PDF text");
    expect(pdfFetcher).toHaveBeenCalledWith("https://example.com/doc.pdf", expect.any(Object));
  });

  it("falls back to the PDF fetcher when the renderer reports a PDF", async () => {
    const { spawnImpl } = spawnRendering("", { headers: { "content-type": "application/pdf" } });
    const pdfFetcher = vi.fn(async () => ({ text: "Remote PDF text" }));
    const out = await fetchPageText("https://example.com/paper", { spawn: spawnImpl, pdfFetcher });
    expect(out).toBe("Remote PDF text");
  });

  it("reports direct PDF failures", async () => {
    const failing = vi.fn(async () => ({ error: "Failed to fetch URL: HTTP 404 Not Found" }));
    expect(await fetchPageText("https://example.com/doc.pdf", { pdfFetcher: failing, useCache: false })).toBe(
      "Failed to fetch URL: HTTP 404 Not Found",
    );
  });

  it("reports a missing renderer", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    const out = await fetchPageText("https://example.com/", { spawn: spawnImpl });
    expect(out).toContain("Lightpanda is not installed");
  });

  it("returns null-render failures without a cache", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    const out = await fetchPageText("https://example.com/", { spawn: spawnImpl, useCache: true });
    expect(out).toContain("Lightpanda is not installed");
  });

  it("reports a disabled renderer", async () => {
    const { spawnImpl } = spawnRendering(PAGE);
    const out = await fetchPageText("https://example.com/", {
      spawn: spawnImpl,
      settings: { enabled: false, binaryPath: null, command: null },
    });
    expect(out).toContain("Lightpanda is not installed");
  });

  it("passes the private-address and policy settings through", async () => {
    const { spawnImpl, calls } = spawnRendering(PAGE);
    await fetchPageText("https://example.com/", {
      spawn: spawnImpl,
      allowPrivateAddresses: false,
      websitePolicy: { allowedDomains: ["example.com"], blockedDomains: [] },
    });
    const fetchCall = calls.find((call) => call.args.includes("fetch"));
    expect(fetchCall?.args).toContain("--block-private-networks");
  });
});

describe("cache fallback", () => {
  it("serves a fresh cached copy when the renderer fails", async () => {
    await setCached("https://example.com/doc", "cached body", "text/markdown");
    const { spawnImpl } = spawnFailing(1);
    const out = await fetchPageText("https://example.com/doc", { spawn: spawnImpl, useCache: true });
    expect(out).toContain("cached body");
    expect(out).toContain("Served from cache");
  });

  it("serves a stale cached copy with its date", async () => {
    await setCached("https://example.com/old", "old body", "text/markdown");
    const [name] = (await readdir(cacheDir)).filter((entry) => entry.endsWith(".json"));
    const path = join(cacheDir, name);
    const entry = JSON.parse(await readFile(path, "utf-8")) as CacheEntry;
    entry.timestamp = Date.now() - 2 * 60 * 60 * 1000;
    await writeFile(path, JSON.stringify(entry));
    const { spawnImpl } = spawnFailing(1);
    const out = await fetchPageText("https://example.com/old", { spawn: spawnImpl, useCache: true });
    expect(out).toContain("old body");
    expect(out).toContain("STALE cache from");
  });

  it("keys the cache by the canonicalized url", async () => {
    await setCached("https://example.com/page?utm_source=rss#top", "canonical body", "text/markdown");
    const { spawnImpl } = spawnFailing(1);
    const out = await fetchPageText("https://example.com/page", { spawn: spawnImpl, useCache: true });
    expect(out).toContain("canonical body");
  });

  it("does not serve the cache for blocked targets", async () => {
    await setCached("https://example.com/blocked", "cached body", "text/markdown");
    const out = await fetchPageText("https://example.com/blocked", {
      websitePolicy: { allowedDomains: [], blockedDomains: ["example.com"] },
      useCache: true,
    });
    expect(out).toBe("Blocked: the website access policy disallows example.com.");
    expect(out).not.toContain("cached body");
  });

  it("writes rendered pages to the cache", async () => {
    const { spawnImpl } = spawnRendering(PAGE);
    await fetchPageText("https://example.com/written", { spawn: spawnImpl, useCache: true });
    const names = (await readdir(cacheDir)).filter((entry) => entry.endsWith(".json"));
    expect(names).toHaveLength(1);
    const entry = JSON.parse(await readFile(join(cacheDir, names[0]), "utf-8")) as CacheEntry;
    expect(entry.body).toContain("Stub Page");
    expect(entry.contentType).toBe("text/markdown");
  });
});

describe("local files", () => {
  it("converts a local html file with the title prefix", async () => {
    const file = join(dir, "page.html");
    await writeFile(file, "<html><head><title>Local Doc</title></head><body><p>Readable local body text.</p></body></html>");
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out.startsWith("Title: Local Doc")).toBe(true);
    expect(out).toContain("Readable local body text.");
    expect(out).not.toContain("<html");
  });

  it("converts an html fragment by extension", async () => {
    const file = join(dir, "fragment.html");
    await writeFile(file, "<div><h1>Fragment Title</h1><p>Readable fragment body text.</p></div>");
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out).toContain("Fragment Title");
    expect(out).toContain("Readable fragment body text.");
    expect(out).not.toContain("<div>");
  });

  it("keeps non-html files raw", async () => {
    const file = join(dir, "notes.txt");
    await writeFile(file, "line one\n    indented code\nline three");
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out).toContain("    indented code");
  });

  it("extracts a local pdf, including through a file url", async () => {
    const file = join(dir, "doc.pdf");
    await writeFile(file, makePdf(["Local pdf marker"]));
    for (const target of [file, pathToFileURL(file).href]) {
      const out = await fetchPageText(target, { timeoutMs: 5000 });
      expect(out).toContain("## Page 1");
      expect(out).toContain("Local pdf marker");
    }
  });

  it("reports malformed local pdfs", async () => {
    const file = join(dir, "broken.pdf");
    await writeFile(file, Buffer.from("%PDF-1.7\nnot a complete PDF"));
    expect(await fetchPageText(file, { timeoutMs: 5000 })).toBe("(PDF content could not be read as text)");
  });

  it("rejects binary files", async () => {
    const file = join(dir, "blob.bin");
    await writeFile(file, Buffer.concat(Array.from({ length: 40 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i)))));
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out).toContain("(binary content,");
  });

  it("reports missing files and directories", async () => {
    expect((await fetchPageText(join(dir, "missing.pdf"), { timeoutMs: 5000 })).startsWith("Failed to read file:")).toBe(true);
    expect((await fetchPageText(dir, { timeoutMs: 5000 })).startsWith("Failed to read file:")).toBe(true);
  });

  it("reads local files in full without a cap", async () => {
    const file = join(dir, "big.txt");
    const content = "a".repeat(600);
    await writeFile(file, content);
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out).toBe(content);
  });

  it("refuses local files when disabled", async () => {
    const file = join(dir, "doc.pdf");
    await writeFile(file, makePdf(["Hidden marker"]));
    const out = await fetchPageText(file, { allowLocalFiles: false, timeoutMs: 5000 });
    expect(out.startsWith("Blocked:")).toBe(true);
    expect(out).not.toContain("Hidden marker");
  });

  it("honors a pre-aborted signal", async () => {
    const file = join(dir, "page.html");
    await writeFile(file, "<p>hello</p>");
    const controller = new AbortController();
    controller.abort();
    expect(await fetchPageText(file, { signal: controller.signal })).toBe("Failed to read file: cancelled.");
  });

  it("leaves the cache untouched for local files", async () => {
    const file = join(dir, "page.html");
    await writeFile(file, "<p>hello</p>");
    await fetchPageText(file, { timeoutMs: 5000 });
    await mkdir(cacheDir, { recursive: true });
    expect((await readdir(cacheDir)).filter((entry) => entry.endsWith(".json"))).toHaveLength(0);
    expect((await stat(cacheDir)).isDirectory()).toBe(true);
  });
});
