import type { Template } from "@/lib/git/templates";

export type Detection = {
  framework: string;
  frameworkName: string;
  kind: "WEB" | "WORKER" | "STATIC" | "COMPOSE";
  port: number;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDirectory?: string | null;
  notes: string[];
  rootDirectories?: string[];
};

export type Installation = { installationId: number; accountLogin: string; accountType: string; accountAvatar: string | null; suspended: boolean };

export type Selection =
  | { kind: "github"; installationId: number; repo: { id: number; fullName: string; defaultBranch: string; private: boolean } }
  | { kind: "git"; url: string; token: string | null; tokenUsername: string | null; deployKeyId: string | null; branches: string[]; defaultBranch: string | null; name: string; detection: Detection | null }
  | { kind: "upload"; uploadId: string; label: string; size: number; files: number | null }
  | { kind: "image"; image: string; port: number }
  | { kind: "template"; template: Template };

export type { Template };
