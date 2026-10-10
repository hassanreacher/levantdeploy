import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { assert, check, client, eq, ok, until, uniq } from "./lib";
import type { Ctx } from "./auth";

function subscribed(ch: RealtimeChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("subscribe timeout")), 25_000);
    ch.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(t);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(t);
        reject(new Error(`channel ${status}${err ? `: ${err.message}` : ""}`));
      }
    });
  });
}

export async function realtimeSuite(ctx: Ctx) {
  const R = "realtime";
  const { a, b } = ctx.users;
  const clients: SupabaseClient[] = [];
  try {
    // ── postgres_changes ──
    const events: Array<{ eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }> = [];
    const room = uniq("room");
    const listener = client(ctx.url, ctx.anonKey);
    clients.push(listener);
    await listener.realtime.setAuth(b.token);
    let pgReady = false;
    const ch = listener
      .channel(uniq("db-changes"))
      .on("postgres_changes", { event: "*", schema: "public", table: "compat_messages", filter: `room=eq.${room}` }, (p) =>
        events.push({ eventType: p.eventType, new: p.new as Record<string, unknown>, old: p.old as Record<string, unknown> }),
      )
      // the server confirms with a `system` message once the replication subscription is live (SUBSCRIBED = joined)
      .on("system", {}, (m: { extension?: string; status?: string }) => {
        if (m.extension === "postgres_changes" && m.status === "ok") pgReady = true;
      });
    const okSub = await check(R, "subscribe to postgres_changes (authenticated, RLS-checked) + system 'Subscribed to PostgreSQL'", async () => {
      const t0 = Date.now();
      await subscribed(ch);
      await until(async () => pgReady, "postgres_changes system ok", 30_000, 100);
      return `ready after ${Date.now() - t0} ms`;
    });
    if (okSub) {
      let id = 0;
      await check(R, "postgres_changes INSERT received", async () => {
        const row = ok(await a.sb.from("compat_messages").insert({ room, body: "hello" }).select("id").single(), "insert");
        id = row.id as number;
        const e = await until(async () => events.find((x) => x.eventType === "INSERT"), "INSERT event", 20_000);
        eq(e.new.body, "hello", "new.body");
      });
      await check(R, "postgres_changes UPDATE received (with old record — replica identity full)", async () => {
        ok(await a.sb.from("compat_messages").update({ body: "edited" }).eq("id", id), "update");
        const e = await until(async () => events.find((x) => x.eventType === "UPDATE"), "UPDATE event", 20_000);
        eq(e.new.body, "edited", "new.body");
        eq(e.old.body, "hello", "old.body");
      });
      await check(R, "postgres_changes DELETE received", async () => {
        ok(await a.sb.from("compat_messages").delete().eq("id", id), "delete");
        const e = await until(async () => events.find((x) => x.eventType === "DELETE"), "DELETE event", 20_000);
        eq(e.old.id, id, "old.id");
      });
      await check(R, "postgres_changes respects RLS (anon listener gets no rows)", async () => {
        const anonEvents: unknown[] = [];
        const anonL = client(ctx.url, ctx.anonKey);
        clients.push(anonL);
        let ready = false;
        const ach = anonL
          .channel(uniq("anon-changes"))
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "compat_messages", filter: `room=eq.${room}` }, (p) => anonEvents.push(p))
          .on("system", {}, (m: { extension?: string; status?: string }) => {
            if (m.extension === "postgres_changes" && m.status === "ok") ready = true;
          });
        await subscribed(ach);
        await until(async () => ready, "anon postgres_changes system ok", 30_000, 100);
        events.length = 0;
        ok(await a.sb.from("compat_messages").insert({ room, body: "secret" }), "insert");
        await until(async () => events.find((x) => x.eventType === "INSERT"), "authenticated listener INSERT", 20_000);
        await new Promise((r) => setTimeout(r, 2000));
        eq(anonEvents.length, 0, "events delivered to anon");
      });
    }

    // ── broadcast ──
    await check(R, "broadcast between two clients", async () => {
      const topic = uniq("chat");
      const c1 = client(ctx.url, ctx.anonKey);
      const c2 = client(ctx.url, ctx.anonKey);
      clients.push(c1, c2);
      const got: unknown[] = [];
      const ch1 = c1.channel(topic, { config: { broadcast: { self: false, ack: true } } });
      const ch2 = c2.channel(topic).on("broadcast", { event: "ping" }, (m) => got.push(m.payload));
      await subscribed(ch2);
      await subscribed(ch1);
      const r = await ch1.send({ type: "broadcast", event: "ping", payload: { n: 1, text: "marhaba" } });
      eq(r, "ok", "send ack");
      const p = await until(async () => got[0] as { text: string } | undefined, "broadcast message", 15_000);
      eq(p.text, "marhaba", "payload");
    });

    await check(R, "broadcast via REST (httpSend, no socket)", async () => {
      const topic = uniq("rest");
      const c1 = client(ctx.url, ctx.anonKey);
      clients.push(c1);
      const got: unknown[] = [];
      const ch = c1.channel(topic).on("broadcast", { event: "server" }, (m) => got.push(m.payload));
      await subscribed(ch);
      const sender = client(ctx.url, ctx.serviceKey).channel(topic);
      const r = await sender.httpSend("server", { from: "rest" });
      assert(r.success, `httpSend failed: ${JSON.stringify(r)}`);
      await until(async () => got.length > 0, "REST broadcast", 15_000);
    });

    // ── presence ──
    await check(R, "presence sync between two clients", async () => {
      const topic = uniq("presence");
      const c1 = client(ctx.url, ctx.anonKey);
      const c2 = client(ctx.url, ctx.anonKey);
      clients.push(c1, c2);
      const ch1 = c1.channel(topic, { config: { presence: { key: "alice" } } });
      const ch2 = c2.channel(topic, { config: { presence: { key: "bob" } } });
      let synced1 = false;
      ch1.on("presence", { event: "sync" }, () => (synced1 = true));
      await subscribed(ch1);
      await subscribed(ch2);
      eq(await ch1.track({ online_at: new Date().toISOString(), name: "alice" }), "ok", "track alice");
      eq(await ch2.track({ online_at: new Date().toISOString(), name: "bob" }), "ok", "track bob");
      const state = await until(async () => {
        const s = ch1.presenceState();
        return Object.keys(s).length === 2 ? s : null;
      }, "two presences", 15_000);
      assert(synced1, "no sync event");
      eq(Object.keys(state).sort(), ["alice", "bob"], "presence keys");
      await ch2.untrack();
      await until(async () => Object.keys(ch1.presenceState()).length === 1, "leave", 15_000);
      return "join + leave seen";
    });
  } finally {
    for (const c of clients) await c.removeAllChannels().catch(() => {});
  }
}
