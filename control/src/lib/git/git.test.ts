import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { parseGitUrl, redactGitUrl, defaultTokenUsername, repoNameFromUrl, githubFullName } from "./url";
import { generateDeployKey, decodeOpenSshEd25519 } from "./deploy-keys";
import { diffHeads } from "./polling-diff";

describe("git URLs", () => {
  it("parses https, ssh and scp-like URLs", () => {
    expect(parseGitUrl("https://github.com/acme/web.git")).toMatchObject({ protocol: "https", host: "github.com", path: "acme/web", isSsh: false });
    expect(parseGitUrl("https://user:pass@gitlab.com/g/sub/proj")).toMatchObject({ host: "gitlab.com", path: "g/sub/proj", clean: "https://gitlab.com/g/sub/proj" });
    expect(parseGitUrl("git@bitbucket.org:team/repo.git")).toMatchObject({ protocol: "ssh", host: "bitbucket.org", path: "team/repo", isSsh: true, user: "git" });
    expect(parseGitUrl("ssh://git@git.example.com:2222/a/b.git")).toMatchObject({ protocol: "ssh", host: "git.example.com", path: "a/b", isSsh: true });
  });
  it("rejects option injection and junk", () => {
    for (const bad of ["--upload-pack=touch /tmp/x", "-c foo", "ftp://x/y", "not a url", "https://", "ext::sh -c touch"]) expect(parseGitUrl(bad)).toBeNull();
  });
  it("redacts credentials and picks token usernames", () => {
    expect(redactGitUrl("https://x-access-token:ghs_abc@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(defaultTokenUsername("gitlab.com")).toBe("oauth2");
    expect(defaultTokenUsername("bitbucket.org")).toBe("x-token-auth");
    expect(repoNameFromUrl("git@github.com:o/my-app.git")).toBe("my-app");
    expect(githubFullName("https://github.com/o/r.git")).toBe("o/r");
    expect(githubFullName("https://gitlab.com/o/r.git")).toBeNull();
  });
});

describe("deploy keys", () => {
  it("generates a valid OpenSSH ed25519 key pair", () => {
    const k = generateDeployKey("levant-test");
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* levant-test$/);
    expect(k.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    // round-trip: the private seed must derive the advertised public key, and sign/verify must work
    const { seed, pub, comment } = decodeOpenSshEd25519(k.privateKey);
    expect(comment).toBe("levant-test");
    const priv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: pub.toString("base64url") }, format: "jwk" });
    const derived = Buffer.from(crypto.createPublicKey(priv).export({ format: "jwk" }).x!, "base64url");
    expect(derived.equals(pub)).toBe(true);
    const blob = Buffer.from(k.publicKey.split(" ")[1]!, "base64");
    expect(blob.subarray(blob.length - 32).equals(pub)).toBe(true);
    const sig = crypto.sign(null, Buffer.from("hello"), priv);
    expect(crypto.verify(null, Buffer.from("hello"), crypto.createPublicKey(priv), sig)).toBe(true);
  });
});

describe("branch polling diff", () => {
  it("detects moved, new and deleted branches", () => {
    expect(diffHeads({ main: "a", dev: "b", old: "c" }, { main: "a2", dev: "b", feat: "d" })).toEqual({ changed: ["main", "feat"], deleted: ["old"] });
    expect(diffHeads({}, { main: "a" })).toEqual({ changed: ["main"], deleted: [] });
  });
});
