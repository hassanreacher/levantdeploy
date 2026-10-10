import type { Deployment, DeploymentStatus } from "@prisma/client";

/**
 * Tiny in-process hook registry for deployment status changes (git area).
 *
 *   onStatusChange(async (deployment, from) => { ... });   // register (module side effect)
 *   await emitStatusChange(deployment, from);               // called by setStatus() in src/lib/deployments.ts
 *
 * Hooks run fire-and-forget from setStatus: they never block or fail a transition (errors are logged).
 * Modules listed in DEFAULT_HOOK_MODULES are imported lazily on the first emit so that every process
 * (Next.js server and worker) gets the same hooks without wiring imports in each entrypoint.
 */
export type StatusHook = (deployment: Deployment, from: DeploymentStatus | null) => Promise<void> | void;

const g = globalThis as unknown as { __ldStatusHooks?: StatusHook[]; __ldHooksLoaded?: Promise<void> | null };
const hooks = (g.__ldStatusHooks ??= []);

/** Lazily-loaded modules that register hooks (side-effect imports). */
const DEFAULT_HOOK_MODULES: Array<() => Promise<unknown>> = [() => import("@/lib/github/status")];

export function onStatusChange(fn: StatusHook): () => void {
  if (!hooks.includes(fn)) hooks.push(fn);
  return () => {
    const i = hooks.indexOf(fn);
    if (i >= 0) hooks.splice(i, 1);
  };
}

async function loadDefaults() {
  g.__ldHooksLoaded ??= (async () => {
    for (const load of DEFAULT_HOOK_MODULES) {
      try {
        await load();
      } catch (e) {
        console.warn("[hooks] failed to load hook module:", (e as Error).message);
      }
    }
  })();
  await g.__ldHooksLoaded;
}

/** Runs every registered hook; never throws. */
export async function emitStatusChange(deployment: Deployment, from: DeploymentStatus | null): Promise<void> {
  await loadDefaults();
  await Promise.all(
    hooks.map(async (h) => {
      try {
        await h(deployment, from);
      } catch (e) {
        console.warn("[hooks] status hook failed:", (e as Error).message);
      }
    }),
  );
}
