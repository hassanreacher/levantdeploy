import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { maskProxyUrl, parseCaBundle } from "./platform";

describe("platform build settings helpers", () => {
  it("masks proxy passwords", () => {
    expect(maskProxyUrl("http://user:s3cret@proxy:3128")).toBe("http://user:••••@proxy:3128");
    expect(maskProxyUrl("http://proxy:3128")).toBe("http://proxy:3128");
    expect(maskProxyUrl(null)).toBeNull();
  });
  it.skipIf(!fs.existsSync("/etc/ssl/certs/ca-certificates.crt"))("parses a CA bundle", () => {
    const certs = parseCaBundle(fs.readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8"));
    expect(certs.length).toBeGreaterThan(10);
    expect(certs[0]!.fingerprint).toMatch(/^[0-9A-F:]+$/);
  });
  it("rejects garbage", () => {
    expect(parseCaBundle("not a cert")).toEqual([]);
    expect(() => parseCaBundle("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")).toThrow();
  });
});
