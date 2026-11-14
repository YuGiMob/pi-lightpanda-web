import { describe, expect, it } from "vitest";
import {
  EMPTY_SEARCH_RESULTS,
  EmptySweepError,
  SearchTimeoutError,
  formatSearchResults,
  searchFailureMessage,
  webSearch,
} from "../web-search.ts";
import { fetchPageText } from "../web-fetch.ts";
import { truncatePageText } from "../page-text.ts";
import { staleNotice } from "../cache.ts";
import { checkUrlAccess } from "../web-access.ts";
import { makeSpawn } from "./helpers.ts";

describe("search contract", () => {
  it("returns the empty-query message", async () => {
    expect(await webSearch("", {})).toBe("No query provided.");
    expect(await webSearch("   ", {})).toBe("No query provided.");
  });

  it("returns the cancellation message", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await webSearch("cats", { signal: controller.signal })).toBe("Search cancelled.");
  });

  it("pins the empty-result messages", () => {
    expect(EMPTY_SEARCH_RESULTS).toEqual([
      "No results found.",
      "No results found within the website access limits.",
    ]);
  });

  it("pins timeout messages with and without providers", () => {
    expect(searchFailureMessage(new SearchTimeoutError(["brave", "google"]), 60000)).toBe(
      "Search failed: the search engines (brave, google) did not respond within 60 seconds.",
    );
    expect(searchFailureMessage(new SearchTimeoutError([]), 60000)).toBe(
      "Search failed: the search engines did not respond within 60 seconds.",
    );
  });

  it("maps empty sweeps and generic failures", () => {
    expect(searchFailureMessage(new EmptySweepError())).toBe("No results found.");
    expect(searchFailureMessage(new Error("No results found upstream"))).toBe("No results found.");
    expect(searchFailureMessage(new Error("boom"))).toBe("Search failed: boom");
  });

  it("ends formatted results with the web_fetch hint", () => {
    const out = formatSearchResults([{ title: "T", href: "https://x.com/", body: "S" }]);
    expect(out).toContain("Title: T");
    expect(out).toContain("URL: https://x.com/");
    expect(out).toContain("Snippet: S");
    expect(out).toContain("call web_fetch");
  });
});

describe("fetch contract", () => {
  it("pins blocked-url messages", () => {
    expect(checkUrlAccess("", null)[1]).toBe("Blocked: the URL is empty.");
    expect(checkUrlAccess("ftp://x.com", null)[1]).toBe("Blocked: only http/https URLs are allowed.");
    expect(checkUrlAccess("https://user:pass@example.com", null)[1]).toBe(
      "Blocked: URLs with credentials or encoded hostnames are not allowed.",
    );
  });

  it("reports empty pages", () => {
    expect(truncatePageText("", 100)).toBe("(page returned no readable text)");
  });

  it("marks maxChars truncation with the total", () => {
    const out = truncatePageText("x".repeat(300), 100);
    expect(out).toContain("(truncated, 300 chars total)");
  });

  it("does not split surrogate pairs at the maxChars boundary", () => {
    const out = truncatePageText("😀".repeat(100), 149);
    expect(out.indexOf("\n\n")).toBe(148);
    expect(out).toContain("(truncated, 200 chars total)");
  });

  it("returns pages within the budget unchanged", () => {
    expect(truncatePageText("hello", 1000)).toBe("hello");
  });

  it("reports a missing renderer", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    const out = await fetchPageText("https://example.com/", { spawn: spawnImpl, binaryPath: "lp-missing-test" });
    expect(out).toBe(
      "(Lightpanda is not installed; run bash scripts/install-lightpanda.sh to enable web_fetch)",
    );
  });

  it("reports remote pdfs as unreadable", async () => {
    const { spawnImpl } = makeSpawn((call) => {
      if (call.args.at(-1) === "version") return { stdout: "1.0.4", code: 0 };
      return {
        stdout: JSON.stringify({
          url: "https://example.com/doc.pdf",
          http_status: 200,
          headers: [{ name: "content-type", value: "application/pdf" }],
          content: "",
          error: null,
        }),
        code: 0,
      };
    });
    expect(
      await fetchPageText("https://example.com/doc.pdf", {
        spawn: spawnImpl,
        binaryPath: "lp-pdf-test",
        allowRemotePdf: false,
      }),
    ).toBe("(PDF content cannot be read by the local renderer)");
  });

  it("formats stale cache notices with an iso date", () => {
    const notice = staleNotice({
      url: "https://x.com/",
      body: "b",
      contentType: "text/markdown",
      timestamp: Date.UTC(2024, 0, 15),
    });
    expect(notice).toContain("STALE cache from 2024-01-15");
    expect(notice).toContain("serving cached copy");
  });
});
