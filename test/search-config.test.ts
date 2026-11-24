import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSearchConfig, readSearchConfig, saveSearchConfig, toggleSearchConfig } from "../search-config.ts";
import { DEFAULT_ENGINE_NAMES } from "../engines.ts";

let root: string;
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lightpanda-search-config-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(async () => {
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  await rm(root, { recursive: true, force: true });
});

describe("search config reads", () => {
  it("defaults to the local Lightpanda engines", async () => {
    const config = await readSearchConfig();
    expect(config.engines).toEqual([...DEFAULT_ENGINE_NAMES]);
    expect(config.file).toBe(join(root, "agent", "settings.json"));
  });

  it("reads explicit values and reports the file that set them", async () => {
    const project = join(root, "project");
    const projectFile = join(project, ".pi", "settings.json");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(projectFile, JSON.stringify({ webSearch: { engines: ["yahoo", "ecosia"] } }));
    const config = await readSearchConfig(project);
    expect(config.engines).toEqual(["yahoo", "ecosia"]);
    expect(config.file).toBe(projectFile);
  });

  it("ignores unknown names and keeps the default sweep", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(file, JSON.stringify({ webSearch: { engines: ["nope"] } }));
    const config = await readSearchConfig();
    expect(config.engines).toEqual([...DEFAULT_ENGINE_NAMES]);
    expect(config.file).toBe(file);
  });

  it("dedupes repeated names", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(file, JSON.stringify({ webSearch: { engines: ["yep", "YEP", "yahoo"] } }));
    const config = await readSearchConfig();
    expect(config.engines).toEqual(["yep", "yahoo"]);
  });
});

describe("search config writes", () => {
  it("creates webSearch.engines in the global settings file", async () => {
    const config = await readSearchConfig();
    await saveSearchConfig(config.file, { engines: ["yep", "yahoo", "ecosia"] });
    const saved = JSON.parse(await readFile(config.file, "utf-8"));
    expect(saved).toEqual({ webSearch: { engines: ["yep", "yahoo", "ecosia"] } });
    const reread = await readSearchConfig();
    expect(reread.engines).toEqual(["yep", "yahoo", "ecosia"]);
  });

  it("preserves other settings and updates an existing engines list", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ theme: "dark", piLightpanda: { maxResults: 9, engines: ["yep"] } }),
    );
    await saveSearchConfig(file, { engines: ["yahoo"] });
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({
      theme: "dark",
      piLightpanda: { maxResults: 9, engines: ["yahoo"] },
    });
  });

  it("writes to the project file when it overrides search settings", async () => {
    const project = join(root, "project");
    const projectFile = join(project, ".pi", "settings.json");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(projectFile, JSON.stringify({ webSearch: { engines: ["yep"] } }));
    const config = await readSearchConfig(project);
    await saveSearchConfig(config.file, { engines: ["yep", "ecosia"] });
    expect(JSON.parse(await readFile(projectFile, "utf-8"))).toEqual({
      webSearch: { engines: ["yep", "ecosia"] },
    });
  });

  it("refuses to overwrite a settings file that is not valid JSON", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(file, "not json");
    await expect(saveSearchConfig(file, { engines: ["yep"] })).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("not json");
  });
});

describe("search config toggles", () => {
  it("enables and disables engines", () => {
    const draft = { engines: new Set(["yep", "yahoo"]) };
    expect(toggleSearchConfig(draft, "ecosia", "on")).toBe(true);
    expect([...draft.engines]).toEqual(["yep", "yahoo", "ecosia"]);
    expect(toggleSearchConfig(draft, "yahoo", "off")).toBe(true);
    expect([...draft.engines]).toEqual(["yep", "ecosia"]);
  });

  it("refuses to turn off the last engine", () => {
    const draft = { engines: new Set(["yep"]) };
    expect(toggleSearchConfig(draft, "yep", "off")).toBe(false);
    expect([...draft.engines]).toEqual(["yep"]);
  });

  it("resets to the shipped defaults", () => {
    const draft = { engines: new Set(["ecosia"] ) };
    expect(toggleSearchConfig(draft, "reset", "defaults")).toBe(true);
    expect([...draft.engines]).toEqual([...DEFAULT_ENGINE_NAMES]);
  });
});

describe("search config command", () => {
  it("requires interactive mode", async () => {
    const notify = vi.fn();
    await openSearchConfig({ mode: "json", cwd: root, ui: { notify } } as never);
    expect(notify).toHaveBeenCalledWith("/search-config requires interactive mode", "error");
  });

  it("renders the engines", async () => {
    let rendered = "";
    const custom = async (
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: unknown) => void,
      ) => unknown,
    ) => {
      const component = factory(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        () => {},
      ) as { render(width: number): string[] };
      rendered = component.render(80).join("\n");
    };
    await openSearchConfig({ mode: "tui", cwd: root, ui: { custom, notify: () => {} } } as never);
    expect(rendered).toMatch(/Yep\s+on/);
    expect(rendered).toMatch(/Brave\s+on/);
    expect(rendered).toMatch(/Yahoo\s+off/);
    expect(rendered).toMatch(/Ecosia\s+off/);
  });
});
