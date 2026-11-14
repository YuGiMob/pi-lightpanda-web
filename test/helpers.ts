import type { LightpandaSpawn } from "../lightpanda.ts";
import { deflateSync } from "node:zlib";

export interface PdfLine {
  text: string;
  x?: number;
  y?: number;
  size?: number;
}

export function makePdf(
  pages: Array<string | string[] | PdfLine[]>,
  options: { encrypt?: boolean; flate?: boolean } = {},
): Buffer {
  const objects: string[] = [];
  const kids: string[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const pageNum = 3 + 4 * pi;
    const streamNum = 4 + 4 * pi;
    const rawLines = pages[pi];
    const lines: (string | PdfLine)[] = Array.isArray(rawLines) ? rawLines : [rawLines];
    const content = lines
      .map((entry, i) => {
        const line = typeof entry === "string" ? { text: entry } : entry;
        const x = line.x ?? 72;
        const y = line.y ?? 720 - i * 16;
        const size = line.size ?? 12;
        const font = size >= 20 ? "F2" : "F1";
        return `BT /${font} ${size} Tf ${x} ${y} Td (${line.text}) Tj ET`;
      })
      .join("\n");
    const raw = Buffer.from(content, "latin1");
    const streamBytes = options.flate === true ? deflateSync(raw) : raw;
    const filter = options.flate === true ? " /Filter /FlateDecode" : "";
    kids.push(`${pageNum} 0 R`);
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents ${streamNum} 0 R >>\nendobj`,
    );
    objects.push(
      `${streamNum} 0 obj\n<< /Length ${streamBytes.length}${filter} >>\nstream\n${streamBytes.toString("latin1")}\nendstream\nendobj`,
    );
  }
  objects.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj");
  objects.push("6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj");
  const encryptObj = options.encrypt
    ? "99 0 obj\n<< /Filter /Standard /V 2 /Length 128 >>\nendobj\n"
    : "";
  const encryptRef = options.encrypt ? " /Encrypt 99 0 R" : "";
  return Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>\nendobj\n` +
      objects.join("\n") +
      "\n" +
      encryptObj +
      `trailer\n<< /Root 1 0 R${encryptRef} >>\n%%EOF\n`,
    "latin1",
  );
}

export interface SpawnCall {
  binary: string;
  args: string[];
}

export interface SpawnSpec {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  errorCode?: string;
  neverClose?: boolean;
}

export function makeSpawn(handler: (call: SpawnCall) => SpawnSpec) {
  const calls: SpawnCall[] = [];
  const kills: string[] = [];
  const spawnImpl: LightpandaSpawn = (binary, args) => {
    const call = { binary, args };
    calls.push(call);
    const spec = handler(call);
    const listeners = new Map<string, ((value: unknown) => void)[]>();
    const emit = (event: string, value: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    };
    const child = {
      stdout: spec.neverClose
        ? null
        : (async function* () {
            if (spec.stdout !== undefined) yield Buffer.from(spec.stdout, "utf-8");
          })(),
      stderr: spec.neverClose
        ? null
        : (async function* () {
            if (spec.stderr !== undefined) yield Buffer.from(spec.stderr, "utf-8");
          })(),
      on(event: string, listener: (value: unknown) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return child;
      },
      kill() {
        kills.push(binary);
        if (spec.neverClose) queueMicrotask(() => emit("close", null));
        return true;
      },
    };
    if (spec.errorCode) {
      queueMicrotask(() =>
        emit("error", Object.assign(new Error(`spawn ${spec.errorCode}`), { code: spec.errorCode })),
      );
    } else if (!spec.neverClose) {
      queueMicrotask(() => emit("close", spec.code ?? 0));
    }
    return child as unknown as ReturnType<LightpandaSpawn>;
  };
  return { spawnImpl, calls, kills };
}

export function lightpandaJson(options: {
  content?: string;
  status?: number;
  url?: string;
  headers?: Record<string, string>;
  error?: string | null;
} = {}): string {
  const headers = Object.entries(options.headers ?? { "content-type": "text/html; charset=utf-8" }).map(
    ([name, value]) => ({ name, value }),
  );
  return JSON.stringify({
    url: options.url ?? "https://example.com/",
    http_status: options.status ?? 200,
    headers,
    content: options.content ?? "",
    error: options.error ?? null,
  });
}

export function spawnRendering(
  content: string,
  options: { status?: number; headers?: Record<string, string>; url?: string } = {},
) {
  return makeSpawn((call) => {
    if (call.args.at(-1) === "version") return { stdout: "1.0.4", code: 0 };
    return { stdout: lightpandaJson({ content, ...options }), code: 0 };
  });
}

export function spawnFailing(code: number, stderr = "") {
  return makeSpawn((call) => {
    if (call.args.at(-1) === "version") return { stdout: "1.0.4", code: 0 };
    return { stdout: "", stderr, code };
  });
}
