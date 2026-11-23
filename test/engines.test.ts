import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENGINE_NAMES,
  EmptySweepError,
  ResultsAggregator,
  SearchCancelled,
  SearchRenderError,
  SearchTimeoutError,
  TEXT_ENGINES,
  autoTextSearch,
  buildDom,
  canonicalizeHref,
  capByHost,
  extractResults,
  normalizeText,
  normalizeUrl,
  registrableDomain,
  xpathNodes,
  xpathText,
  type SearchRenderPage,
} from "../engines.ts";

const BING_TARGET = "https://example.com/bing";
const BING_ENCODED = Buffer.from(BING_TARGET, "utf8").toString("base64url");
const BING_HTML = `
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1${BING_ENCODED}&amp;ntb=1">Bing result</a></h2>
    <p>Bing snippet.</p>
  </li>
`;

const BRAVE_HTML = `
  <div class="result-wrapper">
    <a href="https://example.com/brave"><div class="title search-snippet-title">Brave result</div></a>
    <div class="generic-snippet">Brave snippet.</div>
  </div>
`;

const YAHOO_HTML = `
  <li>
    <a href="https://example.com/yahoo"><h3 class="title">Yahoo result</h3></a>
    <div class="compText">Yahoo snippet.</div>
  </li>
  <li><a href=""><h3 class="title">People also ask</h3></a></li>
`;

const ECOSIA_HTML = `
  <article data-test-id="organic-result">
    <div class="result-info">
      <a data-test-id="result-link" href="https://support.ecosia.org/article/579">provider note</a>
    </div>
    <div class="result__title">
      <a data-test-id="result-link" href="https://example.com/ecosia">
        <h2 data-test-id="result-title" class="result-title__heading">Ecosia result</h2>
      </a>
    </div>
    <div class="result__description">
      <p class="web-result__description">Ecosia snippet.</p>
    </div>
  </article>
`;

function fixtureFor(url: string): string {
  if (url.includes("bing.com")) return BING_HTML;
  if (url.includes("brave.com")) return BRAVE_HTML;
  if (url.includes("yahoo.com")) return YAHOO_HTML;
  if (url.includes("ecosia.org")) return ECOSIA_HTML;
  return "<html><body></body></html>";
}

function renderPageWith(fixture: SearchRenderPage): SearchRenderPage {
  return fixture;
}

function engine(name: string) {
  const found = TEXT_ENGINES.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`unknown engine ${name}`);
  return found;
}

describe("normalizers", () => {
  it("strips tags, unescapes entities, normalizes unicode, removes control chars, collapses whitespace", () => {
    expect(normalizeText("  <b>Hello</b>   &amp;   world  ")).toBe("Hello & world");
    expect(normalizeText("<a href='x'>A</a><span>B</span>")).toBe("AB");
    expect(normalizeText("caf\u00e9 \u0063\u0061\u0066\u0065\u0301")).toBe("café café");
    expect(normalizeText("line\u200bbreak")).toBe("linebreak");
    expect(normalizeText("a\u0000b\u001fc")).toBe("abc");
  });

  it("unquotes urls and replaces spaces with plus", () => {
    expect(normalizeUrl("https://example.com/a%20b?q=1")).toBe("https://example.com/a+b?q=1");
    expect(normalizeUrl("https://example.com/x y")).toBe("https://example.com/x+y");
    expect(normalizeUrl("")).toBe("");
  });
});

describe("canonicalizeHref", () => {
  it("strips tracking parameters and fragments", () => {
    expect(canonicalizeHref("https://x.com/a?utm_source=rss&utm_medium=feed&b=7")).toBe("https://x.com/a?b=7");
    expect(canonicalizeHref("https://x.com/a?fbclid=abc&gclid=def&q=1")).toBe("https://x.com/a?q=1");
    expect(canonicalizeHref("https://x.com/a#section")).toBe("https://x.com/a");
  });

  it("strips default ports and keeps others", () => {
    expect(canonicalizeHref("https://x.com:443/a")).toBe("https://x.com/a");
    expect(canonicalizeHref("http://x.com:80/a")).toBe("http://x.com/a");
    expect(canonicalizeHref("https://x.com:8443/a")).toBe("https://x.com:8443/a");
  });

  it("returns unparsable input unchanged", () => {
    expect(canonicalizeHref("not a url")).toBe("not a url");
    expect(canonicalizeHref("")).toBe("");
  });
});

describe("xpath subset", () => {
  it("extracts text and attributes from a nested structure", () => {
    const dom = buildDom(
      '<div class="result"><div class="body"><h2><a href="/t">Title &amp; more</a></h2><a class="snippet" href="/s">Some snippet</a></div></div>',
    );
    const items = xpathNodes("//div[contains(@class, 'body')]", dom);
    expect(items.length).toBe(1);
    expect(xpathText(".//h2//text()", items[0]).join("")).toBe("Title & more");
    expect(xpathText("./a/@href", items[0])).toEqual(["/s"]);
    expect(xpathText(".//a//text()", items[0]).join("")).toBe("Title & moreSome snippet");
  });

  it("supports or/and predicates with position", () => {
    const dom = buildDom(
      '<div class="a"><span class="title">1</span><span class="sitename-container">2</span></div><div class="b"><span class="x">3</span></div>',
    );
    const expr = "//div[(contains(@class,'a') or contains(@class,'b')) and position()=last()]";
    const nodes = xpathNodes(expr, dom);
    expect(nodes.length).toBe(1);
    expect(xpathText(".//text()", nodes[0]).join("")).toBe("3");
  });

  it("supports direct-child predicates", () => {
    const dom = buildDom(
      '<div class="result"><a href="/one"><h2>One</h2></a><p>First</p></div><div class="result"><p>No link</p></div>',
    );
    const items = xpathNodes("//div[contains(@class, 'result')][./a]", dom);
    expect(items.length).toBe(1);
    expect(xpathText("./a/@href", items[0])).toEqual(["/one"]);
  });
});

describe("extractResults", () => {
  it("extracts generic result blocks", () => {
    const results = extractResults(
      '<div class="result"><h2><a href="https://example.com/a?utm=x&amp;b=2">Title <b>Here</b></a></h2><p>Snippet.</p></div>',
      "//div[contains(@class, 'result')]",
      { title: ".//h2//text()", href: ".//h2//a/@href", body: ".//p//text()" },
    );
    expect(results).toEqual([
      { title: "Title Here", href: "https://example.com/a?utm=x&b=2", body: "Snippet." },
    ]);
  });
});

describe("engine renderers", () => {
  it("parses bing results and decodes redirect links", async () => {
    const requested: string[] = [];
    const results = await engine("bing").render(
      "unsloth studio",
      {
        region: "us-en",
        safesearch: "moderate",
        renderPage: async (url) => {
          requested.push(url);
          return BING_HTML;
        },
      },
      5000,
    );
    expect(results).toEqual([
      { title: "Bing result", href: BING_TARGET, body: "Bing snippet." },
    ]);
    const url = new URL(requested[0]);
    expect(url.origin + url.pathname).toBe("https://www.bing.com/search");
    expect(url.searchParams.get("q")).toBe("unsloth studio");
  });

  it("parses brave results", async () => {
    const results = await engine("brave").render(
      "unsloth studio",
      {
        region: "us-en",
        safesearch: "moderate",
        renderPage: async (url) => {
          expect(url).toContain("search.brave.com/search");
          expect(url).toContain("q=unsloth+studio");
          return BRAVE_HTML;
        },
      },
      5000,
    );
    expect(results).toEqual([
      { title: "Brave result", href: "https://example.com/brave", body: "Brave snippet." },
    ]);
  });

  it("parses yahoo results and drops empty links", async () => {
    const results = await engine("yahoo").render(
      "unsloth studio",
      {
        region: "us-en",
        safesearch: "moderate",
        renderPage: async (url) => {
          expect(url).toContain("search.yahoo.com/search");
          expect(url).toContain("p=unsloth+studio");
          return YAHOO_HTML;
        },
      },
      5000,
    );
    expect(results).toEqual([
      { title: "Yahoo result", href: "https://example.com/yahoo", body: "Yahoo snippet." },
    ]);
  });

  it("parses ecosia results from the title link", async () => {
    const results = await engine("ecosia").render(
      "unsloth studio",
      {
        region: "us-en",
        safesearch: "moderate",
        renderPage: async (url) => {
          expect(url).toContain("ecosia.org/search");
          expect(url).toContain("q=unsloth+studio");
          return ECOSIA_HTML;
        },
      },
      5000,
    );
    expect(results).toEqual([
      { title: "Ecosia result", href: "https://example.com/ecosia", body: "Ecosia snippet." },
    ]);
  });

  it("returns null when no renderer is configured", async () => {
    expect(await engine("bing").render("x", { region: "us-en", safesearch: "moderate" }, 5000)).toBeNull();
  });

  it("passes the website policy and private-address flag to the renderer", async () => {
    let seen: unknown;
    await engine("bing").render(
      "x",
      {
        region: "us-en",
        safesearch: "moderate",
        policy: { allowedDomains: ["example.com"], blockedDomains: [] },
        allowPrivateAddresses: false,
        renderPage: async (_url, options) => {
          seen = options;
          return BING_HTML;
        },
      },
      5000,
    );
    expect(seen).toMatchObject({
      websitePolicy: { allowedDomains: ["example.com"], blockedDomains: [] },
      allowPrivateAddresses: false,
    });
  });
});

describe("ResultsAggregator", () => {
  it("dedupes by href and keeps the longer body", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "A", href: "https://x.com/1", body: "short" },
      { title: "B", href: "https://x.com/2", body: "body b" },
      { title: "A2", href: "https://x.com/1", body: "a much longer body" },
      { title: "B", href: "https://x.com/2", body: "body b" },
    ]);
    const out = aggregator.ranked();
    expect(out.length).toBe(2);
    expect(aggregator.size).toBe(2);
    expect(out[0].href).toBe("https://x.com/1");
    expect(out[0].title).toBe("A2");
    expect(out[0].body).toBe("a much longer body");
  });

  it("merges duplicates that differ only by tracking parameters", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "A", href: "https://x.com/p?utm_source=rss", body: "short" },
      { title: "A", href: "https://x.com/p?utm_source=news&utm_medium=rss", body: "longer body" },
      { title: "A", href: "https://x.com/p", body: "longest body here" },
    ]);
    const out = aggregator.ranked();
    expect(out.length).toBe(1);
    expect(out[0].body).toBe("longest body here");
    expect(out[0].href).toBe("https://x.com/p");
  });

  it("keeps pages apart when non-tracking parameters differ", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "A", href: "https://x.com/p?page=1", body: "first" },
      { title: "A", href: "https://x.com/p?page=2", body: "second" },
    ]);
    expect(aggregator.ranked().length).toBe(2);
  });

  it("ranks a result two engines returned above a single engine's deeper hit", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "deep", href: "https://a.example/deep", body: "" },
      { title: "second", href: "https://a.example/second", body: "" },
      { title: "shared", href: "https://shared.example/hit", body: "" },
      { title: "fourth", href: "https://a.example/fourth", body: "" },
    ]);
    aggregator.extend([{ title: "shared", href: "https://shared.example/hit", body: "" }]);
    expect(aggregator.ranked()[0].href).toBe("https://shared.example/hit");
  });

  it("honours engine weights and breaks ties by href", () => {
    const weighted = new ResultsAggregator();
    weighted.extend([{ title: "low", href: "https://low.example/a", body: "" }], 0.5);
    weighted.extend([{ title: "high", href: "https://high.example/b", body: "" }], 2);
    expect(weighted.ranked()[0].href).toBe("https://high.example/b");
    const tied = new ResultsAggregator();
    tied.extend([{ title: "z", href: "https://z.example/a", body: "" }]);
    tied.extend([{ title: "a", href: "https://a.example/b", body: "" }]);
    expect(tied.ranked().map((doc) => doc.href)).toEqual(["https://a.example/b", "https://z.example/a"]);
  });
});

describe("capByHost", () => {
  const docs = [
    { title: "1", href: "https://example.com/a", body: "" },
    { title: "2", href: "https://www.example.com/b", body: "" },
    { title: "3", href: "https://sub.example.com/c", body: "" },
    { title: "4", href: "https://other.com/d", body: "" },
  ];

  it("caps results per registrable domain", () => {
    expect(capByHost(docs, 10, 2).map((doc) => doc.href)).toEqual([
      "https://example.com/a",
      "https://www.example.com/b",
      "https://other.com/d",
    ]);
  });

  it("respects the result limit and treats zero as no cap", () => {
    expect(capByHost(docs, 2, 2).length).toBe(2);
    expect(capByHost(docs, 10, 0).length).toBe(4);
  });
});

describe("registrableDomain", () => {
  it("strips www, subdomains and multi-part suffixes", () => {
    expect(registrableDomain("https://www.example.com/a")).toBe("example.com");
    expect(registrableDomain("https://news.bbc.co.uk/x")).toBe("bbc.co.uk");
    expect(registrableDomain("not a url")).toBe("");
  });
});

describe("sweep", () => {
  it("ships the expected default engines", () => {
    expect([...DEFAULT_ENGINE_NAMES]).toEqual(["brave", "ecosia"]);
    expect(TEXT_ENGINES.map((candidate) => candidate.name)).toEqual(["bing", "brave", "yahoo", "ecosia"]);
  });

  it("renders the selected engines and fuses their results", async () => {
    const requested: string[] = [];
    const results = await autoTextSearch("unsloth studio", 5, 10_000, undefined, {
      renderPage: renderPageWith(async (url) => {
        requested.push(url);
        return fixtureFor(url);
      }),
    });
    expect(results.map((result) => result.href)).toEqual([
      "https://example.com/brave",
      "https://example.com/ecosia",
    ]);
    expect(requested.length).toBe(2);
  });

  it("limits the sweep to the configured engines", async () => {
    const requested: string[] = [];
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["bing"],
      renderPage: async (url) => {
        requested.push(url);
        return BING_HTML;
      },
    });
    expect(results.length).toBe(1);
    expect(requested.length).toBe(1);
    expect(requested[0]).toContain("bing.com");
  });

  it("falls back to the default engines when no configured name matches", async () => {
    const requested: string[] = [];
    await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["nope"],
      renderPage: async (url) => {
        requested.push(url);
        return fixtureFor(url);
      },
    });
    expect(requested.length).toBe(2);
  });

  it("applies maxPerHost to the returned results", async () => {
    const sameHost = Array.from(
      { length: 5 },
      (_, i) => `<li class="b_algo"><h2><a href="https://one.example/p${i}">R${i}</a></h2><p>S${i}</p></li>`,
    ).join("");
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["bing"],
      maxPerHost: 2,
      renderPage: async () => sameHost,
    });
    expect(results.length).toBe(2);
    expect(results.every((result) => new URL(result.href).hostname === "one.example")).toBe(true);
  });

  it("orders results by engine weight", async () => {
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["bing", "yahoo"],
      engineWeights: { bing: 0.5, yahoo: 3 },
      renderPage: async (url) => (url.includes("yahoo") ? YAHOO_HTML : BING_HTML),
    });
    expect(results[0].href).toBe("https://example.com/yahoo");
  });

  it("aborts in-flight engines once enough results arrive", async () => {
    let aborted = false;
    const results = await autoTextSearch("cat", 1, 10_000, undefined, {
      engines: ["bing", "yahoo"],
      renderPage: (url, options) => {
        if (url.includes("yahoo")) {
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return Promise.resolve(BING_HTML);
      },
    });
    expect(results.length).toBe(1);
    expect(aborted).toBe(true);
  });

  it("reports a timeout when every engine stalls", async () => {
    await expect(
      autoTextSearch("cat", 5, 80, undefined, {
        engines: ["bing", "yahoo"],
        renderPage: (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      }),
    ).rejects.toThrow(SearchTimeoutError);
  });

  it("reports a timeout when an aborted render returns a cancellation error", async () => {
    const error: unknown = await autoTextSearch("cat", 5, 80, undefined, {
      engines: ["bing"],
      renderPage: (_url, options) =>
        new Promise<{ error: string }>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve({ error: "Failed to render URL: cancelled." }),
            { once: true },
          );
        }),
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SearchTimeoutError);
    expect(error).not.toBeInstanceOf(SearchRenderError);
    expect((error as SearchTimeoutError).providers).toEqual(["bing"]);
  });

  it("reports cancellation when the caller aborts an in-flight render", async () => {
    const controller = new AbortController();
    let started = false;
    const pending = autoTextSearch("cat", 5, 10_000, controller.signal, {
      engines: ["bing"],
      renderPage: (_url, options) =>
        new Promise<{ error: string }>((resolve) => {
          started = true;
          options.signal?.addEventListener(
            "abort",
            () => resolve({ error: "Failed to render URL: cancelled." }),
            { once: true },
          );
        }),
    });
    setTimeout(() => controller.abort(), 10);
    const began = Date.now();
    await expect(pending).rejects.toThrow(SearchCancelled);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(started).toBe(true);
  });

  it("reports no results when every engine returns nothing", async () => {
    await expect(
      autoTextSearch("cat", 5, 10_000, undefined, {
        engines: ["bing", "yahoo"],
        renderPage: async () => null,
      }),
    ).rejects.toThrow(EmptySweepError);
  });

  it("propagates cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      autoTextSearch("cat", 5, 10_000, controller.signal, {
        engines: ["bing"],
        renderPage: async () => BING_HTML,
      }),
    ).rejects.toThrow(SearchCancelled);
  });

  it("serializes overlapping sweeps so their renders never interleave", async () => {
    const log: string[] = [];
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const renderFirst: SearchRenderPage = async (url) => {
      const name = url.includes("bing") ? "bing" : "yahoo";
      log.push(`start:${name}`);
      await delay(10);
      log.push(`end:${name}`);
      return name === "bing" ? BING_HTML : YAHOO_HTML;
    };
    const renderSecond: SearchRenderPage = async (url) => {
      const name = url.includes("brave") ? "brave" : "ecosia";
      log.push(`start:${name}`);
      await delay(10);
      log.push(`end:${name}`);
      return name === "brave" ? BRAVE_HTML : ECOSIA_HTML;
    };
    const [first, second] = await Promise.all([
      autoTextSearch("cat", 5, 10_000, undefined, { engines: ["bing", "yahoo"], renderPage: renderFirst }),
      autoTextSearch("cat", 5, 10_000, undefined, { engines: ["brave", "ecosia"], renderPage: renderSecond }),
    ]);
    expect(first.map((result) => result.href)).toEqual([
      "https://example.com/bing",
      "https://example.com/yahoo",
    ]);
    expect(second.map((result) => result.href)).toEqual([
      "https://example.com/brave",
      "https://example.com/ecosia",
    ]);
    const firstEvents = log.filter((entry) => entry.endsWith(":bing") || entry.endsWith(":yahoo"));
    const secondEvents = log.filter((entry) => entry.endsWith(":brave") || entry.endsWith(":ecosia"));
    expect(firstEvents).toHaveLength(4);
    expect(secondEvents).toHaveLength(4);
    expect(log.slice(0, firstEvents.length)).toEqual(firstEvents);
    expect(log.slice(firstEvents.length)).toEqual(secondEvents);
  });

  it("cancels a queued sweep before it renders", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    const rendered: string[] = [];
    const first = autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["bing"],
      renderPage: async () => {
        rendered.push("bing");
        await gate;
        return BING_HTML;
      },
    });
    const controller = new AbortController();
    const second = autoTextSearch("cat", 5, 10_000, controller.signal, {
      engines: ["yahoo"],
      renderPage: async () => {
        rendered.push("yahoo");
        return YAHOO_HTML;
      },
    });
    const third = autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["ecosia"],
      renderPage: async () => {
        rendered.push("ecosia");
        return ECOSIA_HTML;
      },
    });
    const cancelled = expect(second).rejects.toThrow(SearchCancelled);
    controller.abort();
    await cancelled;
    expect(rendered).toEqual(["bing"]);
    releaseFirst();
    expect((await first).length).toBe(1);
    expect((await third).length).toBe(1);
    expect(rendered).toEqual(["bing", "ecosia"]);
  });

  it("records render errors without retrying", async () => {
    const requested: string[] = [];
    const error: unknown = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["bing"],
      renderPage: async (url) => {
        requested.push(url);
        return { error: "Failed to fetch URL: HTTP 429 Too Many Requests." };
      },
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SearchRenderError);
    expect((error as SearchRenderError).failures).toEqual({
      bing: "Failed to fetch URL: HTTP 429 Too Many Requests.",
    });
    expect(requested.length).toBe(1);
  });

  it("keeps results when another engine reports a render error", async () => {
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["bing", "yahoo"],
      renderPage: async (url) => {
        if (url.includes("yahoo")) return { error: "Failed to render URL: timed out." };
        return BING_HTML;
      },
    });
    expect(results.map((result) => result.href)).toEqual(["https://example.com/bing"]);
  });
});
