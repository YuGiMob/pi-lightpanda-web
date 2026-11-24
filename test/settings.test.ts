import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadDefaultEngineWeights,
  loadDefaultEngines,
  loadDefaultFetchSettings,
  loadDefaultMaxPerHost,
  loadDefaultMaxResults,
  loadDefaultSearchTimeoutMs,
  loadLightpandaSettings,
} from "../settings.ts";

let root: string;
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lightpanda-settings-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(async () => {
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  await rm(root, { recursive: true, force: true });
});

describe("fetch settings", () => {
  it("defaults both local-access flags to true and leaves limits unset", async () => {
    expect(await loadDefaultFetchSettings()).toEqual({
      timeoutMs: undefined,
      allowPrivateAddresses: true,
      allowLocalFiles: true,
      allowRemotePdf: true,
    });
  });

  it("reads global and project settings with project override", async () => {
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        webFetch: { timeoutMs: 5000, allowPrivateAddresses: false, allowLocalFiles: false },
      }),
    );
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ webFetch: { allowPrivateAddresses: true, timeoutMs: 9000 } }),
    );
    expect(await loadDefaultFetchSettings(cwd)).toEqual({
      timeoutMs: 9000,
      allowPrivateAddresses: true,
      allowLocalFiles: false,
      allowRemotePdf: true,
    });
  });

  it("ignores an invalid timeout", async () => {
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "settings.json"), JSON.stringify({ webFetch: { timeoutMs: 10 } }));
    const settings = await loadDefaultFetchSettings();
    expect(settings.timeoutMs).toBeUndefined();
  });
});

describe("search settings", () => {
  it("defaults to unset engines and reads a project override", async () => {
    expect(await loadDefaultMaxResults()).toBe(5);
    expect(await loadDefaultEngines()).toBeUndefined();
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        webSearch: {
          engines: ["yep", "yahoo"],
          maxResults: 9,
          engineWeights: { yep: 2, yahoo: 0.5, bad: -1 },
          maxPerHost: 3,
        },
      }),
    );
    expect(await loadDefaultMaxResults(cwd)).toBe(9);
    expect(await loadDefaultEngines(cwd)).toEqual(["yep", "yahoo"]);
    expect(await loadDefaultEngineWeights(cwd)).toEqual({ yep: 2, yahoo: 0.5 });
    expect(await loadDefaultMaxPerHost(cwd)).toBe(3);
  });

  it("clamps maxResults to 1..20", async () => {
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "settings.json"), JSON.stringify({ webSearch: { maxResults: 99 } }));
    expect(await loadDefaultMaxResults()).toBe(20);
    await writeFile(join(agent, "settings.json"), JSON.stringify({ webSearch: { maxResults: 0 } }));
    expect(await loadDefaultMaxResults()).toBe(1);
  });
});

describe("lightpanda settings", () => {
  it("defaults the renderer on with no configured path", async () => {
    expect(await loadLightpandaSettings()).toEqual({ enabled: true, binaryPath: null, command: null });
  });

  it("reads the remote PDF exception with project override", async () => {
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "settings.json"), JSON.stringify({ webFetch: { allowRemotePdf: false } }));
    expect((await loadDefaultFetchSettings()).allowRemotePdf).toBe(false);
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ webFetch: { allowRemotePdf: true } }));
    expect((await loadDefaultFetchSettings(cwd)).allowRemotePdf).toBe(true);
  });

  it("reads path, command and toggle with project override", async () => {
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        webRender: {
          lightpandaPath: "/opt/lightpanda",
          lightpandaCommand: ["wsl.exe", "-e", "/home/u/lp", 42, "", "  "],
          lightpandaEnabled: true,
        },
      }),
    );
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ webRender: { lightpandaEnabled: false } }));
    expect(await loadLightpandaSettings(cwd)).toEqual({
      enabled: false,
      binaryPath: "/opt/lightpanda",
      command: ["wsl.exe", "-e", "/home/u/lp"],
    });
  });

  it("leaves a non-list command unset", async () => {
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({ webRender: { lightpandaCommand: "wsl.exe -e /home/u/lp" } }),
    );
    expect((await loadLightpandaSettings()).command).toBeNull();
  });
});

describe("search timeout settings", () => {
  it("reads both search timeout keys with project override", async () => {
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({ piLightpanda: { searchTimeoutMs: 120000 }, webSearch: { timeoutMs: 60000 } }),
    );
    expect(await loadDefaultSearchTimeoutMs()).toBe(120000);
    await writeFile(join(agent, "settings.json"), JSON.stringify({ webSearch: { timeoutMs: 60000 } }));
    expect(await loadDefaultSearchTimeoutMs()).toBe(60000);
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ webSearch: { timeoutMs: 240000 } }),
    );
    expect(await loadDefaultSearchTimeoutMs(cwd)).toBe(240000);
  });

  it("ignores values below 1000 and returns undefined when unset", async () => {
    expect(await loadDefaultSearchTimeoutMs()).toBeUndefined();
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "settings.json"), JSON.stringify({ webSearch: { timeoutMs: 999 } }));
    expect(await loadDefaultSearchTimeoutMs()).toBeUndefined();
    await writeFile(join(agent, "settings.json"), JSON.stringify({ piLightpanda: { searchTimeoutMs: 1000 } }));
    expect(await loadDefaultSearchTimeoutMs()).toBe(1000);
  });
});
