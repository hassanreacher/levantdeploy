import { platformBuildView } from "@/lib/build/platform";
import { PlatformBuildSettings } from "./build-client";

export const metadata = { title: "Build · Platform Settings" };

// Build area: build proxy / extra CA / Docker Hub mirror (API: /api/v1/platform/build). Concurrency + timeout live on Limits (ops).
export default async function PlatformBuildSettingsPage() {
  return <PlatformBuildSettings initial={await platformBuildView()} />;
}
