import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyForUrl } from "../proxy.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxyForUrl", () => {
  it("prefers the https proxy variables and keeps http proxies", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:3128");
    vi.stubEnv("ALL_PROXY", "http://other.example:1080");
    expect(proxyForUrl(new URL("https://example.com/page"))).toBe("http://proxy.example:3128/");
  });

  it("falls back to all_proxy", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("ALL_PROXY", "http://127.0.0.1:8080");
    expect(proxyForUrl(new URL("https://example.com/"))).toBe("http://127.0.0.1:8080/");
  });

  it("uses http proxy variables for http targets", () => {
    vi.stubEnv("HTTP_PROXY", "http://http-proxy.example:8081");
    vi.stubEnv("HTTPS_PROXY", "http://https-proxy.example:8082");
    expect(proxyForUrl(new URL("http://example.com/"))).toBe("http://http-proxy.example:8081/");
    expect(proxyForUrl(new URL("https://example.com/"))).toBe("http://https-proxy.example:8082/");
  });

  it("ignores socks5 proxies", () => {
    vi.stubEnv("ALL_PROXY", "socks5://127.0.0.1:9050");
    expect(proxyForUrl(new URL("https://example.com/"))).toBeNull();
    vi.stubEnv("ALL_PROXY", "socks5h://127.0.0.1:9050");
    expect(proxyForUrl(new URL("https://example.com/"))).toBeNull();
  });

  it("honors no_proxy domains, ports and wildcards", () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:3128");
    vi.stubEnv("NO_PROXY", "example.com,.internal.test,other.test:8443");
    expect(proxyForUrl(new URL("https://example.com/"))).toBeNull();
    expect(proxyForUrl(new URL("https://sub.example.com/"))).toBeNull();
    expect(proxyForUrl(new URL("https://host.internal.test/"))).toBeNull();
    expect(proxyForUrl(new URL("https://other.test:8443/"))).toBeNull();
    expect(proxyForUrl(new URL("https://other.test/"))).not.toBeNull();
    vi.stubEnv("NO_PROXY", "*");
    expect(proxyForUrl(new URL("https://unrelated.test/"))).toBeNull();
  });

  it("matches no_proxy entries against ipv6 literals", () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:3128");
    for (const entry of ["::1", "[::1]"]) {
      vi.stubEnv("NO_PROXY", entry);
      expect(proxyForUrl(new URL("https://[::1]:8443/"))).toBeNull();
    }
    vi.stubEnv("NO_PROXY", "::1");
    expect(proxyForUrl(new URL("https://[2606:4700:4700::1111]/"))).not.toBeNull();
  });

  it("ignores malformed proxy values", () => {
    vi.stubEnv("HTTPS_PROXY", "not a url");
    expect(proxyForUrl(new URL("https://example.com/"))).toBeNull();
  });
});
