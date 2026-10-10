"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { builderApi } from "@/lib/builder-ui/api";
import { errMessage } from "@/lib/builder-ui/errors";
import { ApiClientError } from "@/lib/client/api";
import type { BuilderProject } from "@/lib/builder-ui/types";
import { BuilderEditor } from "./editor";

/** Fetches the builder project (through the typed client, so mock mode works too) and mounts the editor. */
export function EditorLoader({ team, role, id }: { team: string; role: string; id: string }) {
  const [project, setProject] = useState<BuilderProject | null>(null);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);
  useEffect(() => {
    builderApi()
      .getProject(id)
      .then(
        (p) => {
          setProject(p);
          document.title = `${p.name} · Builder`;
        },
        (e) => setError({ status: e instanceof ApiClientError ? e.status : undefined, message: errMessage(e) }),
      );
  }, [id]);
  if (error)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
        <AlertTriangle className="mb-3 h-6 w-6 text-danger" />
        <p className="font-medium">{error.status === 404 ? "This app does not exist" : "Could not open the app"}</p>
        <p className="mt-1 text-[13px] text-muted">{error.status === 404 ? "It may have been deleted, or it belongs to another team." : error.message}</p>
        <Link href={`/${team}/build`} className="mt-4 text-[13px] underline underline-offset-4">
          Back to your apps
        </Link>
      </div>
    );
  if (!project)
    return (
      <div className="flex min-h-screen items-center justify-center" aria-busy>
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  return <BuilderEditor team={team} role={role} project={project} />;
}
