import { describe, expect, it } from "vitest";

import { isPrivateOrLoopbackIp, sanitizeResponseHeaders } from "./route";

describe("preview proxy security", () => {
  it("blocks IPv4-mapped IPv6 private and loopback addresses", () => {
    expect(isPrivateOrLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::ffff:10.0.0.8")).toBe(true);
    expect(isPrivateOrLoopbackIp("::ffff:192.168.1.20")).toBe(true);
  });

  it("allows IPv4-mapped IPv6 public addresses", () => {
    expect(isPrivateOrLoopbackIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("drops upstream set-cookie and enforces sandbox CSP", () => {
    const upstream = new Headers({
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "sid=upstream; Path=/; HttpOnly",
      "content-security-policy":
        "default-src 'self'; sandbox allow-same-origin",
    });

    const headers = sanitizeResponseHeaders(upstream, "req-123");

    expect(headers.has("set-cookie")).toBe(false);
    expect(headers.get("content-security-policy")).toContain("sandbox");
    expect(headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(headers.get("x-proxy-req-id")).toBe("req-123");
  });
});
