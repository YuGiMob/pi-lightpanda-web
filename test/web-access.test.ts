import { describe, expect, it } from "vitest";
import {
  checkUrlAccess,
  hostnameAllowed,
  normalizeDomain,
  normalizeUrlScheme,
  scopeSearchQuery,
  websitePolicyPrompt,
} from "../web-access.ts";

describe("normalizeUrlScheme", () => {
  it("rewrites bare hosts to https", () => {
    expect(normalizeUrlScheme("google.com")).toBe("https://google.com");
    expect(normalizeUrlScheme("www.google.com/x")).toBe("https://www.google.com/x");
    expect(normalizeUrlScheme("//google.com")).toBe("https://google.com");
    expect(normalizeUrlScheme("https://google.com")).toBe("https://google.com");
    expect(normalizeUrlScheme("http://google.com")).toBe("http://google.com");
    expect(normalizeUrlScheme("example.com:8443/path")).toBe("https://example.com:8443/path");
    expect(normalizeUrlScheme("sub.example.co.uk:8080")).toBe("https://sub.example.co.uk:8080");
  });

  it("leaves real schemes and invalid forms untouched", () => {
    expect(normalizeUrlScheme("ftp://x.com")).toBe("ftp://x.com");
    expect(normalizeUrlScheme("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(normalizeUrlScheme("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(normalizeUrlScheme("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(normalizeUrlScheme("/login")).toBe("/login");
    expect(normalizeUrlScheme("example.com:99999")).toBe("example.com:99999");
    expect(normalizeUrlScheme("example.com:abc")).toBe("example.com:abc");
  });
});

describe("checkUrlAccess", () => {
  it("rejects empty urls and invalid characters", () => {
    expect(checkUrlAccess("", null)[1]).toBe("Blocked: the URL is empty.");
    expect(checkUrlAccess("https://exa mple.com", null)[1]).toBe("Blocked: the URL contains invalid characters.");
    expect(checkUrlAccess("https://example.com\\evil", null)[0]).toBe(false);
  });

  it("rejects non-http schemes, credentials, and encoded hosts", () => {
    expect(checkUrlAccess("ftp://x.com", null)[1]).toBe("Blocked: only http/https URLs are allowed.");
    expect(checkUrlAccess("https://user:pass@example.com", null)[1]).toBe(
      "Blocked: URLs with credentials or encoded hostnames are not allowed.",
    );
  });

  it("accepts plain https urls and bracketed ipv6", () => {
    const [allowed, , hostname] = checkUrlAccess("https://example.com/path", null);
    expect(allowed).toBe(true);
    expect(hostname).toBe("example.com");
    const [ipv6Allowed, , ipv6] = checkUrlAccess("http://[::1]:8080/x", null);
    expect(ipv6Allowed).toBe(true);
    expect(ipv6).toBe("::1");
  });

  it("enforces website policies", () => {
    const policy = { allowedDomains: ["docs.example.com"], blockedDomains: ["bad.example.com"] };
    expect(checkUrlAccess("https://docs.example.com/x", policy)[0]).toBe(true);
    expect(checkUrlAccess("https://sub.docs.example.com/x", policy)[0]).toBe(true);
    expect(checkUrlAccess("https://other.com/x", policy)[0]).toBe(false);
    expect(checkUrlAccess("https://bad.example.com/x", policy)[0]).toBe(false);
  });

  it("fails closed when a policy exceeds the domain cap", () => {
    const overLimit = {
      allowedDomains: Array.from({ length: 101 }, (_, i) => `d${i}.example`),
      blockedDomains: [],
    };
    expect(checkUrlAccess("https://d0.example/x", overLimit)[0]).toBe(false);
    expect(hostnameAllowed("d0.example", overLimit)).toBe(false);
  });
});

describe("normalizeDomain", () => {
  it("lowercases, strips trailing dots and IDNA-encodes", () => {
    expect(normalizeDomain("EXAMPLE.com.")).toBe("example.com");
    expect(normalizeDomain("münchen.de")).toBe("xn--mnchen-3ya.de");
  });

  it("rejects schemes, ports, and weird forms", () => {
    expect(() => normalizeDomain("https://x.com")).toThrow();
    expect(() => normalizeDomain("x.com:443")).toThrow();
    expect(() => normalizeDomain("")).toThrow();
    expect(() => normalizeDomain("0x7f.0.0.1")).toThrow();
    expect(() => normalizeDomain("001.002.003.004")).toThrow();
  });

  it("accepts canonical ip literals", () => {
    expect(normalizeDomain("93.184.216.34")).toBe("93.184.216.34");
    expect(normalizeDomain("8.8.8.8.")).toBe("8.8.8.8");
    expect(normalizeDomain("[::1]")).toBe("::1");
  });
});

describe("websitePolicyPrompt and scopeSearchQuery", () => {
  it("builds a prompt only when restricted", () => {
    expect(websitePolicyPrompt(null)).toBe("");
    const policy = { allowedDomains: ["a.com"], blockedDomains: ["b.com"] };
    const prompt = websitePolicyPrompt(policy);
    expect(prompt).toContain("a.com");
    expect(prompt).toContain("b.com");
  });

  it("scopes queries with rotating site filters", () => {
    expect(scopeSearchQuery("llama", null)).toBe("llama");
    const policy = { allowedDomains: ["a.com", "b.com"], blockedDomains: [] };
    const scoped = scopeSearchQuery("llama", policy);
    expect(scoped).toContain("site:a.com");
    expect(scoped).toContain("site:b.com");
  });

  it("rotates the site filter so every allowed domain is reachable", () => {
    const domains = Array.from({ length: 20 }, (_, i) => `d${i}.example`);
    const policy = { allowedDomains: domains, blockedDomains: [] };
    const covered = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const scoped = scopeSearchQuery(`query ${i}`, policy);
      const hits = domains.filter((domain) => scoped.includes(`site:${domain}`));
      expect(hits.length).toBe(8);
      hits.forEach((hit) => covered.add(hit));
    }
    expect(covered).toEqual(new Set(domains));
    expect(scopeSearchQuery("stable", policy)).toBe(scopeSearchQuery("stable", policy));
  });
});
