import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { getSetting } from "@/lib/settings";
import { RuntimeSettings } from "@/components/dashboard/project-settings";

export const metadata = { title: "Runtime Settings" };

export default async function RuntimeSettingsPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: p } = await params;
  const { project, role } = await getProjectContext(team, p);
  const limits = await getSetting("limits.defaults");
  return (
    <RuntimeSettings
      projectId={project.id}
      canWrite={hasRole(role, "MEMBER")}
      maxReplicas={limits.maxReplicas}
      values={{
        port: project.port,
        healthcheckPath: project.healthcheckPath,
        replicas: project.replicas,
        cpuLimit: project.cpuLimit,
        memoryLimitMb: project.memoryLimitMb,
        restartPolicy: project.restartPolicy,
        autoDeploy: project.autoDeploy,
        previewDeployments: project.previewDeployments,
        kind: project.kind,
      }}
    />
  );
}
