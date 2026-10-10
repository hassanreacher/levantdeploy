import { route, json, requireProjectRole } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { encryptString } from "@/lib/crypto";
import { generateDeployKey } from "@/lib/git/deploy-keys";

export const dynamic = "force-dynamic";

/** POST /api/v1/projects/:id/git/deploy-key — (re)generate the project's ed25519 deploy key → { publicKey, fingerprint } */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  const k = generateDeployKey(`levantdeploy-${project.slug}`);
  await db.project.update({ where: { id: project.id }, data: { gitDeployKeyPublic: k.publicKey, gitDeployKeyEnc: encryptString(k.privateKey) } });
  await audit({ action: "project.deploy_key_rotate", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { fingerprint: k.fingerprint } });
  return json({ publicKey: k.publicKey, fingerprint: k.fingerprint }, 201);
});
