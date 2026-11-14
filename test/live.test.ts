import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { visibleChars } from "../html-to-md.ts";
import { lightpandaLaunch, renderPageHtml } from "../lightpanda.ts";
import { searchSweep } from "../web-search.ts";
import { fetchPageText } from "../web-fetch.ts";

const enabled = process.env.PI_LIGHTPANDA_E2E === "1";
const binary =
  process.env.PI_LIGHTPANDA_E2E_BIN?.trim() || process.env.PI_LIGHTPANDA_BIN?.trim() || "lightpanda";

describe.skipIf(!enabled || process.platform === "win32")("lightpanda (live)", () => {
  const launch = lightpandaLaunch({ binaryPath: binary });
  const printable = launch.length === 1 ? launch[0] : launch.join(" ");

  it("runs the resolved command", () => {
    const version = execFileSync(launch[0], [...launch.slice(1), "version"], { encoding: "utf-8" }).trim();
    console.log(`renderer command: ${printable} -> ${version}`);
    expect(version.length).toBeGreaterThan(0);
  }, 60_000);

  it("renders a plain page through the local binary", async () => {
    const text = await fetchPageText("https://example.com/", {
      binaryPath: binary,
      timeoutMs: 90_000,
      useCache: false,
    });
    expect(text.startsWith("Failed to ")).toBe(false);
    expect(text.startsWith("Blocked:")).toBe(false);
    expect(text).toContain("Title: Example Domain");
    expect(text).toContain("URL: https://example.com/");
    expect(text).toContain("Rendered via Lightpanda");
    expect(visibleChars(text)).toBeGreaterThan(150);
  }, 150_000);

  it("renders a javascript-heavy page", async () => {
    const text = await fetchPageText("https://react.dev/learn", {
      binaryPath: binary,
      timeoutMs: 120_000,
      useCache: false,
    });
    expect(text.startsWith("Failed to ")).toBe(false);
    expect(visibleChars(text)).toBeGreaterThan(2_000);
  }, 180_000);

  it("renders a GitHub repository page into its README", async () => {
    const text = await fetchPageText("https://github.com/unslothai/unsloth", {
      binaryPath: binary,
      timeoutMs: 120_000,
      useCache: false,
    });
    expect(text).toContain("Unsloth Studio");
    expect(text).not.toContain("<html");
    expect(visibleChars(text)).toBeGreaterThan(2_000);
  }, 180_000);

  it("extracts a remote PDF through the direct exception", async () => {
    const text = await fetchPageText("https://pdfobject.com/pdf/sample.pdf", {
      timeoutMs: 60_000,
      useCache: false,
    });
    expect(text).toContain("## Page 1");
    expect(text).toContain("Sample PDF");
  }, 90_000);

  it("returns search results from at least one engine", async () => {
    const results = await searchSweep("unsloth studio", 5, undefined, 180_000, {
      renderPage: (url, options) =>
        renderPageHtml(url, {
          binaryPath: binary,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          allowPrivateAddresses: true,
        }),
    });
    const healthy = results.filter((result) => result.title.trim() && /^https?:\/\//.test(result.href));
    if (!healthy.length) console.warn("no healthy engine returned results from this network");
    expect(healthy.length).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
