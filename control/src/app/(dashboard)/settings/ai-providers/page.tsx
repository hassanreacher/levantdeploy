import { overview, usageStats } from "@/lib/llm/admin";
import { AiProvidersSettings } from "./ai-providers-client";

export const metadata = { title: "AI providers · Platform Settings" };

// llm area: LLM providers for the Builder agents (keys encrypted, masked), routing preferences and usage.
// API: /api/v1/platform/ai-providers/** — library: src/lib/llm.
export default async function AiProvidersPage() {
  const [data, usage] = await Promise.all([overview(), usageStats("24h")]);
  return <AiProvidersSettings initial={JSON.parse(JSON.stringify(data))} initialUsage={usage} />;
}
