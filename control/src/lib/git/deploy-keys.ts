import crypto from "node:crypto";

/**
 * ed25519 deploy keys in OpenSSH format, generated with node:crypto (no ssh-keygen needed).
 *   const { publicKey, privateKey } = generateDeployKey("levant-myproject");
 *   publicKey  → "ssh-ed25519 AAAAC3Nz… levant-myproject"   (shown to the user, added to the repo as a read-only deploy key)
 *   privateKey → "-----BEGIN OPENSSH PRIVATE KEY-----…"     (stored encrypted in Project.gitDeployKeyEnc)
 */

function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function sshString(data: Buffer | string) {
  const b = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([u32(b.length), b]);
}

export function generateDeployKey(comment = "levantdeploy"): { publicKey: string; privateKey: string; fingerprint: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  return encodeOpenSsh(seed, pub, comment);
}

export function encodeOpenSsh(seed: Buffer, pub: Buffer, comment: string) {
  const keyType = "ssh-ed25519";
  const pubBlob = Buffer.concat([sshString(keyType), sshString(pub)]);
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, sshString(keyType), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = blob.toString("base64").replace(/(.{70})/g, "$1\n").replace(/\n$/, "");
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const publicKey = `${keyType} ${pubBlob.toString("base64")} ${comment}`;
  const fingerprint = "SHA256:" + crypto.createHash("sha256").update(pubBlob).digest("base64").replace(/=+$/, "");
  return { publicKey, privateKey, fingerprint };
}

/** Parses an OpenSSH ed25519 private key back to (seed, pub) — used by tests to verify round-trips. */
export function decodeOpenSshEd25519(pem: string): { seed: Buffer; pub: Buffer; comment: string } {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");
  let o = 0;
  const magic = buf.subarray(0, 15).toString();
  if (magic !== "openssh-key-v1\0") throw new Error("not an openssh key");
  o = 15;
  const str = () => {
    const n = buf.readUInt32BE(o);
    o += 4;
    const v = buf.subarray(o, o + n);
    o += n;
    return v;
  };
  str(); // cipher
  str(); // kdf
  str(); // kdf opts
  o += 4; // nkeys
  str(); // pub blob
  const priv = str();
  let p = 8;
  const pstr = () => {
    const n = priv.readUInt32BE(p);
    p += 4;
    const v = priv.subarray(p, p + n);
    p += n;
    return v;
  };
  pstr(); // type
  const pub = pstr();
  const sk = pstr();
  const comment = pstr().toString();
  return { seed: sk.subarray(0, 32), pub, comment };
}
