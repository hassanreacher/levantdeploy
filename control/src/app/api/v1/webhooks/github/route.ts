import { NextResponse } from "next/server";
import { handleGitHubWebhook, WebhookError } from "@/lib/github/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/webhooks/github — GitHub App webhook (push, pull_request, delete, installation*).
 * Authenticated by X-Hub-Signature-256 (HMAC of the raw body with the app's webhook secret); idempotent by X-GitHub-Delivery.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  if (rawBody.length > 25 * 1024 * 1024) return NextResponse.json({ error: { code: "TOO_LARGE", message: "Payload too large" } }, { status: 413 });
  try {
    const res = await handleGitHubWebhook({
      event: req.headers.get("x-github-event"),
      deliveryId: req.headers.get("x-github-delivery"),
      signature: req.headers.get("x-hub-signature-256"),
      rawBody,
    });
    return NextResponse.json({ ok: true, ...res }, { status: res.duplicate ? 200 : 202 });
  } catch (e) {
    if (e instanceof WebhookError) return NextResponse.json({ error: { code: "WEBHOOK", message: e.message } }, { status: e.status });
    console.error("[webhooks/github]", e);
    return NextResponse.json({ error: { code: "SERVER_ERROR", message: "Webhook processing failed" } }, { status: 500 });
  }
}
