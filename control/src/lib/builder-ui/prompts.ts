/** builder-ui: prompt suggestions + the pending-prompt hand-off used by the landing CTA (sign up → continue). */

export const PROMPT_SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: "Restaurant site with online orders", prompt: "A restaurant website with a menu, online ordering for pickup and an admin page to manage orders" },
  { label: "SaaS landing page", prompt: "A modern SaaS landing page with hero, features, pricing, testimonials and FAQ" },
  { label: "Habit tracker", prompt: "A habit tracker where users sign up, add habits, check them off daily and see streaks" },
  { label: "Client portal", prompt: "A client portal where my clients log in, see their invoices and upload documents" },
  { label: "Event RSVP", prompt: "An event page with schedule, speakers and an RSVP form that saves guests to a database" },
  { label: "Personal portfolio", prompt: "A personal portfolio with projects, a blog and a contact form" },
];

export const PENDING_KEY = "ld-builder-pending";
export type PendingPrompt = { prompt: string; template?: string; visibility?: "public" | "private"; at: number };

export function savePending(p: Omit<PendingPrompt, "at">) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, at: Date.now() }));
  } catch {}
}

/** Pending prompt saved less than 2 hours ago (consumed on read). */
export function takePending(): PendingPrompt | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    localStorage.removeItem(PENDING_KEY);
    const p = JSON.parse(raw) as PendingPrompt;
    if (!p?.prompt || Date.now() - p.at > 2 * 3600_000) return null;
    return p;
  } catch {
    return null;
  }
}

export function peekPending(): boolean {
  try {
    return !!localStorage.getItem(PENDING_KEY);
  } catch {
    return false;
  }
}

/** Short app name from a prompt ("An online store for my bakery…" → "Online store bakery"). */
export function nameFromPrompt(prompt: string): string {
  const stop = new Set(["a", "an", "the", "for", "my", "with", "and", "that", "where", "to", "of", "in", "on", "i", "me", "our", "build", "create", "make", "app", "website", "site", "page"]);
  const words = prompt
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w.toLowerCase()))
    .slice(0, 3);
  const n = words.join(" ");
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : "New app";
}

/** Follow-up chips after a run when the agents did not send their own suggestions. */
export function fallbackSuggestions(ctx: { hasBackend: boolean; published: boolean; failed?: boolean; lastPrompt?: string | null }): string[] {
  if (ctx.failed) return ["Try again", "Explain what went wrong", "Undo the last change"];
  const out: string[] = [];
  const p = (ctx.lastPrompt ?? "").toLowerCase();
  if (!ctx.hasBackend) out.push("Save the data in a database");
  else if (!/auth|login|sign/.test(p)) out.push("Add sign up and login");
  if (!/mobile|responsive/.test(p)) out.push("Make it look great on mobile");
  if (!/dark/.test(p)) out.push("Add a dark mode toggle");
  out.push(ctx.published ? "Add an about page" : "Polish the design before publishing");
  return out.slice(0, 4);
}
