import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  const [pg, rd, worker] = await Promise.all([
    db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redis().ping().then((r) => r === "PONG").catch(() => false),
    redis().get("ld:worker:heartbeat").then((v) => (v ? Number(v) : null)).catch(() => null),
  ]);
  const ok = pg && rd;
  return NextResponse.json({ ok, postgres: pg, redis: rd, workerSeenAt: worker }, { status: ok ? 200 : 503 });
}
