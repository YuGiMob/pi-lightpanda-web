import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchRemotePdf, looksLikePdfUrl } from "../pdf-fetch.ts";
import { makePdf } from "./helpers.ts";

let server: http.Server;
let base: string;

beforeEach(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/doc.pdf") {
      const body = makePdf(["Remote pdf marker"]);
      response.writeHead(200, { "content-type": "application/pdf", "content-length": String(body.length) });
      response.end(body);
      return;
    }
    if (url.pathname === "/gzip.pdf") {
      const body = gzipSync(makePdf(["Gzip pdf marker"]));
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-encoding": "gzip",
        "content-length": String(body.length),
      });
      response.end(body);
      return;
    }
    if (url.pathname === "/html.pdf") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body><h1>Not a pdf</h1></body></html>");
      return;
    }
    if (url.pathname === "/redirect.pdf") {
      response.writeHead(302, { location: "/doc.pdf" });
      response.end();
      return;
    }
    if (url.pathname === "/redirect-away.pdf") {
      response.writeHead(302, { location: "http://example.com/doc.pdf" });
      response.end();
      return;
    }
    if (url.pathname === "/big.pdf") {
      const body = makePdf(["x".repeat(1000)]);
      response.writeHead(200, { "content-type": "application/pdf", "content-length": String(body.length) });
      response.end(body);
      return;
    }
    if (url.pathname === "/slow.pdf") return;
    response.writeHead(404, { "content-type": "text/html" });
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

describe("looksLikePdfUrl", () => {
  it("recognizes common PDF URL shapes", () => {
    expect(looksLikePdfUrl("https://example.com/paper.pdf")).toBe(true);
    expect(looksLikePdfUrl("https://arxiv.org/pdf/2305.07147")).toBe(true);
    expect(looksLikePdfUrl("https://example.com/download?file=paper.pdf")).toBe(true);
    expect(looksLikePdfUrl("https://example.com/download?format=pdf")).toBe(true);
    expect(looksLikePdfUrl("https://example.com/article")).toBe(false);
    expect(looksLikePdfUrl("not a url")).toBe(false);
  });
});

describe("fetchRemotePdf", () => {
  it("downloads and extracts a PDF", async () => {
    const outcome = await fetchRemotePdf(`${base}/doc.pdf`, {
      timeoutMs: 5000,
      allowPrivateAddresses: true,
    });
    expect(outcome).not.toBeNull();
    expect("text" in outcome!).toBe(true);
    expect("text" in outcome! && outcome.text).toContain("Remote pdf marker");
  });

  it("follows a redirect", async () => {
    const outcome = await fetchRemotePdf(`${base}/redirect.pdf`, {
      timeoutMs: 5000,
      allowPrivateAddresses: true,
    });
    expect("text" in outcome! && outcome.text).toContain("Remote pdf marker");
  });

  it("decompresses a gzip-encoded PDF", async () => {
    const outcome = await fetchRemotePdf(`${base}/gzip.pdf`, {
      timeoutMs: 5000,
      allowPrivateAddresses: true,
    });
    expect("text" in outcome! && outcome.text).toContain("Gzip pdf marker");
  });

  it("returns null when the response is not a PDF", async () => {
    expect(
      await fetchRemotePdf(`${base}/html.pdf`, { timeoutMs: 5000, allowPrivateAddresses: true }),
    ).toBeNull();
  });

  it("reports HTTP errors", async () => {
    const outcome = await fetchRemotePdf(`${base}/missing.pdf`, {
      timeoutMs: 5000,
      allowPrivateAddresses: true,
    });
    expect("error" in outcome! && outcome.error).toBe("Failed to fetch URL: HTTP 404 Not Found");
  });

  it("enforces the PDF download limit", async () => {
    const outcome = await fetchRemotePdf(`${base}/big.pdf`, {
      timeoutMs: 5000,
      allowPrivateAddresses: true,
      maxPdfBytes: 256,
    });
    expect("error" in outcome! && outcome.error).toBe(
      "(PDF content exceeds the download limit; not readable as text)",
    );
  });

  it("enforces the website policy on redirects", async () => {
    const outcome = await fetchRemotePdf(`${base}/redirect-away.pdf`, {
      timeoutMs: 5000,
      allowPrivateAddresses: true,
      websitePolicy: { allowedDomains: ["127.0.0.1"], blockedDomains: [] },
    });
    expect("error" in outcome! && outcome.error).toBe(
      "Blocked: the website access policy disallows example.com.",
    );
  });

  it("blocks private addresses when opted out", async () => {
    const outcome = await fetchRemotePdf(`${base}/doc.pdf`, {
      timeoutMs: 5000,
      allowPrivateAddresses: false,
    });
    expect("error" in outcome! && outcome.error).toContain("non-public address 127.0.0.1");
  });

  it("times out a stalled download", async () => {
    const outcome = await fetchRemotePdf(`${base}/slow.pdf`, {
      timeoutMs: 100,
      allowPrivateAddresses: true,
    });
    expect("error" in outcome! && outcome.error).toBe("Failed to fetch URL: timed out.");
  });

  it("honors a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await fetchRemotePdf(`${base}/doc.pdf`, {
      timeoutMs: 5000,
      allowPrivateAddresses: true,
      signal: controller.signal,
    });
    expect("error" in outcome! && outcome.error).toBe("Failed to fetch URL: cancelled.");
  });
});
