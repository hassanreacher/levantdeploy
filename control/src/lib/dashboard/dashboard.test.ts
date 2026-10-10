import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { envKeyError, parseDotenv, toDotenv } from "./env-vars";
import { maskedConfig, messageFor, signWebhook, CHANNEL_CONFIG, type NotifyPayload } from "./notify";
import { publicProtection, readProtection } from "./protection";
import { availableActions } from "@/components/dashboard/deployment-actions";
import { encryptJson } from "@/lib/crypto";

describe("dotenv", () => {
  it("parses exports, quotes, comments and multi-line values", () => {
    const env = parseDotenv(`# comment\nexport A=1\nB = "two words" # trailing\nC='single # not comment'\nD="line1\\nline2"\nE=plain # comment\nM="multi\nline"\nA=override\nnot a var\n`);
    const m = Object.fromEntries(env.map((e) => [e.key, e.value]));
    expect(m).toEqual({ A: "override", B: "two words", C: "single # not comment", D: "line1\nline2", E: "plain", M: "multi\nline" });
  });
  it("round-trips through toDotenv", () => {
    const vars = [{ key: "X", value: 'a "quoted" $val\nnext' }, { key: "Y", value: "" }, { key: "Z", value: "simple" }];
    const back = parseDotenv(toDotenv(vars));
    expect(back.map(({ key, value }) => ({ key, value }))).toEqual(vars);
  });
  it("validates keys", () => {
    expect(envKeyError("GOOD_KEY_1")).toBeNull();
    expect(envKeyError("1BAD")).toMatch(/digit/);
    expect(envKeyError("BAD-KEY")).not.toBeNull();
    expect(envKeyError("LEVANT_URL")).toMatch(/reserved/);
  });
});

describe("notifications", () => {
  it("signs webhooks verifiably", () => {
    const sig = signWebhook("s3cret", '{"a":1}', 1700000000);
    expect(sig).toBe(`t=1700000000,v1=${crypto.createHmac("sha256", "s3cret").update('1700000000.{"a":1}').digest("hex")}`);
  });
  it("masks channel configs", () => {
    expect(maskedConfig("WEBHOOK", encryptJson({ url: "https://x.dev/h", secret: "whsec_abcdef1234" }))).toEqual({ url: "https://x.dev/h", secret: "••••1234" });
    expect(maskedConfig("SLACK", encryptJson({ webhookUrl: "https://hooks.slack.com/services/T/B/SECRET" })).webhookUrl).toBe("https://hooks.slack.com/…");
    expect(maskedConfig("TELEGRAM", encryptJson({ botToken: "123:abcdefghijklmnopqrstu", chatId: "-100" }))).toEqual({ botToken: "••••rstu", chatId: "-100" });
  });
  it("validates channel configs", () => {
    expect(CHANNEL_CONFIG.TELEGRAM.safeParse({ botToken: "nope", chatId: "1" }).success).toBe(false);
    expect(CHANNEL_CONFIG.EMAIL.safeParse({ to: ["a@b.co"] }).success).toBe(true);
    expect(CHANNEL_CONFIG.WEBHOOK.safeParse({ url: "ftp://x", secret: "12345678" }).success).toBe(false);
  });
  it("formats messages", () => {
    const p: NotifyPayload = {
      id: "evt",
      event: "deployment.error",
      createdAt: "",
      team: { id: "t", slug: "t", name: "T" },
      project: { id: "p", slug: "shop", name: "shop" },
      deployment: { id: "d", number: 7, shortId: "abc", status: "ERROR", target: "PRODUCTION", url: "https://x", branch: "main", commitSha: "0123456789", commitMessage: "fix it\nbody", commitAuthor: "Lina", errorMessage: "boom", errorStep: "BUILD", durationMs: 61000, inspectUrl: "https://dash/x" },
    };
    const m = messageFor(p);
    expect(m.ok).toBe(false);
    expect(m.title).toContain("Production deployment #7 failed");
    expect(m.text).toContain("main @ 0123456");
    expect(m.text).toContain("Error (build): boom");
    expect(m.text).toContain("1m 1s");
  });
});

describe("protection", () => {
  it("defaults and hides the hash", () => {
    expect(readProtection(null)).toEqual({ mode: "none", scope: "previews" });
    expect(publicProtection({ mode: "basic", scope: "all", username: "u", passwordHash: "$2a$..." })).toMatchObject({ mode: "basic", hasPassword: true, username: "u" });
    expect(JSON.stringify(publicProtection({ mode: "password", passwordHash: "$2a$x" }))).not.toContain("$2a$");
  });
});

describe("deployment actions gating", () => {
  const base = { id: "d", number: 1, shortId: "a", url: "x", isCurrentProduction: false };
  it("matches status/target", () => {
    expect(availableActions({ ...base, status: "READY", target: "PREVIEW" }, true)).toMatchObject({ promote: true, rollback: false, cancel: false, redeploy: true });
    expect(availableActions({ ...base, status: "SUPERSEDED", target: "PRODUCTION" }, true)).toMatchObject({ rollback: true, promote: false });
    expect(availableActions({ ...base, status: "READY", target: "PRODUCTION", isCurrentProduction: true }, true)).toMatchObject({ rollback: false, stop: false, restart: true });
    expect(availableActions({ ...base, status: "BUILDING", target: "PREVIEW" }, true)).toMatchObject({ cancel: true, redeploy: false });
    expect(availableActions({ ...base, status: "READY", target: "PREVIEW" }, false)).toMatchObject({ promote: false, redeploy: false, visit: true });
  });
});
