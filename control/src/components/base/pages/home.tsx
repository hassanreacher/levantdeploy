import Link from "next/link";
import { ArrowRight, Code2, Database, PauseCircle, Server, TriangleAlert, Users } from "lucide-react";
import { db } from "@/lib/db";
import { hasRole } from "@/lib/auth/roles";
import type { BasePageContext } from "@/lib/base-ui/access";
import { baseKeys, serviceHealth } from "@/lib/base-ui/adapters";
import { eventDTO } from "@/lib/base-ui/dto";
import { Card } from "@/components/ui/card";
import { PageBody } from "@/components/shell/page-header";
import { formatBytes } from "@/lib/utils";
import { BaseHeader } from "./header";
import { ApiKeysCard, EventTimeline, HealthGrid, OpenStudioButton, ProvisioningScreen, QuickStart } from "../home-client";
import { ResumeButton } from "../settings-client";

export async function BaseHomePage({ ctx }: { ctx: BasePageContext }) {
  const { base, role } = ctx;
  const events = (await db.baseEvent.findMany({ where: { baseProjectId: base.id }, orderBy: { createdAt: "desc" }, take: 40 })).map(eventDTO);
  if (base.status === "PROVISIONING") {
    return (
      <>
        <BaseHeader ctx={ctx} title={base.name} />
        <PageBody>
          <ProvisioningScreen refId={base.ref} name={base.name} url={base.apiUrl} initial={events} createdAt={base.createdAt} />
        </PageBody>
      </>
    );
  }
  const [keys, health, usage, fnCount] = await Promise.all([
    baseKeys(base.ref).catch(() => ({ anonKey: "", url: base.apiUrl })),
    serviceHealth(base.ref).catch(() => []),
    db.baseUsageSample.findFirst({ where: { baseProjectId: base.id }, orderBy: { at: "desc" } }),
    db.baseFunction.count({ where: { baseProjectId: base.id } }),
  ]);
  const canStudio = hasRole(role, "MEMBER");
  const running = base.status === "ACTIVE";
  return (
    <>
      <BaseHeader
        ctx={ctx}
        title={base.name}
        actions={canStudio ? <OpenStudioButton refId={base.ref} disabled={!running} /> : undefined}
      />
      <PageBody className="space-y-6">
        {base.status === "PAUSED" && (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center" role="status">
            <PauseCircle className="h-4 w-4 shrink-0 text-muted" />
            <p className="flex-1 text-[13px]">This project is paused. Its API is offline; data is kept. Restore it to bring every service back.</p>
            {hasRole(role, "ADMIN") && <ResumeButton refId={base.ref} />}
          </div>
        )}
        {base.status === "ERROR" && (
          <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3" role="alert">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div className="text-[13px]">
              <div className="font-medium">The project is in an error state</div>
              <div className="text-muted">{base.errorMessage ?? "See the activity log and service logs for details."}</div>
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={<Server className="h-4 w-4" />} label="Region" value={base.region} />
          <Stat icon={<Database className="h-4 w-4" />} label="Database" value={usage ? formatBytes(Number(usage.dbSizeBytes)) : "—"} href={`${ctx.basePath}/database`} />
          <Stat icon={<Code2 className="h-4 w-4" />} label="Edge Functions" value={String(fnCount)} href={`${ctx.basePath}/functions`} />
          <Stat icon={<Users className="h-4 w-4" />} label="Monthly active users" value={usage ? usage.mau.toLocaleString() : "0"} href={`${ctx.basePath}/usage`} />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            <ApiKeysCard refId={base.ref} url={base.apiUrl} anonKey={keys.anonKey} canReveal={hasRole(role, "ADMIN")} />
            <QuickStart url={base.apiUrl} anonKey={keys.anonKey} />
            <HealthGrid refId={base.ref} initial={health} />
          </div>
          <div className="min-w-0 space-y-6">
            {ctx.project ? null : base.project ? (
              <Card className="p-5">
                <div className="text-[13px] text-muted">Backend of</div>
                <Link href={`/${ctx.team.slug}/${base.project.slug}`} className="mt-1 inline-flex items-center gap-1.5 font-medium hover:underline">
                  {base.project.name} <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Card>
            ) : null}
            <EventTimeline refId={base.ref} initial={events} />
          </div>
        </div>
      </PageBody>
    </>
  );
}

function Stat({ icon, label, value, href }: { icon: React.ReactNode; label: string; value: string; href?: string }) {
  const inner = (
    <Card interactive={!!href} className="flex items-center gap-3 p-4">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg-subtle text-muted">{icon}</span>
      <div className="min-w-0">
        <div className="text-[12px] text-muted">{label}</div>
        <div className="truncate text-[15px] font-semibold tracking-tight">{value}</div>
      </div>
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
