import type { Resource } from "./limits";
import { RESOURCE_LABEL } from "./limits";

/**
 * Errors thrown by the enforcement hooks. Worker-safe (no next/* imports).
 * `route()` (src/lib/http.ts → errorResponse) renders any error exposing `publicError()` as
 *   HTTP 402 { error: { code: "PLAN_LIMIT", message, resource, limit, used, plan, upgradeUrl } }
 *   HTTP 403 { error: { code: "EMAIL_UNVERIFIED", message, resendUrl } }
 */
export type PublicError = { status: number; body: { code: string; message: string } & Record<string, unknown> };

export class PlanLimitError extends Error {
  readonly code = "PLAN_LIMIT";
  constructor(
    public resource: Resource | string,
    public limit: number | null,
    public used: number,
    public plan: { slug: string; name: string },
    public teamSlug: string | null = null,
    message?: string,
  ) {
    super(message ?? defaultMessage(resource, limit, used, plan.name));
  }
  get status() {
    return 402;
  }
  publicError(): PublicError {
    return {
      status: 402,
      body: {
        code: "PLAN_LIMIT",
        message: this.message,
        resource: this.resource,
        limit: this.limit,
        used: this.used,
        plan: this.plan,
        upgradeUrl: this.teamSlug ? `/${this.teamSlug}/settings/plan` : null,
      },
    };
  }
}

export class EmailUnverifiedError extends Error {
  readonly code = "EMAIL_UNVERIFIED";
  constructor(message = "Verify your email address first — we sent you a link. You can resend it from the banner at the top of the dashboard.") {
    super(message);
  }
  get status() {
    return 403;
  }
  publicError(): PublicError {
    return { status: 403, body: { code: "EMAIL_UNVERIFIED", message: this.message, resendUrl: "/api/v1/auth/verify-email/resend" } };
  }
}

function defaultMessage(resource: string, limit: number | null, used: number, planName: string) {
  const label = (RESOURCE_LABEL as Record<string, string>)[resource] ?? resource;
  if (resource === "deploy.bandwidthGbMonth") return `This team used its monthly bandwidth on the ${planName} plan — new deployments are paused until the next month or an upgrade.`;
  if (resource === "deploy.uploadMb" || resource === "base.maxUploadMb") return `The upload is larger than the ${planName} plan allows (${limit} MB).`;
  if (resource === "deploy.previewDeployments") return `Preview deployments are not included in the ${planName} plan.`;
  if (resource === "base.publicDbPort") return `A public database port is not included in the ${planName} plan.`;
  return `You've reached the ${planName} plan limit for ${label.toLowerCase()} (${used}/${limit}). Upgrade the plan in Settings → Plan & Usage.`;
}

export const isPlanLimitError = (e: unknown): e is PlanLimitError => e instanceof PlanLimitError || (!!e && typeof e === "object" && (e as { code?: unknown }).code === "PLAN_LIMIT");
