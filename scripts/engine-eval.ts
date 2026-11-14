import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  TEXT_ENGINES,
  ResultsAggregator,
  autoTextSearch,
  canonicalizeHref,
  capByHost,
  registrableDomain,
  type SearchRenderPage,
  type SearchResult,
} from "../engines.ts";
import { renderPageHtml } from "../lightpanda.ts";

interface GoldenQuery {
  query: string;
  expectedDomains: string[];
  specificTerms: string[];
}

interface EngineRun {
  query: string;
  engine: string;
  results: SearchResult[];
  ms: number;
  error: string;
}

const GOLDEN_QUERIES: GoldenQuery[] = [
  { query: "unsloth studio", expectedDomains: ["unsloth.ai", "github.com"], specificTerms: ["unsloth"] },
  { query: "pgvector hnsw index tuning", expectedDomains: ["github.com", "postgresql.org", "tembo.io", "timescale.com", "crunchydata.com"], specificTerms: ["hnsw"] },
  { query: "python 3.14 release notes", expectedDomains: ["python.org"], specificTerms: ["3.14", "314"] },
  { query: "attention is all you need paper", expectedDomains: ["arxiv.org", "neurips.cc"], specificTerms: ["attention"] },
  { query: "postgres could not serialize access due to concurrent update", expectedDomains: ["postgresql.org"], specificTerms: ["serialize"] },
  { query: "linux io_uring explained", expectedDomains: ["kernel.dk", "kernel.org", "lwn.net", "man7.org"], specificTerms: ["io_uring", "io-uring", "iouring"] },
  { query: "react server components explained", expectedDomains: ["react.dev", "github.com", "nextjs.org"], specificTerms: ["server component", "server-component", "server_components", "rsc"] },
  { query: "sqlite wal mode concurrency", expectedDomains: ["sqlite.org", "github.com"], specificTerms: ["wal"] },
];

const args = process.argv.slice(2);
const numberFlag = (name: string, fallback: number): number => {
  const found = args.find((arg) => arg.startsWith(`${name}=`));
  const value = found ? Number(found.split("=")[1]) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const stringFlag = (name: string): string => args.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1] ?? "";
const DELAY_MS = numberFlag("--delay", 1500);
const TIMEOUT_MS = numberFlag("--timeout", 60_000);
const MAX_RESULTS = numberFlag("--max", 5);
const CACHE_PATH = stringFlag("--cache");
const DETAILS = args.includes("--details");
const engineNames = (stringFlag("--engines") || "bing,brave,yahoo,ecosia")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter((name) => TEXT_ENGINES.some((engine) => engine.name === name));

const binary = process.env.PI_LIGHTPANDA_E2E_BIN?.trim() || process.env.PI_LIGHTPANDA_BIN?.trim() || null;
const renderPage: SearchRenderPage = (url, options) =>
  renderPageHtml(url, {
    binaryPath: binary,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    allowPrivateAddresses: true,
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pad = (value: string | number, width: number) => String(value).padEnd(width);
const padStart = (value: string | number, width: number) => String(value).padStart(width);

function matchesExpected(href: string, expectedDomains: string[]): boolean {
  const domain = registrableDomain(href);
  return expectedDomains.some((expected) => domain === expected || domain.endsWith(`.${expected}`));
}

function precision(results: SearchResult[], golden: GoldenQuery): number {
  const top = results.slice(0, MAX_RESULTS);
  if (!top.length) return 0;
  return top.filter((result) => matchesExpected(result.href, golden.expectedDomains)).length / top.length;
}

function specificity(results: SearchResult[], golden: GoldenQuery): number {
  const top = results.slice(0, MAX_RESULTS);
  if (!top.length) return 0;
  return top.filter((result) => {
    const haystack = `${result.href} ${result.title} ${result.body}`.toLowerCase();
    return golden.specificTerms.some((term) => haystack.includes(term));
  }).length / top.length;
}

function loadCache(path: string): EngineRun[] | null {
  if (!path || !existsSync(path)) return null;
  try {
    const rows = JSON.parse(readFileSync(path, "utf8")) as EngineRun[];
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function saveCache(path: string, rows: EngineRun[]): void {
  writeFileSync(path, JSON.stringify(rows));
}

async function runEngine(engine: string, query: string): Promise<EngineRun> {
  const started = Date.now();
  try {
    const results = await autoTextSearch(query, MAX_RESULTS, TIMEOUT_MS, undefined, {
      engines: [engine],
      renderPage,
    });
    return { query, engine, results, ms: Date.now() - started, error: "" };
  } catch (error) {
    return {
      query,
      engine,
      results: [],
      ms: Date.now() - started,
      error: String((error as Error)?.message ?? error).slice(0, 60),
    };
  }
}

function fuse(rows: EngineRun[], names: string[], query: string): SearchResult[] {
  const aggregator = new ResultsAggregator();
  for (const name of names) {
    const row = rows.find((candidate) => candidate.engine === name && candidate.query === query);
    aggregator.extend(row?.results ?? []);
  }
  return capByHost(aggregator.ranked(), MAX_RESULTS, 0);
}

console.log(
  `engines=${engineNames.join(", ")} queries=${GOLDEN_QUERIES.length} max=${MAX_RESULTS} timeout=${TIMEOUT_MS}ms delay=${DELAY_MS}ms`,
);
console.log("labels are hand-set developer queries; treat single-run numbers as directional\n");

let rows = loadCache(CACHE_PATH);
if (rows) {
  console.log(`loaded ${rows.length} cached engine runs from ${CACHE_PATH}\n`);
} else {
  rows = [];
  for (const golden of GOLDEN_QUERIES) {
    for (const engine of engineNames) {
      if (DELAY_MS) await sleep(DELAY_MS);
      const run = await runEngine(engine, golden.query);
      rows.push(run);
      process.stdout.write(
        `${pad(engine, 10)} ${pad(`"${golden.query}"`, 62)} ${padStart(run.results.length, 2)} results ${padStart(run.ms, 6)}ms ${run.error}\n`,
      );
    }
  }
  if (CACHE_PATH) saveCache(CACHE_PATH, rows);
}

const rowsFor = (engine: string, query: string) => rows.find((row) => row.engine === engine && row.query === query);

console.log(`\n=== per-engine (top ${MAX_RESULTS} vs expected domains) ===`);
console.log(
  `${pad("engine", 10)} ${padStart("results", 7)} ${padStart("median ms", 9)} ${padStart("p@" + MAX_RESULTS, 5)} ${padStart("topic@" + MAX_RESULTS, 8)} ${padStart("failures", 8)}`,
);
for (const engine of engineNames) {
  const all = GOLDEN_QUERIES.map((golden) => rowsFor(engine, golden.query) ?? { results: [], ms: 0, error: "missing" });
  const times = all.map((run) => run.ms).sort((a, b) => a - b);
  const meanPrecision =
    GOLDEN_QUERIES.reduce((sum, golden) => sum + precision(rowsFor(engine, golden.query)?.results ?? [], golden), 0) /
    GOLDEN_QUERIES.length;
  const meanSpecificity =
    GOLDEN_QUERIES.reduce((sum, golden) => sum + specificity(rowsFor(engine, golden.query)?.results ?? [], golden), 0) /
    GOLDEN_QUERIES.length;
  const failures = all.filter((run) => run.error || run.results.length === 0).length;
  console.log(
    `${pad(engine, 10)} ${padStart(all.reduce((sum, run) => sum + run.results.length, 0), 7)} ${padStart(times[Math.floor(times.length / 2)] ?? 0, 9)} ${padStart(meanPrecision.toFixed(2), 5)} ${padStart(meanSpecificity.toFixed(2), 8)} ${padStart(failures, 8)}`,
  );
}

console.log("\n=== pairwise URL overlap (mean Jaccard, top 5) ===");
console.log(`${pad("", 10)} ${engineNames.map((name) => padStart(name, 10)).join(" ")}`);
for (const left of engineNames) {
  const row = engineNames.map((right) => {
    if (left === right) return padStart("-", 10);
    let sum = 0;
    let counted = 0;
    for (const golden of GOLDEN_QUERIES) {
      const a = rowsFor(left, golden.query)?.results ?? [];
      const b = rowsFor(right, golden.query)?.results ?? [];
      if (!a.length || !b.length) continue;
      const leftSet = new Set(a.slice(0, MAX_RESULTS).map((result) => canonicalizeHref(result.href) || result.href));
      const rightSet = new Set(b.slice(0, MAX_RESULTS).map((result) => canonicalizeHref(result.href) || result.href));
      const union = new Set([...leftSet, ...rightSet]);
      const shared = [...leftSet].filter((href) => rightSet.has(href)).length;
      sum += union.size ? shared / union.size : 0;
      counted++;
    }
    return padStart((counted ? sum / counted : 0).toFixed(2), 10);
  });
  console.log(`${pad(left, 10)} ${row.join(" ")}`);
}

console.log("\n=== unique contribution (URLs no other evaluated engine returned) ===");
for (const engine of engineNames) {
  let unique = 0;
  let total = 0;
  let uniqueExpected = 0;
  for (const golden of GOLDEN_QUERIES) {
    const others = new Set(
      engineNames
        .filter((name) => name !== engine)
        .flatMap((name) =>
          (rowsFor(name, golden.query)?.results ?? []).map((result) => canonicalizeHref(result.href) || result.href),
        ),
    );
    for (const result of rowsFor(engine, golden.query)?.results ?? []) {
      total++;
      const key = canonicalizeHref(result.href) || result.href;
      if (!others.has(key)) {
        unique++;
        if (matchesExpected(result.href, golden.expectedDomains)) uniqueExpected++;
      }
    }
  }
  console.log(`${pad(engine, 10)} ${padStart(unique, 3)}/${padStart(total, 3)} unique   ${padStart(uniqueExpected, 3)} of them expected-domain hits`);
}

const SUBSETS: { name: string; engines: string[] }[] = [
  { name: "all four", engines: ["bing", "brave", "yahoo", "ecosia"] },
  { name: "bing+brave+ecosia", engines: ["bing", "brave", "ecosia"] },
  { name: "brave+yahoo+ecosia", engines: ["brave", "yahoo", "ecosia"] },
  { name: "brave+ecosia", engines: ["brave", "ecosia"] },
  { name: "bing+yahoo+ecosia", engines: ["bing", "yahoo", "ecosia"] },
].filter((subset) => subset.engines.every((name) => engineNames.includes(name)));

console.log(`\n=== fusion simulation (top ${MAX_RESULTS}) ===`);
console.log(`${pad("engines", 22)} ${padStart("mean p@" + MAX_RESULTS, 9)} ${padStart("topic@" + MAX_RESULTS, 9)} ${padStart("domains", 8)}  engine mix`);
for (const subset of SUBSETS) {
  let precisionSum = 0;
  let specificitySum = 0;
  let domainSum = 0;
  const mix = new Map<string, number>(subset.engines.map((name) => [name, 0]));
  for (const golden of GOLDEN_QUERIES) {
    const fused = fuse(rows, subset.engines, golden.query);
    precisionSum += precision(fused, golden);
    specificitySum += specificity(fused, golden);
    domainSum += new Set(fused.map((result) => registrableDomain(result.href))).size;
    for (const result of fused) {
      const owner = subset.engines.find((name) =>
        (rowsFor(name, golden.query)?.results ?? []).some(
          (candidate) => (canonicalizeHref(candidate.href) || candidate.href) === result.href,
        ),
      );
      if (owner) mix.set(owner, (mix.get(owner) ?? 0) + 1);
    }
  }
  const mixText = subset.engines.map((name) => `${name.slice(0, 5)}:${mix.get(name)}`).join(" ");
  console.log(
    `${pad(subset.name, 22)} ${padStart((precisionSum / GOLDEN_QUERIES.length).toFixed(2), 9)} ${padStart((specificitySum / GOLDEN_QUERIES.length).toFixed(2), 9)} ${padStart((domainSum / GOLDEN_QUERIES.length).toFixed(1), 8)}  ${mixText}`,
  );
}

if (DETAILS) {
  console.log(`\n=== per-query top ${MAX_RESULTS} ===`);
  for (const golden of GOLDEN_QUERIES) {
    console.log(`\n## ${golden.query}`);
    for (const engine of engineNames) {
      const run = rowsFor(engine, golden.query);
      console.log(`${engine}: ${run?.error || `${run?.results.length ?? 0} results`}`);
      for (const result of (run?.results ?? []).slice(0, MAX_RESULTS)) {
        console.log(`  ${pad(registrableDomain(result.href), 22)} ${result.href}`);
      }
    }
  }
}
