/**
 * Tiny authoritative fake DNS server (UDP) for domain-verification tests.
 *   const srv = await startFakeDns({ "example.com": { A: ["203.0.113.10"] }, "_levant-verify.example.com": { TXT: ["tok"] } });
 *   createResolverLookup([`127.0.0.1:${srv.port}`])  …  srv.set(records) … await srv.close();
 * Standalone (e2e): `npx tsx tests/runtime/fake-dns.ts 5353 records.json` (the JSON file is re-read on every query).
 * Supports A, AAAA, CNAME (followed for A/AAAA queries), TXT; unknown names → NXDOMAIN.
 */
import dgram from "node:dgram";
import fs from "node:fs";

export type FakeRecords = Record<string, { A?: string[]; AAAA?: string[]; CNAME?: string; TXT?: string[] }>;

const T = { A: 1, CNAME: 5, TXT: 16, AAAA: 28 } as const;

function readName(buf: Buffer, off: number): [string, number] {
  const labels: string[] = [];
  let i = off;
  for (;;) {
    const len = buf[i]!;
    if (len === 0) return [labels.join("."), i + 1];
    labels.push(buf.subarray(i + 1, i + 1 + len).toString("ascii"));
    i += len + 1;
  }
}

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".").filter(Boolean);
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, "ascii")])), Buffer.from([0])]);
}

function ipv6Bytes(ip: string): Buffer {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return b;
}

function rr(name: string, type: number, rdata: Buffer, ttl = 60): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

export function answer(query: Buffer, records: FakeRecords): Buffer {
  const id = query.readUInt16BE(0);
  const [qname, end] = readName(query, 12);
  const qtype = query.readUInt16BE(end);
  const question = query.subarray(12, end + 4);
  const name = qname.toLowerCase();
  const answers: Buffer[] = [];
  let rcode = 0;
  // exact name, else a wildcard record one level up (`*.example.com` answers `x.example.com`)
  const dot = name.indexOf(".");
  const rec = records[name] ?? (dot > 0 ? records[`*.${name.slice(dot + 1)}`] : undefined);
  if (!rec) rcode = 3;
  else {
    let target = name;
    let r = rec;
    if (r.CNAME && qtype !== T.CNAME) {
      answers.push(rr(name, T.CNAME, encodeName(r.CNAME)));
      target = r.CNAME.toLowerCase();
      const td = target.indexOf(".");
      r = records[target] ?? (td > 0 ? records[`*.${target.slice(td + 1)}`] : undefined) ?? {};
    }
    if (qtype === T.A) for (const ip of r.A ?? []) answers.push(rr(target, T.A, Buffer.from(ip.split(".").map(Number))));
    if (qtype === T.AAAA) for (const ip of r.AAAA ?? []) answers.push(rr(target, T.AAAA, ipv6Bytes(ip)));
    if (qtype === T.CNAME && rec.CNAME) answers.push(rr(name, T.CNAME, encodeName(rec.CNAME)));
    if (qtype === T.TXT)
      for (const t of rec.TXT ?? []) {
        const chunks: Buffer[] = [];
        for (let i = 0; i < t.length || i === 0; i += 255) {
          const s = Buffer.from(t.slice(i, i + 255));
          chunks.push(Buffer.from([s.length]), s);
          if (t.length === 0) break;
        }
        answers.push(rr(name, T.TXT, Buffer.concat(chunks)));
      }
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180 | rcode, 2); // QR, RD, RA (+ rcode)
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, question, ...answers]);
}

export async function startFakeDns(initial: FakeRecords | (() => FakeRecords), port = 0) {
  let records = initial;
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    try {
      const recs = typeof records === "function" ? records() : records;
      sock.send(answer(msg, recs), rinfo.port, rinfo.address);
    } catch {
      /* malformed */
    }
  });
  await new Promise<void>((res) => sock.bind(port, "127.0.0.1", () => res()));
  return {
    port: (sock.address() as { port: number }).port,
    set(r: FakeRecords) {
      records = r;
    },
    close: () => new Promise<void>((res) => sock.close(() => res())),
  };
}

// standalone
if (process.argv[1]?.endsWith("fake-dns.ts") && process.argv[2]) {
  const port = Number(process.argv[2]);
  const file = process.argv[3]!;
  void startFakeDns(() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as FakeRecords;
    } catch {
      return {};
    }
  }, port).then((s) => console.log(`fake DNS on 127.0.0.1:${s.port} (records: ${file})`));
}
