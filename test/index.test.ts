import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerExtension, { createWebTools } from "../index.ts";
import type { FetchPageOptions } from "../web-fetch.ts";
import type { WebSearchOptions } from "../web-search.ts";

function firstText(update: { content: { type: string; text?: string }[] }): string {
  return update.content[0]?.text ?? "";
}

function callText(component: { render(width: number): string[] } | undefined): string {
  return component?.render(80).join("\n") ?? "";
}

function makeHarness(): { tools: string[]; commands: string[]; handlers: string[] } {
  const tools: string[] = [];
  const commands: string[] = [];
  const handlers: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    on: (name: string) => handlers.push(name),
  } as unknown as ExtensionAPI;
  registerExtension(pi);
  return { tools, commands, handlers };
}

describe("extension registration", () => {
  it("registers the web tools and the search config command", () => {
    const harness = makeHarness();
    expect(harness.tools).toEqual(["web_search", "web_fetch"]);
    expect(harness.commands).toEqual(["search-config"]);
    expect(harness.handlers).toEqual([]);
  });
});

describe("web_search tool", () => {
  it("searches with maxResults and timeoutMs", async () => {
    const webSearch = vi.fn(
      async (_query: string | undefined, _options?: WebSearchOptions) => "results",
    );
    const { webSearchTool } = createWebTools({ webSearch });
    const result = await webSearchTool.execute(
      "id",
      { query: "llama", maxResults: 10, timeoutMs: 7000 },
      undefined,
      undefined,
      {} as never,
    );
    expect(webSearch).toHaveBeenCalledWith("llama", {
      signal: undefined,
      timeoutMs: 7000,
      maxResults: 10,
      cwd: undefined,
      engines: undefined,
      engineWeights: undefined,
      maxPerHost: undefined,
      allowPrivateAddresses: true,
      settings: { enabled: true, binaryPath: null, command: null },
    });
    expect(result.content[0]).toMatchObject({ type: "text", text: "results" });
  });
});

describe("web_fetch tool", () => {
  it("fetches with url and timeoutMs and reports progress", async () => {
    const fetchPageText = vi.fn(async (_url: string, _options?: FetchPageOptions) => "body");
    const { webFetchTool } = createWebTools({ fetchPageText });
    const updates: string[] = [];
    const result = await webFetchTool.execute(
      "id",
      { url: "https://example.com/", timeoutMs: 3000 },
      undefined,
      (update) => updates.push(firstText(update)),
      {} as never,
    );
    expect(fetchPageText).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({ timeoutMs: 3000 }),
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "body" });
    expect(updates).toEqual(["Fetching https://example.com/..."]);
  });

  it("drops a non-positive timeout and keeps the default", async () => {
    const fetchPageText = vi.fn(async (_url: string, _options?: FetchPageOptions) => "body");
    const { webFetchTool } = createWebTools({ fetchPageText });
    await webFetchTool.execute(
      "id",
      { url: "https://example.com/", timeoutMs: -5 },
      undefined,
      undefined,
      {} as never,
    );
    const options = fetchPageText.mock.calls[0][1] as FetchPageOptions;
    expect(options.timeoutMs).toBe(60000);
  });

  it("passes local access settings to the fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-lightpanda-idx-"));
    const previousEnv = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({
          webFetch: { allowPrivateAddresses: false, allowLocalFiles: false },
        }),
      );
      process.env.PI_CODING_AGENT_DIR = root;
      const fetchPageText = vi.fn(async (_url: string, _options?: FetchPageOptions) => "body");
      const { webFetchTool } = createWebTools({ fetchPageText });
      await webFetchTool.execute("id", { url: "https://example.com/" }, undefined, undefined, {} as never);
      expect(fetchPageText).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({
          allowPrivateAddresses: false,
          allowLocalFiles: false,
          allowRemotePdf: true,
        }),
      );
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes the configured lightpanda settings to both tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-lightpanda-idx-"));
    const previousEnv = process.env.PI_CODING_AGENT_DIR;
    try {
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({ webRender: { lightpandaPath: "/opt/lightpanda" } }),
      );
      process.env.PI_CODING_AGENT_DIR = root;
      const fetchPageText = vi.fn(async (_url: string, _options?: FetchPageOptions) => "body");
      const webSearch = vi.fn(async (_query: string | undefined, _options?: WebSearchOptions) => "results");
      const { webFetchTool, webSearchTool } = createWebTools({ fetchPageText, webSearch });
      await webFetchTool.execute("id", { url: "https://example.com/" }, undefined, undefined, {} as never);
      await webSearchTool.execute("id", { query: "q" }, undefined, undefined, {} as never);
      expect(fetchPageText.mock.calls[0][1]).toMatchObject({
        settings: { enabled: true, binaryPath: "/opt/lightpanda", command: null },
      });
      expect(webSearch.mock.calls[0][1]).toMatchObject({
        settings: { enabled: true, binaryPath: "/opt/lightpanda", command: null },
      });
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousEnv;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("tool call rendering", () => {
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;

  const { webSearchTool, webFetchTool } = createWebTools();

  it("shows the search query", () => {
    expect(callText(webSearchTool.renderCall?.({ query: "unsloth studio" }, plainTheme, {} as never))).toBe(
      'web_search "unsloth studio"',
    );
  });

  it("shows the fetched url", () => {
    expect(callText(webFetchTool.renderCall?.({ url: "https://example.com/" }, plainTheme, {} as never))).toBe(
      "web_fetch https://example.com/",
    );
  });

  it("collapses whitespace in the rendered target", () => {
    expect(callText(webFetchTool.renderCall?.({ url: "https://example.com/a\n  b" }, plainTheme, {} as never))).toBe(
      "web_fetch https://example.com/a b",
    );
  });

  it("styles the tool name and target", () => {
    const theme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => `**${text}**`,
    } as unknown as Theme;
    expect(callText(webSearchTool.renderCall?.({ query: "cats" }, theme, {} as never))).toBe(
      '[toolTitle]**web_search**[/toolTitle] [accent]"cats"[/accent]',
    );
  });

  it("falls back to the bare tool name without arguments", () => {
    expect(callText(webSearchTool.renderCall?.({}, plainTheme, {} as never))).toBe("web_search");
    expect(callText(webFetchTool.renderCall?.({ url: "" }, plainTheme, {} as never))).toBe("web_fetch");
  });

  it("truncates long targets to the render width", () => {
    const long = "q".repeat(200);
    const components = [
      webSearchTool.renderCall?.({ query: long }, plainTheme, {} as never),
      webFetchTool.renderCall?.({ url: `https://example.com/${long}` }, plainTheme, {} as never),
    ];
    for (const component of components) {
      const line = component?.render(40)[0] ?? "";
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
      expect(line).toContain("...");
    }
  });
});
