import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { hasRole } from "@/lib/auth/roles";
import type { BasePageContext } from "@/lib/base-ui/access";
import { baseLimits, functionSource, listFunctionSecrets } from "@/lib/base-ui/adapters";
import { functionDTO } from "@/lib/base-ui/dto";
import { PageBody } from "@/components/shell/page-header";
import { BaseHeader } from "./header";
import { FunctionsList, FunctionSecrets } from "../functions-client";
import { FunctionEditor } from "../function-editor";

export async function BaseFunctionsPage({ ctx }: { ctx: BasePageContext }) {
  const { base, role } = ctx;
  const canUse = hasRole(role, "MEMBER");
  const [rows, limits, secrets] = await Promise.all([
    db.baseFunction.findMany({ where: { baseProjectId: base.id }, orderBy: { slug: "asc" } }),
    baseLimits(ctx.team.id),
    canUse ? listFunctionSecrets(base.ref).catch(() => []) : Promise.resolve([]),
  ]);
  return (
    <>
      <BaseHeader ctx={ctx} title="Edge Functions" />
      <PageBody className="space-y-6">
        <FunctionsList
          refId={base.ref}
          basePath={ctx.basePath}
          items={rows.map((f) => functionDTO(base.ref, f, base.apiUrl))}
          canUse={canUse}
          running={base.status === "ACTIVE"}
          limit={limits.functions}
        />
        {canUse && <FunctionSecrets refId={base.ref} initial={secrets.map((s) => s.name)} canEdit={hasRole(role, "ADMIN")} />}
      </PageBody>
    </>
  );
}

export async function BaseFunctionPage({ ctx, slug }: { ctx: BasePageContext; slug: string }) {
  const { base, role } = ctx;
  const fn = await db.baseFunction.findUnique({ where: { baseProjectId_slug: { baseProjectId: base.id, slug } } });
  if (!fn) notFound();
  const canUse = hasRole(role, "MEMBER");
  const code = canUse ? ((await functionSource(base.ref, slug).catch(() => null)) ?? "") : "";
  return (
    <>
      <BaseHeader ctx={ctx} title={fn.name} description={<span className="break-all font-mono text-[12px]">{`${base.apiUrl}/functions/v1/${fn.slug}`}</span>} />
      <PageBody>
        <FunctionEditor
          refId={base.ref}
          basePath={ctx.basePath}
          fn={functionDTO(base.ref, fn, base.apiUrl)}
          initialCode={code}
          canUse={canUse}
          canUseServiceKey={hasRole(role, "ADMIN")}
          running={base.status === "ACTIVE"}
        />
      </PageBody>
    </>
  );
}
