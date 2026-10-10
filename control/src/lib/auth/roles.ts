import type { TeamRole } from "@prisma/client";

/** VIEWER < MEMBER < ADMIN < OWNER */
export const ROLE_RANK: Record<TeamRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
export const ROLES: TeamRole[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

export const hasRole = (role: TeamRole, min: TeamRole) => ROLE_RANK[role] >= ROLE_RANK[min];

export const ROLE_LABEL: Record<TeamRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

export const ROLE_HELP: Record<TeamRole, string> = {
  OWNER: "Full access, billing-free ownership, can delete the team",
  ADMIN: "Manage members, domains, settings and all projects",
  MEMBER: "Create projects, deploy, manage env vars",
  VIEWER: "Read-only access to projects, deployments and logs",
};
