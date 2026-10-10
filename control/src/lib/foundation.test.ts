import { describe, expect, it } from "vitest";
import { decryptJson, decryptString, encryptJson, encryptString, randomId, sha256 } from "./crypto";
import { totpCode, verifyTotp, base32Decode, base32Encode } from "./auth/totp";
import { canTransition, deploymentHost, branchHost, projectHost, dnsLabel } from "./deployments";
import { tokenHasScope } from "./auth/tokens";
import { hasRole } from "./auth/roles";
import { slugify } from "./teams";

describe("crypto", () => {
  it("round-trips strings and json", () => {
    expect(decryptString(encryptString("héllo"))).toBe("héllo");
    expect(decryptJson<{ a: number }>(encryptJson({ a: 1 }))).toEqual({ a: 1 });
    expect(decryptString("v1.bad.bad.bad")).toBeNull();
    expect(sha256("x")).toHaveLength(64);
    expect(randomId(9)).toMatch(/^[a-z0-9]{9}$/);
  });
});

describe("totp", () => {
  it("matches RFC 6238 test vector (SHA1)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(secret, "000000", 59_000)).toBe(false);
  });
});

describe("deployments", () => {
  it("builds DNS-safe hosts", () => {
    process.env.PLATFORM_DOMAIN = "apps.example.com";
    expect(deploymentHost("My_App", "abc123def")).toBe("my-app-abc123def.apps.example.com");
    expect(projectHost("shop")).toBe("shop.apps.example.com");
    expect(branchHost("shop", "feature/Login")).toBe("shop-git-feature-login.apps.example.com");
    expect(dnsLabel("x".repeat(100)).length).toBeLessThanOrEqual(63);
    expect(deploymentHost("y".repeat(80), "abc123def").split(".")[0]!.length).toBeLessThanOrEqual(63);
  });
  it("enforces transitions", () => {
    expect(canTransition("QUEUED", "BUILDING")).toBe(true);
    expect(canTransition("READY", "BUILDING")).toBe(false);
    expect(canTransition("ERROR", "READY")).toBe(false);
    expect(canTransition("SUPERSEDED", "READY")).toBe(true);
  });
});

describe("auth helpers", () => {
  it("scopes and roles", () => {
    expect(tokenHasScope(["*"], "env:write")).toBe(true);
    expect(tokenHasScope(["env:write"], "env:read")).toBe(true);
    expect(tokenHasScope(["env:read"], "env:write")).toBe(false);
    expect(hasRole("ADMIN", "MEMBER")).toBe(true);
    expect(hasRole("VIEWER", "MEMBER")).toBe(false);
    expect(slugify("Ácme Inc!")).toBe("acme-inc");
  });
});
