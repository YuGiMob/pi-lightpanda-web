import { collapseWhitespace, decodeHtmlEntities, feedHtml } from "./html-to-md.ts";
import type { AttrDict } from "./html-to-md.ts";
import type { WebsitePolicy } from "./web-access.ts";

export class EmptySweepError extends Error {
  constructor() {
    super("No results found");
  }
}

export class SearchTimeoutError extends Error {
  providers: string[];
  constructor(providers: string[] = []) {
    super("timed out");
    this.providers = providers;
  }
}

export class SearchCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export class SearchRenderError extends Error {
  failures: Record<string, string>;
  detail: string;
  constructor(failures: Record<string, string> = {}, detail = "") {
    super("render failed");
    this.failures = failures;
    this.detail = detail;
  }
}

export interface SearchResult {
  title: string;
  href: string;
  body: string;
}

const STRIP_TAGS_RE = /<.*?>/g;

export function normalizeText(raw: string): string {
  if (!raw) return "";
  let text = raw.replace(STRIP_TAGS_RE, "");
  text = decodeHtmlEntities(text);
  text = text.normalize("NFC");
  text = text.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/gu, "");
  return collapseWhitespace(text);
}

export function normalizeUrl(url: string): string {
  if (!url) return "";
  try {
    return decodeURIComponent(url).replace(/ /g, "+");
  } catch {
    return url.replace(/ /g, "+");
  }
}

const TRACKING_PARAM_NAMES = new Set([
  "_hsenc",
  "_hsmi",
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "gclsrc",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "srsltid",
  "twclid",
  "wbraid",
  "yclid",
]);

export function canonicalizeHref(href: string): string {
  if (!href) return "";
  try {
    const url = new URL(href);
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    return url.toString();
  } catch {
    return href;
  }
}

export interface DomNode {
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  textNodes: string[];
}

export function buildDom(html: string): DomNode {
  const root: DomNode = { tag: "#root", attrs: {}, children: [], textNodes: [] };
  const stack: DomNode[] = [root];
  const pushText = (text: string) => {
    for (const el of stack) el.textNodes.push(text);
  };
  feedHtml(html, {
    handleStartTag(name: string, attrs: AttrDict) {
      const el: DomNode = {
        tag: name,
        attrs: Object.fromEntries(
          Object.entries(attrs).map(([key, value]) => [key, value ?? ""]),
        ),
        children: [],
        textNodes: [],
      };
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    },
    handleStartEndTag() {},
    handleEndTag(name: string) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          return;
        }
      }
    },
    handleData(text: string) {
      pushText(text);
    },
    handleEntityRef(name: string) {
      pushText(decodeHtmlEntities(`&${name};`));
    },
    handleCharRef(name: string) {
      pushText(decodeHtmlEntities(`&#${name};`));
    },
  });
  return root;
}

type Pred =
  | { op: "or"; a: Pred; b: Pred }
  | { op: "and"; a: Pred; b: Pred }
  | { op: "last" }
  | { op: "class-contains"; value: string }
  | { op: "attr-eq"; name: string; value: string }
  | { op: "has-attr"; name: string }
  | { op: "desc"; tag: string }
  | { op: "child"; tag: string; preds: Pred[] };

interface XStep {
  axis: "descendant" | "child";
  name?: string;
  preds: Pred[];
  terminal?: "text" | string;
}

function parsePredicateBlocks(input: string, start: number): { preds: Pred[]; next: number } {
  const preds: Pred[] = [];
  let pos = start;
  while (pos < input.length && input[pos] === "[") {
    const innerStart = pos + 1;
    let depth = 1;
    let quote: string | null = null;
    let j = innerStart;
    while (j < input.length && depth) {
      const c = input[j];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "[") {
        depth++;
      } else if (c === "]") {
        depth--;
      }
      j++;
    }
    preds.push(parsePredExpr(input.slice(innerStart, j - 1)));
    pos = j;
  }
  return { preds, next: pos };
}

function parsePredExpr(input: string): Pred {
  let pos = 0;
  const ws = () => {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
  };
  const word = () => {
    ws();
    const m = /^[A-Za-z][A-Za-z0-9_-]*/.exec(input.slice(pos));
    if (!m) throw new Error(`bad predicate: ${input}`);
    pos += m[0].length;
    return m[0];
  };
  const quoted = () => {
    ws();
    const quote = input[pos];
    if (quote !== "'" && quote !== '"') throw new Error(`bad predicate quote: ${input}`);
    pos++;
    const end = input.indexOf(quote, pos);
    if (end === -1) throw new Error(`bad predicate quote: ${input}`);
    const value = input.slice(pos, end);
    pos = end + 1;
    return value;
  };
  const atom = (): Pred => {
    ws();
    if (input[pos] === "(") {
      pos++;
      const inner = parseOr();
      ws();
      if (input[pos] !== ")") throw new Error(`bad predicate paren: ${input}`);
      pos++;
      return inner;
    }
    if (input.startsWith("position()=last()", pos)) {
      pos += "position()=last()".length;
      return { op: "last" };
    }
    if (input.startsWith("last()", pos)) {
      pos += "last()".length;
      return { op: "last" };
    }
    if (input.startsWith("contains(@class,", pos)) {
      pos += "contains(@class,".length;
      const value = quoted();
      ws();
      if (input[pos] !== ")") throw new Error(`bad predicate contains: ${input}`);
      pos++;
      return { op: "class-contains", value };
    }
    if (input[pos] === "@") {
      pos++;
      const name = word();
      ws();
      if (input[pos] === "=") {
        pos++;
        const value = quoted();
        return { op: "attr-eq", name, value };
      }
      return { op: "has-attr", name };
    }
    if (input.startsWith(".//", pos)) {
      pos += 3;
      const name = word();
      return { op: "desc", tag: name };
    }
    if (input.startsWith("./", pos)) {
      pos += 2;
      const name = word();
      const { preds, next } = parsePredicateBlocks(input, pos);
      pos = next;
      return { op: "child", tag: name, preds };
    }
    const name = word();
    const { preds, next } = parsePredicateBlocks(input, pos);
    pos = next;
    return { op: "child", tag: name, preds };
  };
  const parseAnd = (): Pred => {
    let left = atom();
    while (true) {
      ws();
      if (input.startsWith("and", pos) && !/[A-Za-z0-9_]/.test(input[pos + 3] ?? "")) {
        pos += 3;
        left = { op: "and", a: left, b: atom() };
      } else {
        return left;
      }
    }
  };
  const parseOr = (): Pred => {
    let left = parseAnd();
    while (true) {
      ws();
      if (input.startsWith("or", pos) && !/[A-Za-z0-9_]/.test(input[pos + 2] ?? "")) {
        pos += 2;
        left = { op: "or", a: left, b: parseAnd() };
      } else {
        return left;
      }
    }
  };
  return parseOr();
}

function parsePath(expr: string): XStep[] {
  const steps: XStep[] = [];
  let i = 0;
  let axis: "child" | "descendant" = "child";
  if (expr.startsWith("//")) {
    axis = "descendant";
    i = 2;
  } else if (expr.startsWith("./")) {
    i = 2;
    if (expr[i] === "/") {
      axis = "descendant";
      i++;
    }
  }
  while (i < expr.length) {
    if (expr[i] === "/") {
      if (expr[i + 1] === "/") {
        axis = "descendant";
        i += 2;
      } else {
        axis = "child";
        i++;
      }
      continue;
    }
    if (expr[i] === ".") {
      i++;
      continue;
    }
    if (expr[i] === "@") {
      i++;
      const m = /^[A-Za-z0-9_-]+/.exec(expr.slice(i));
      steps.push({ axis, preds: [], terminal: m ? m[0] : "" });
      i += m ? m[0].length : 0;
      continue;
    }
    if (expr.startsWith("text()", i)) {
      steps.push({ axis, preds: [], terminal: "text" });
      i += 6;
      continue;
    }
    const m = /^[A-Za-z][A-Za-z0-9_-]*/.exec(expr.slice(i));
    if (!m) break;
    const name = m[0];
    i += m[0].length;
    const { preds, next } = parsePredicateBlocks(expr, i);
    i = next;
    steps.push({ axis, name, preds });
  }
  return steps;
}

function descendantsOf(el: DomNode): DomNode[] {
  const out: DomNode[] = [];
  const walk = (node: DomNode) => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

function matchesPred(pred: Pred, el: DomNode, index: number, total: number): boolean {
  switch (pred.op) {
    case "or":
      return matchesPred(pred.a, el, index, total) || matchesPred(pred.b, el, index, total);
    case "and":
      return matchesPred(pred.a, el, index, total) && matchesPred(pred.b, el, index, total);
    case "last":
      return index === total - 1;
    case "class-contains":
      return (el.attrs["class"] ?? "").includes(pred.value);
    case "attr-eq":
      return el.attrs[pred.name] === pred.value;
    case "has-attr":
      return pred.name in el.attrs;
    case "desc":
      return el.tag === pred.tag || descendantsOf(el).some((d) => d.tag === pred.tag);
    case "child":
      return el.children.some(
        (c) => c.tag === pred.tag && pred.preds.every((p) => matchesPred(p, c, 0, 1)),
      );
  }
}

function predContainsLast(pred: Pred): boolean {
  switch (pred.op) {
    case "last":
      return true;
    case "or":
    case "and":
      return predContainsLast(pred.a) || predContainsLast(pred.b);
    case "child":
      return pred.preds.some(predContainsLast);
    default:
      return false;
  }
}

function applyStep(step: XStep, nodes: DomNode[]): DomNode[] {
  if (step.preds.some(predContainsLast)) {
    const out: DomNode[] = [];
    const seen = new Set<DomNode>();
    for (const node of nodes) {
      const source = step.axis === "child" ? node.children : descendantsOf(node);
      const list = source.filter((c) => !step.name || c.tag === step.name);
      const total = list.length;
      list.forEach((el, index) => {
        if (seen.has(el)) return;
        if (step.preds.every((p) => matchesPred(p, el, index, total))) {
          seen.add(el);
          out.push(el);
        }
      });
    }
    return out;
  }
  const candidates: DomNode[] = [];
  for (const node of nodes) {
    const list = step.axis === "child" ? node.children : descendantsOf(node);
    for (const c of list) {
      if (step.name && c.tag !== step.name) continue;
      candidates.push(c);
    }
  }
  const deduped: DomNode[] = [];
  const seen = new Set<DomNode>();
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      deduped.push(c);
    }
  }
  const total = deduped.length;
  return deduped.filter((el, index) => step.preds.every((p) => matchesPred(p, el, index, total)));
}

export function xpathText(expr: string, node: DomNode): string[] {
  const steps = parsePath(expr);
  let nodes: DomNode[] = [node];
  for (const step of steps) {
    if (step.terminal === "text") {
      const out: string[] = [];
      for (const n of nodes) out.push(...n.textNodes);
      return out;
    }
    if (step.terminal !== undefined) {
      return nodes.map((n) => n.attrs[step.terminal as string] ?? "");
    }
    nodes = applyStep(step, nodes);
  }
  return [];
}

export function xpathNodes(expr: string, root: DomNode): DomNode[] {
  const steps = parsePath(expr);
  let nodes: DomNode[] = [root];
  for (const step of steps) {
    if (step.terminal) break;
    nodes = applyStep(step, nodes);
  }
  return nodes;
}

export function extractResults(
  html: string,
  itemsXpath: string,
  elementsXpath: { title: string; href: string; body: string },
): SearchResult[] {
  const root = buildDom(html);
  const items = xpathNodes(itemsXpath, root);
  const results: SearchResult[] = [];
  for (const item of items) {
    const result: SearchResult = { title: "", href: "", body: "" };
    const entries = [
      ["title", elementsXpath.title],
      ["href", elementsXpath.href],
      ["body", elementsXpath.body],
    ] as const;
    for (const [key, value] of entries) {
      const data = collapseWhitespace(xpathText(value, item).join(""));
      if (!data) continue;
      result[key] = key === "href" ? normalizeUrl(data) : normalizeText(data);
    }
    if (!result.title && !result.href && !result.body) continue;
    results.push(result);
  }
  return results;
}

export type SearchRenderOutcome = string | { error: string } | null;
export type SearchRenderPage = (
  url: string,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    websitePolicy?: WebsitePolicy | null;
    allowPrivateAddresses?: boolean;
  },
) => Promise<SearchRenderOutcome>;

export interface SearchEngineOptions {
  policy?: WebsitePolicy | null;
  engines?: string[];
  engineWeights?: Record<string, number>;
  maxPerHost?: number;
  renderPage?: SearchRenderPage;
  allowPrivateAddresses?: boolean;
}

export interface EngineContext extends SearchEngineOptions {
  region: string;
  safesearch: string;
  maxResults?: number;
}

export interface Engine {
  name: string;
  provider: string;
  render(
    query: string,
    ctx: EngineContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[] | { error: string } | null>;
}

function searchUrl(url: string, params: Record<string, string>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

async function renderPageHtml(
  url: string,
  ctx: EngineContext,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string | { error: string } | null> {
  if (!ctx.renderPage) return null;
  return ctx.renderPage(url, {
    timeoutMs,
    signal,
    websitePolicy: ctx.policy ?? null,
    allowPrivateAddresses: ctx.allowPrivateAddresses,
  });
}

async function renderEnginePage(
  url: string,
  ctx: EngineContext,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  parse: (html: string) => SearchResult[],
): Promise<SearchResult[] | { error: string } | null> {
  const outcome = await renderPageHtml(url, ctx, timeoutMs, signal);
  if (typeof outcome === "string") return parse(outcome);
  return outcome;
}

function isRenderFailure(value: SearchResult[] | { error: string } | null): value is { error: string } {
  return value !== null && !Array.isArray(value);
}

const BRAVE_CLOAK_PREFIX = "https://search.brave.com/go/v1#";
const BRAVE_CLOAK_PAGE = "https://search.brave.com/go/v1/";
const BRAVE_RESOLVE_TIMEOUT_MS = 8_000;
const BRAVE_RESOLVE_CONCURRENCY = 4;
const BRAVE_RESOLVE_SLACK = 3;

interface BraveHit {
  title: string;
  body: string;
  href: string;
  citeHref: string;
  token: string;
}

function firstText(values: string[]): string {
  for (const value of values) {
    const text = collapseWhitespace(value);
    if (text) return text;
  }
  return "";
}

function braveToken(href: string): string {
  const at = href.indexOf("/go/v1");
  if (at === -1) return "";
  return href.slice(at + "/go/v1".length).replace(/^[/#]+/, "");
}

function braveCiteOrigin(item: DomNode): string {
  const cite = xpathText(".//cite[contains(@class,'snippet-url')]//text()", item).join("");
  try {
    return new URL(collapseWhitespace(cite.split("›")[0] ?? "")).origin;
  } catch {
    return "";
  }
}

function parseBraveHits(html: string): BraveHit[] {
  const root = buildDom(html);
  let items = xpathNodes("//div[contains(@class, 'snippet') and @data-type='web']", root);
  if (!items.length) items = xpathNodes("//div[contains(@class, 'result-wrapper')]", root);
  const hits: BraveHit[] = [];
  for (const item of items) {
    const title =
      firstText(xpathText(".//div[contains(@class, 'title')]/@title", item)) ||
      normalizeText(xpathText(".//div[contains(@class, 'title')]//text()", item).join(""));
    const body = normalizeText(
      xpathText(".//div[contains(@class, 'generic-snippet')]//text()", item).join(""),
    );
    const anchors = xpathText(".//a/@href", item).map((href) => collapseWhitespace(href));
    const token = anchors.map(braveToken).find(Boolean) ?? "";
    const absolute =
      anchors.map((href) => normalizeUrl(href)).find((href) => /^https?:\/\//.test(href)) ?? "";
    const citeHref = braveCiteOrigin(item);
    if (!title && !body) continue;
    const href = token ? `${BRAVE_CLOAK_PREFIX}${token}` : absolute;
    if (!href) continue;
    hits.push({ title, body, href, citeHref, token });
  }
  return hits;
}

function braveFallback(hit: BraveHit): string {
  return hit.token ? hit.citeHref || hit.href : hit.href;
}

async function resolveBraveHit(
  hit: BraveHit,
  ctx: EngineContext,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const budget = Math.min(timeoutMs, BRAVE_RESOLVE_TIMEOUT_MS);
  if (!hit.token || budget <= 0 || signal?.aborted) return braveFallback(hit);
  const page = await renderPageHtml(`${BRAVE_CLOAK_PAGE}${hit.token}`, ctx, budget, signal);
  if (typeof page !== "string") return braveFallback(hit);
  const target = xpathText("//a[contains(@class, 'destination')]/@href", buildDom(page))
    .map((href) => normalizeUrl(collapseWhitespace(href)))
    .find((href) => /^https?:\/\//.test(href));
  return target ?? braveFallback(hit);
}

async function resolveBraveHits(
  hits: BraveHit[],
  ctx: EngineContext,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const hrefs = hits.map((hit) => braveFallback(hit));
  const limit = Math.min(hits.length, (ctx.maxResults ?? 5) + BRAVE_RESOLVE_SLACK);
  let next = 0;
  const worker = async () => {
    while (next < limit) {
      const index = next++;
      if (!hits[index].token) continue;
      hrefs[index] = await resolveBraveHit(hits[index], ctx, timeoutMs, signal);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BRAVE_RESOLVE_CONCURRENCY, limit) }, worker),
  );
  return hits.map((hit, index) => ({ title: hit.title, href: hrefs[index], body: hit.body }));
}

function parseYahooResults(html: string): SearchResult[] {
  return extractResults(html, "//li[.//h3[@class='title']]", {
    title: ".//h3//text()",
    href: ".//a[.//h3]/@href",
    body: ".//div[contains(@class, 'compText')]//text()",
  }).filter((result) => result.title && /^https?:\/\//.test(result.href));
}

function parseEcosiaResults(html: string): SearchResult[] {
  return extractResults(html, "//article[@data-test-id='organic-result']", {
    title: ".//h2[contains(@class, 'result-title__heading')]//text()",
    href: ".//div[contains(@class, 'result__title')]//a/@href",
    body: ".//p[contains(@class, 'web-result__description')]//text()",
  }).filter((result) => result.title && /^https?:\/\//.test(result.href));
}

function parseYepResults(html: string): SearchResult[] {
  return extractResults(html, "//article[contains(@class, 'result')]", {
    title: ".//h2[contains(@class, 'title')]//text()",
    href: ".//h2[contains(@class, 'title')]//a/@href",
    body: ".//p[contains(@class, 'snippet')]//text()",
  }).filter((result) => result.title && /^https?:\/\//.test(result.href));
}

const YEP: Engine = {
  name: "yep",
  provider: "yep",
  render(query, ctx, timeoutMs, signal) {
    return renderEnginePage(
      searchUrl("https://yep.com/web", { q: query }),
      ctx,
      timeoutMs,
      signal,
      parseYepResults,
    );
  },
};

const BRAVE: Engine = {
  name: "brave",
  provider: "brave",
  async render(query, ctx, timeoutMs, signal) {
    const html = await renderPageHtml(
      searchUrl("https://search.brave.com/search", { q: query }),
      ctx,
      timeoutMs,
      signal,
    );
    if (typeof html !== "string") return html;
    return resolveBraveHits(parseBraveHits(html), ctx, timeoutMs, signal);
  },
};

const YAHOO: Engine = {
  name: "yahoo",
  provider: "yahoo",
  render(query, ctx, timeoutMs, signal) {
    return renderEnginePage(
      searchUrl("https://search.yahoo.com/search", { p: query }),
      ctx,
      timeoutMs,
      signal,
      parseYahooResults,
    );
  },
};

const ECOSIA: Engine = {
  name: "ecosia",
  provider: "ecosia",
  render(query, ctx, timeoutMs, signal) {
    return renderEnginePage(
      searchUrl("https://www.ecosia.org/search", { q: query }),
      ctx,
      timeoutMs,
      signal,
      parseEcosiaResults,
    );
  },
};

export const TEXT_ENGINES: Engine[] = [YEP, BRAVE, YAHOO, ECOSIA];

export const DEFAULT_ENGINE_NAMES = ["brave", "yep"] as const;

export class ResultsAggregator {
  private cache = new Map<string, SearchResult>();
  private scores = new Map<string, number>();

  get size(): number {
    return this.cache.size;
  }

  append(item: SearchResult, weight = 1, rank = 1): void {
    if (typeof item.href !== "string" || !item.href.trim()) return;
    const key = canonicalizeHref(item.href);
    if (!key) return;
    const existing = this.cache.get(key);
    if (!existing || item.body.length > existing.body.length) {
      this.cache.set(key, { ...item, href: key });
    }
    this.scores.set(key, (this.scores.get(key) ?? 0) + weight / (RRF_RANK_CONSTANT + rank));
  }

  extend(items: SearchResult[], weight = 1): void {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const key = canonicalizeHref(item.href);
      if (!key) return;
      const first = !seen.has(key);
      seen.add(key);
      this.append(item, first ? weight : 0, index + 1);
    });
  }

  ranked(): SearchResult[] {
    return [...this.cache.entries()]
      .filter(([, doc]) => !isWikimediaCategory(doc))
      .map(([key, doc]) => ({ doc, score: this.scores.get(key) ?? 0 }))
      .sort((a, b) => b.score - a.score || a.doc.href.localeCompare(b.doc.href))
      .map((entry) => entry.doc);
  }
}

const RRF_RANK_CONSTANT = 60;
const DEFAULT_MAX_PER_HOST = 0;
const MULTI_PART_SUFFIXES = new Set(["co.uk", "org.uk", "com.au", "co.jp", "co.nz", "com.br", "co.in"]);

export function registrableDomain(url: string): string {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  const parts = hostname.split(".");
  if (parts.length < 2) return hostname;
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3 ? parts.slice(-3).join(".") : lastTwo;
}

export function capByHost(docs: SearchResult[], limit: number, maxPerHost: number): SearchResult[] {
  if (limit <= 0) return [];
  const perHost = new Map<string, number>();
  const capped: SearchResult[] = [];
  const allowed = maxPerHost > 0 ? maxPerHost : Number.POSITIVE_INFINITY;
  for (const doc of docs) {
    const domain = registrableDomain(doc.href);
    const used = perHost.get(domain) ?? 0;
    if (used >= allowed) continue;
    perHost.set(domain, used + 1);
    capped.push(doc);
    if (capped.length >= limit) break;
  }
  return capped;
}

function isWikimediaCategory(doc: SearchResult): boolean {
  return doc.title.includes("Category:") && doc.title.includes("Wikimedia");
}

function defaultEngines(): Engine[] {
  const wanted = new Set<string>(DEFAULT_ENGINE_NAMES);
  return TEXT_ENGINES.filter((engine) => wanted.has(engine.name));
}

function selectedEngines(names: string[] | undefined): Engine[] {
  const wanted = new Set((names?.length ? names : DEFAULT_ENGINE_NAMES).map((name) => name.trim().toLowerCase()));
  const chosen = TEXT_ENGINES.filter((engine) => wanted.has(engine.name));
  return chosen.length ? chosen : defaultEngines();
}

function shuffledEngines(engines: Engine[]): Engine[] {
  const shuffled = [...engines];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function runTextSearch(
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
  options: SearchEngineOptions = {},
): Promise<SearchResult[]> {
  const started = Date.now();
  const engines = shuffledEngines(selectedEngines(options.engines));
  const deadline = started + timeoutMs;
  const aggregator = new ResultsAggregator();
  const engineWeights = options.engineWeights ?? {};
  const maxPerHost = options.maxPerHost ?? DEFAULT_MAX_PER_HOST;
  const ctx: EngineContext = {
    region: "us-en",
    safesearch: "moderate",
    policy: options.policy ?? null,
    renderPage: options.renderPage,
    allowPrivateAddresses: options.allowPrivateAddresses,
    maxResults,
  };
  const controller = new AbortController();
  let onAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const timedOutProviders = new Set<string>();
  const renderFailures: Record<string, string> = {};
  let cancelled = false;
  let deadlineReached = false;
  const deadlineTimer = setTimeout(() => {
    deadlineReached = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  const maxWorkers = Math.min(engines.length, 3);
  let i = 0;
  const pending = new Set<Promise<void>>();
  const run = async (engine: Engine) => {
    if (controller.signal.aborted) {
      if (signal?.aborted) cancelled = true;
      else if (deadlineReached) timedOutProviders.add(engine.name);
      return;
    }
    let results: SearchResult[] | null = null;
    let renderFailure: string | null = null;
    for (let attempt = 0; attempt < 2 && results === null && renderFailure === null; attempt++) {
      if (controller.signal.aborted) {
        if (signal?.aborted) cancelled = true;
        else if (deadlineReached) timedOutProviders.add(engine.name);
        return;
      }
      const attemptBudget = deadline - Date.now();
      if (attemptBudget <= 0) {
        timedOutProviders.add(engine.name);
        return;
      }
      const engineSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      try {
        const outcome = await engine.render(query, ctx, Math.max(1, attemptBudget), engineSignal);
        if (isRenderFailure(outcome)) {
          if (controller.signal.aborted) {
            if (signal?.aborted) cancelled = true;
            else if (deadlineReached) timedOutProviders.add(engine.name);
            return;
          }
          renderFailure = outcome.error;
        } else {
          results = outcome;
        }
      } catch (e) {
        if (e instanceof SearchCancelled) {
          if (controller.signal.aborted && !signal?.aborted) return;
          cancelled = true;
          return;
        }
        if (e instanceof SearchTimeoutError) {
          timedOutProviders.add(engine.name);
          return;
        }
        if (controller.signal.aborted) {
          if (signal?.aborted) cancelled = true;
          else if (deadlineReached) timedOutProviders.add(engine.name);
          return;
        }
      }
      if (results === null && renderFailure === null && attempt === 0) {
        const backoff = Math.min(250, Math.max(0, deadline - Date.now()));
        if (backoff > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, backoff));
        }
      }
    }
    if (renderFailure !== null) {
      renderFailures[engine.name] = renderFailure;
      return;
    }
    if (results === null && Date.now() >= deadline) timedOutProviders.add(engine.name);
    if (results && results.length) {
      aggregator.extend(results, engineWeights[engine.name] ?? 1);
    }
  };
  while (i < engines.length || pending.size > 0) {
    if (cancelled) break;
    while (i < engines.length && pending.size < maxWorkers) {
      if (cancelled) break;
      const engine = engines[i++];
      const task = run(engine);
      pending.add(task);
      void task.then(
        () => {
          pending.delete(task);
        },
        () => {
          pending.delete(task);
        },
      );
    }
    if (pending.size === 0) break;
    await Promise.race(pending);
  }
  await Promise.allSettled(pending);
  clearTimeout(deadlineTimer);
  if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  if (cancelled || signal?.aborted) throw new SearchCancelled();
  const results = capByHost(aggregator.ranked(), maxResults, maxPerHost);
  if (results.length) return results;
  if (timedOutProviders.size) throw new SearchTimeoutError([...timedOutProviders].sort());
  if (Object.keys(renderFailures).length) throw new SearchRenderError(renderFailures);
  throw new EmptySweepError();
}

let sweepSlotBusy = false;
const sweepSlotWaiters: (() => void)[] = [];

function releaseSweepSlot(): void {
  const next = sweepSlotWaiters.shift();
  if (next) next();
  else sweepSlotBusy = false;
}

function acquireSweepSlot(signal?: AbortSignal): Promise<(() => void) | null> {
  return new Promise<(() => void) | null>((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const onAbort = () => {
      const index = sweepSlotWaiters.indexOf(grant);
      if (index !== -1) sweepSlotWaiters.splice(index, 1);
      resolve(null);
    };
    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        releaseSweepSlot();
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (sweepSlotBusy) sweepSlotWaiters.push(grant);
    else {
      sweepSlotBusy = true;
      grant();
    }
  });
}

export async function autoTextSearch(
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
  options: SearchEngineOptions = {},
): Promise<SearchResult[]> {
  const release = await acquireSweepSlot(signal);
  if (release === null) throw new SearchCancelled();
  try {
    if (signal?.aborted) throw new SearchCancelled();
    return await runTextSearch(query, maxResults, timeoutMs, signal, options);
  } finally {
    release();
  }
}
