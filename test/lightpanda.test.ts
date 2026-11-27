import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lightpandaBinary,
  lightpandaLaunch,
  ensureLightpandaInstalled,
  renderPageHtml,
  renderPageHtmlOutcome,
  renderPageWithLightpanda,
  sameAddress,
} from "../lightpanda.ts";
import { makeSpawn, spawnFailing, spawnRendering } from "./helpers.ts";

const PUBLIC_PAGE =
  "<html><head><title>Local</title></head><body><article><h1>Doc</h1>" +
  "<p>Readable body text here.</p></article></body></html>";

const PUBLIC_URL = "https://example.com/";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
}

async function withIsolatedLauncher<T>(run: () => Promise<T>): Promise<T> {
  const previousDataHome = process.env.XDG_DATA_HOME;
  const previousBinary = process.env.PI_LIGHTPANDA_BIN;
  const dataHome = await mkdtemp(join(tmpdir(), "pi-lightpanda-install-"));
  const installDir = join(dataHome, "pi-lightpanda-web", "lightpanda");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "lightpanda"), "#!/bin/sh\nexit 0\n");
  process.env.XDG_DATA_HOME = dataHome;
  delete process.env.PI_LIGHTPANDA_BIN;
  try {
    return await run();
  } finally {
    if (previousBinary === undefined) delete process.env.PI_LIGHTPANDA_BIN;
    else process.env.PI_LIGHTPANDA_BIN = previousBinary;
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    await rm(dataHome, { recursive: true, force: true });
  }
}

function gatedInstall() {
  let installed = false;
  const gate = deferred();
  const probe = makeSpawn((call) => {
    if (call.args.at(-1) !== "version") return { stdout: "", code: 1 };
    return installed ? { stdout: "1.0.4", code: 0 } : { code: 1 };
  });
  const installer = async () => {
    await gate.promise;
    installed = true;
    return true;
  };
  return { probe, installer, release: gate.resolve };
}

let binarySequence = 0;

beforeEach(() => {
  process.env.PI_LIGHTPANDA_BIN = `lightpanda-test-${++binarySequence}`;
});

afterEach(() => {
  delete process.env.PI_LIGHTPANDA_BIN;
  delete process.env.XDG_DATA_HOME;
  delete process.env.HTTPS_PROXY;
  vi.unstubAllEnvs();
});

describe("automatic renderer installation", () => {
  it("skips installation when a spawn stub is supplied", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    expect(await ensureLightpandaInstalled({ spawn: spawnImpl })).toBe(false);
  });

  it("runs the installer once and re-probes the renderer", async () => {
    delete process.env.PI_LIGHTPANDA_BIN;
    let installed = false;
    const { spawnImpl } = makeSpawn((call) => {
      if (call.args.at(-1) !== "version") return { stdout: "", code: 1 };
      return installed ? { stdout: "1.0.4", code: 0 } : { code: 1 };
    });
    const installer = async () => {
      installed = true;
      return true;
    };
    expect(await ensureLightpandaInstalled({ spawn: spawnImpl, installer })).toBe(true);
  });

  it("joins an in-flight install instead of probing", async () => {
    await withIsolatedLauncher(async () => {
      const { probe, installer, release } = gatedInstall();
      const install = ensureLightpandaInstalled({ spawn: probe.spawnImpl, installer });
      const joinProbe = makeSpawn(() => ({ stdout: "1.0.4", code: 0 }));
      const joined = ensureLightpandaInstalled({ spawn: joinProbe.spawnImpl });
      let joinedSettled = false;
      void joined.then(() => {
        joinedSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(joinedSettled).toBe(false);
      expect(joinProbe.calls).toEqual([]);
      release();
      expect(await install).toBe(true);
      expect(await joined).toBe(true);
      expect(joinProbe.calls).toEqual([]);
    });
  });

  it("renders only after an in-flight install finishes", async () => {
    await withIsolatedLauncher(async () => {
      const { probe, installer, release } = gatedInstall();
      const install = ensureLightpandaInstalled({ spawn: probe.spawnImpl, installer });
      const serving = spawnRendering(PUBLIC_PAGE);
      let rendered: string | null = null;
      const pending = renderPageWithLightpanda(PUBLIC_URL, {
        spawn: serving.spawnImpl,
        timeoutMs: 5000,
      }).then((out) => {
        rendered = out;
        return out;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rendered).toBeNull();
      expect(serving.calls).toEqual([]);
      release();
      expect(await install).toBe(true);
      const out = await pending;
      expect(out).not.toBeNull();
      expect(out).toContain("Readable body text here.");
      expect(out).not.toContain("URL:");
    });
  });

  it("stops waiting on abort while the install continues", async () => {
    await withIsolatedLauncher(async () => {
      const { probe, installer, release } = gatedInstall();
      const install = ensureLightpandaInstalled({ spawn: probe.spawnImpl, installer });
      const joinProbe = makeSpawn(() => ({ stdout: "1.0.4", code: 0 }));
      const controller = new AbortController();
      const joined = ensureLightpandaInstalled({ spawn: joinProbe.spawnImpl, signal: controller.signal });
      const renderController = new AbortController();
      renderController.abort();
      const serving = spawnRendering(PUBLIC_PAGE);
      const render = renderPageWithLightpanda(PUBLIC_URL, {
        spawn: serving.spawnImpl,
        signal: renderController.signal,
      });
      controller.abort();
      expect(await joined).toBe(false);
      expect(await render).toBe("Failed to render URL: cancelled.");
      expect(joinProbe.calls).toEqual([]);
      expect(serving.calls).toEqual([]);
      release();
      expect(await install).toBe(true);
    });
  });

  it("re-probes a failed availability check after the negative ttl", async () => {
    const now = vi.spyOn(Date, "now");
    const startedAt = 1_000_000;
    now.mockReturnValue(startedAt);
    try {
      let healthy = false;
      const { spawnImpl, calls } = makeSpawn(() => (healthy ? { stdout: "1.0.4", code: 0 } : { code: 1 }));
      const command = [`lightpanda-probe-ttl-${++binarySequence}`];
      expect(await ensureLightpandaInstalled({ command, spawn: spawnImpl })).toBe(false);
      expect(await ensureLightpandaInstalled({ command, spawn: spawnImpl })).toBe(false);
      expect(calls.length).toBe(1);
      healthy = true;
      now.mockReturnValue(startedAt + 10_001);
      expect(await ensureLightpandaInstalled({ command, spawn: spawnImpl })).toBe(true);
      expect(calls.length).toBe(2);
      expect(await ensureLightpandaInstalled({ command, spawn: spawnImpl })).toBe(true);
      expect(calls.length).toBe(2);
    } finally {
      now.mockRestore();
    }
  });
});

describe("renderPageWithLightpanda", () => {
  it("stays disabled by settings without spawning", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda(PUBLIC_URL, {
      spawn: spawnImpl,
      settings: { enabled: false, binaryPath: null, command: null },
    });
    expect(out).toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null when the binary is not installed", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    const out = await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl });
    expect(out).toBeNull();
  });

  it("renders html through the markdown pipeline without a url line", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE, { url: "https://example.com/page" });
    const out = await renderPageWithLightpanda("https://example.com/page", {
      spawn: spawnImpl,
      timeoutMs: 5000,
    });
    expect(out).not.toBeNull();
    expect(out?.startsWith("Title: Local\n")).toBe(true);
    expect(out).not.toContain("URL:");
    expect(out).toContain("Readable body text here.");
    expect(out).not.toContain("<html");
    const fetchCall = calls.find((call) => call.args.includes("fetch"));
    expect(fetchCall?.args).toContain("--json");
    expect(fetchCall?.args).toContain("--dump");
    expect(fetchCall?.args).toContain("html");
    expect(fetchCall?.args).toContain("--wait-until");
    expect(fetchCall?.args).toContain("networkidle");
    expect(fetchCall?.args).toContain("--http-timeout");
    expect(fetchCall?.args).toContain("5000");
    expect(fetchCall?.args.at(-1)).toBe("https://example.com/page");
    expect(fetchCall?.args).not.toContain("--block-private-networks");
  });

  it("shows the final url when a render redirects", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE, { url: "https://other.example/landing" });
    const out = await renderPageWithLightpanda("https://example.com/page", {
      spawn: spawnImpl,
      timeoutMs: 5000,
    });
    expect(out?.startsWith("URL: https://other.example/landing\nTitle: Local\n")).toBe(true);
    expect(out?.match(/^URL: /gm)?.length).toBe(1);
  });

  it("adds no url line for a bare-host input that matches its normalized url", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE, { url: "https://example.com" });
    const out = await renderPageWithLightpanda("example.com", {
      spawn: spawnImpl,
      timeoutMs: 5000,
    });
    expect(out?.startsWith("Title: Local")).toBe(true);
    expect(out).not.toContain("URL:");
  });

  it("adds no url line when the render only adds a trailing slash", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE, { url: "https://example.com/" });
    const out = await renderPageWithLightpanda("https://example.com", {
      spawn: spawnImpl,
      timeoutMs: 5000,
    });
    expect(out?.startsWith("Title: Local\n")).toBe(true);
    expect(out).not.toContain("URL:");
  });

  it("shows the final url when a redirect adds a path slash", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE, { url: "https://example.com/page/" });
    const out = await renderPageWithLightpanda("https://example.com/page", {
      spawn: spawnImpl,
      timeoutMs: 5000,
    });
    expect(out?.startsWith("URL: https://example.com/page/\nTitle: Local\n")).toBe(true);
    expect(out?.match(/^URL: /gm)?.length).toBe(1);
  });

  it("adds no url line when only a default port differs", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE, { url: "https://example.com/" });
    const out = await renderPageWithLightpanda("https://example.com:443/", {
      spawn: spawnImpl,
      timeoutMs: 5000,
    });
    expect(out?.startsWith("Title: Local\n")).toBe(true);
    expect(out).not.toContain("URL:");
  });

  it("returns markdown dumps directly", async () => {
    const { spawnImpl } = spawnRendering("# Doc\n\nBody text.", { headers: { "content-type": "text/markdown" } });
    const out = await renderPageWithLightpanda(PUBLIC_URL, {
      spawn: spawnImpl,
      dump: "markdown",
    });
    expect(out?.startsWith("# Doc")).toBe(true);
    expect(out).not.toContain("URL:");
    expect(out).toContain("# Doc\n\nBody text.");
  });

  it("honors a custom wait-until", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl, waitUntil: "domcontentloaded" });
    const fetchCall = calls.find((call) => call.args.includes("fetch"));
    expect(fetchCall?.args).toContain("domcontentloaded");
  });

  it("blocks private networks only when opted out", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl, allowPrivateAddresses: false });
    const fetchCall = calls.find((call) => call.args.includes("fetch"));
    expect(fetchCall?.args).toContain("--block-private-networks");
  });

  it("passes an http proxy only for http(s) proxy schemes", async () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://127.0.0.1:9050");
    const first = spawnRendering(PUBLIC_PAGE);
    await renderPageWithLightpanda(PUBLIC_URL, { spawn: first.spawnImpl });
    expect(first.calls.find((call) => call.args.includes("fetch"))?.args).not.toContain("--http-proxy");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:3128");
    const second = spawnRendering(PUBLIC_PAGE);
    await renderPageWithLightpanda(PUBLIC_URL, { spawn: second.spawnImpl });
    const args = second.calls.find((call) => call.args.includes("fetch"))?.args ?? [];
    expect(args).toContain("--http-proxy");
    expect(args).toContain("http://proxy.example:3128/");
  });

  it("reports a non-zero exit", async () => {
    const { spawnImpl } = spawnFailing(3);
    const out = await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl });
    expect(out).toBe("Failed to render URL: Lightpanda exited with code 3.");
  });

  it("reports a rendered http error", async () => {
    const { spawnImpl } = spawnRendering("<html><body>not found</body></html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
    const out = await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl });
    expect(out).toBe("Failed to fetch URL: HTTP 404 Not Found");
  });

  it("reports a navigation error from the json payload", async () => {
    const { spawnImpl } = makeSpawn((call) => {
      if (call.args.at(-1) === "version") return { stdout: "1.0.4", code: 0 };
      return { stdout: JSON.stringify({ url: PUBLIC_URL, error: "navigation" }), code: 0 };
    });
    const out = await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl });
    expect(out).toBe("Failed to render URL: navigation.");
  });

  it("reports a pdf body as unsupported", async () => {
    const { spawnImpl } = spawnRendering("", {
      headers: { "content-type": "application/pdf" },
    });
    const out = await renderPageWithLightpanda("https://example.com/doc.pdf", { spawn: spawnImpl });
    expect(out).toBe("(PDF content cannot be read by the local renderer)");
  });

  it("reports empty output as no readable text", async () => {
    const { spawnImpl } = spawnRendering("");
    const out = await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl });
    expect(out).toBe("(page returned no readable text)");
  });

  it("rejects bot challenge pages", async () => {
    const { spawnImpl } = spawnRendering(
      "<html><head><title>DuckDuckGo</title></head><body><p>Unfortunately, bots use DuckDuckGo too.</p><p>Please complete the following challenge.</p></body></html>",
    );
    const out = await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl });
    expect(out).toBe("Failed to render URL: the page served a bot challenge instead of content.");
  });

  it("kills a hung render at the deadline", async () => {
    const hanging = makeSpawn((call) => {
      if (call.args.at(-1) === "version") return { stdout: "1.0.4", code: 0 };
      return { neverClose: true };
    });
    const out = await renderPageWithLightpanda(PUBLIC_URL, { spawn: hanging.spawnImpl, timeoutMs: 20 });
    expect(out).toBe("Failed to render URL: timed out.");
    expect(hanging.kills.length).toBe(1);
  });

  it("kills a render when the caller cancels", async () => {
    const controller = new AbortController();
    const { spawnImpl, kills } = makeSpawn((call) => {
      if (call.args.at(-1) === "version") return { stdout: "1.0.4", code: 0 };
      return { neverClose: true };
    });
    const pending = renderPageWithLightpanda(PUBLIC_URL, {
      spawn: spawnImpl,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toBe("Failed to render URL: cancelled.");
    expect(kills.length).toBe(1);
  });

  it("refuses an empty url", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE);
    expect(await renderPageWithLightpanda("   ", { spawn: spawnImpl })).toBe("Blocked: the URL is empty.");
  });

  it("enforces the website policy before resolving", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda(PUBLIC_URL, {
      spawn: spawnImpl,
      websitePolicy: { allowedDomains: ["docs.example.com"], blockedDomains: [] },
    });
    expect(out).toBe("Blocked: the website access policy disallows example.com.");
    expect(calls).toEqual([]);
  });

  it("applies the policy to the final url", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE, { url: "https://other.example/landing" });
    const out = await renderPageWithLightpanda(PUBLIC_URL, {
      spawn: spawnImpl,
      websitePolicy: { allowedDomains: ["example.com"], blockedDomains: [] },
    });
    expect(out).toBe("Blocked: the website access policy disallows other.example.");
  });

  it("rejects unreadable renderer output", async () => {
    const { spawnImpl } = makeSpawn((call) => {
      if (call.args.at(-1) === "version") return { stdout: "1.0.4", code: 0 };
      return { stdout: "not json", code: 0 };
    });
    expect(await renderPageWithLightpanda(PUBLIC_URL, { spawn: spawnImpl })).toBe(
      "Failed to render URL: the local renderer returned unreadable output.",
    );
  });
});

describe("sameAddress", () => {
  it("falls back to string comparison when either url cannot be parsed", () => {
    expect(sameAddress("not a url", "not a url")).toBe(true);
    expect(sameAddress("not a url", "https://example.com/")).toBe(false);
    expect(sameAddress("https://example.com/", "not a url")).toBe(false);
  });

  it("compares the normalized hrefs", () => {
    expect(sameAddress("https://example.com", "https://example.com/")).toBe(true);
    expect(sameAddress("https://example.com:443/", "https://example.com/")).toBe(true);
    expect(sameAddress("https://example.com/page", "https://example.com/page/")).toBe(false);
  });
});

describe("renderPageHtml", () => {
  it("returns the raw html dump unchanged", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageHtml("https://example.com/search", { spawn: spawnImpl });
    expect(out).toBe(PUBLIC_PAGE);
    const fetchCall = calls.find((call) => call.args.includes("fetch"));
    expect(fetchCall?.args).toContain("--json");
  });

  it("returns null when no binary is available", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    expect(await renderPageHtml(PUBLIC_URL, { spawn: spawnImpl })).toBeNull();
  });

  it("returns null for blocked targets and empty dumps", async () => {
    const { spawnImpl, calls } = spawnRendering("");
    expect(await renderPageHtml("file:///tmp/page.html", { spawn: spawnImpl })).toBeNull();
    expect(
      await renderPageHtml(PUBLIC_URL, {
        spawn: spawnImpl,
        websitePolicy: { allowedDomains: ["docs.example.com"], blockedDomains: [] },
      }),
    ).toBeNull();
    expect(calls).toEqual([]);
    const empty = spawnRendering("");
    expect(await renderPageHtml(PUBLIC_URL, { spawn: empty.spawnImpl })).toBeNull();
  });
});

describe("renderPageHtmlOutcome", () => {
  it("reports the http status message for an error page", async () => {
    const { spawnImpl } = spawnRendering("<html><body>not found</body></html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
    expect(await renderPageHtmlOutcome("https://example.com/missing", { spawn: spawnImpl })).toEqual({
      ok: false,
      message: "Failed to fetch URL: HTTP 404 Not Found",
    });
  });

  it("returns null when no binary is available", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    expect(await renderPageHtmlOutcome(PUBLIC_URL, { spawn: spawnImpl })).toBeNull();
  });

  it("reports an empty dump as no readable text", async () => {
    const { spawnImpl } = spawnRendering("");
    expect(await renderPageHtmlOutcome(PUBLIC_URL, { spawn: spawnImpl })).toEqual({
      ok: false,
      message: "(page returned no readable text)",
    });
  });

  it("returns the trimmed html for a good page", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE);
    expect(await renderPageHtmlOutcome("https://example.com/search", { spawn: spawnImpl })).toEqual({
      ok: true,
      html: PUBLIC_PAGE,
    });
  });

  it("reports a bot challenge page", async () => {
    const { spawnImpl } = spawnRendering(
      "<html><head><title>DuckDuckGo</title></head><body><p>Unfortunately, bots use DuckDuckGo too.</p><p>Please complete the following challenge.</p></body></html>",
    );
    expect(await renderPageHtmlOutcome(PUBLIC_URL, { spawn: spawnImpl })).toEqual({
      ok: false,
      message: "Failed to render URL: the page served a bot challenge instead of content.",
    });
  });
});

describe("lightpandaBinary", () => {
  it("falls back to the launcher installed by the setup script", async () => {
    const previousDataHome = process.env.XDG_DATA_HOME;
    const root = await mkdtemp(join(tmpdir(), "pi-lightpanda-web-install-"));
    const installDir = join(root, "pi-lightpanda-web", "lightpanda");
    await mkdir(installDir, { recursive: true });
    process.env.XDG_DATA_HOME = root;
    delete process.env.PI_LIGHTPANDA_BIN;
    try {
      await writeFile(join(installDir, "lightpanda"), "#!/bin/sh\nexit 0\n");
      expect(lightpandaBinary({})).toBe(join(installDir, "lightpanda"));
      await writeFile(join(installDir, "lightpanda-run"), "#!/bin/sh\nexit 0\n");
      expect(lightpandaBinary({})).toBe(join(installDir, "lightpanda-run"));
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers the explicit path, then settings, then the environment", () => {
    process.env.PI_LIGHTPANDA_BIN = "/env/lightpanda";
    expect(lightpandaBinary({ binaryPath: "/explicit/lightpanda", settings: { enabled: true, binaryPath: "/settings/lightpanda", command: null } })).toBe(
      "/explicit/lightpanda",
    );
    expect(lightpandaBinary({ settings: { enabled: true, binaryPath: "/settings/lightpanda", command: null } })).toBe(
      "/settings/lightpanda",
    );
    expect(lightpandaBinary({})).toBe("/env/lightpanda");
    delete process.env.PI_LIGHTPANDA_BIN;
    expect(lightpandaBinary({})).not.toBe("/env/lightpanda");
  });
});

describe("launch command", () => {
  it("prefers an explicit command over a binary path", () => {
    expect(
      lightpandaLaunch({
        binaryPath: "/usr/bin/lightpanda",
        command: ["wsl.exe", "-e", "/home/u/.local/bin/lightpanda"],
      }),
    ).toEqual(["wsl.exe", "-e", "/home/u/.local/bin/lightpanda"]);
    expect(
      lightpandaLaunch({ settings: { enabled: true, binaryPath: null, command: ["docker", "run", "--rm", "lightpanda/browser:nightly"] } }),
    ).toEqual(["docker", "run", "--rm", "lightpanda/browser:nightly"]);
    expect(lightpandaLaunch({ settings: { enabled: true, binaryPath: "/opt/lp", command: null } })).toEqual(["/opt/lp"]);
    expect(lightpandaLaunch({ binaryPath: "/usr/bin/lightpanda" })).toEqual(["/usr/bin/lightpanda"]);
  });

  it("appends the fetch flags to a command prefix when rendering", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda("https://example.com/page", {
      command: ["wsl.exe", "-e", "/home/u/.local/bin/lightpanda"],
      spawn: spawnImpl,
    });
    expect(out).toContain("Readable body text here.");
    expect(calls[0].binary).toBe("wsl.exe");
    expect(calls[0].args).toEqual(["-e", "/home/u/.local/bin/lightpanda", "version"]);
    const fetchCall = calls.find((call) => call.args.includes("fetch"));
    expect(fetchCall?.args.slice(0, 3)).toEqual(["-e", "/home/u/.local/bin/lightpanda", "fetch"]);
    expect(fetchCall?.args.at(-1)).toBe("https://example.com/page");
  });

  it("returns null when the command cannot be started", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    const out = await renderPageWithLightpanda(PUBLIC_URL, {
      command: ["wsl.exe", "-e", "/missing/lightpanda"],
      spawn: spawnImpl,
    });
    expect(out).toBeNull();
  });
});
