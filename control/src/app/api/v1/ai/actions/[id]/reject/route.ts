import { route } from "@/lib/http";
import { handleDecision } from "@/lib/ai/action-route";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** POST /api/v1/ai/actions/:id/reject { reason? } → the agent is told the user rejected it and continues (SSE). */
export const POST = route<{ id: string }>(async (req, { params }) => handleDecision(req, (await params).id, "reject"));
