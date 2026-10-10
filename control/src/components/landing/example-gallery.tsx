import { cn } from "@/lib/utils";

/** Static gallery of example apps (mock thumbnails drawn with CSS — no images to download). */
type Layout = "shop" | "dash" | "portal" | "event" | "saas" | "social";
const EXAMPLES: { name: string; prompt: string; tags: string[]; layout: Layout }[] = [
  { name: "Bakery pre-orders", prompt: "A bakery site with a daily menu, pickup pre-orders and an admin to mark orders ready", tags: ["Database", "Auth", "Admin"], layout: "shop" },
  { name: "Habit tracker", prompt: "Users sign up, add habits, tick them off daily and see streaks and charts", tags: ["Auth", "Realtime"], layout: "dash" },
  { name: "Client portal", prompt: "Clients log in to see invoices, project status and upload documents", tags: ["Auth", "Storage", "RLS"], layout: "portal" },
  { name: "Event RSVP", prompt: "An event page with schedule, speakers and an RSVP form saving guests", tags: ["Database", "Forms"], layout: "event" },
  { name: "SaaS landing", prompt: "A modern SaaS landing page with pricing, testimonials, FAQ and a waitlist", tags: ["Database"], layout: "saas" },
  { name: "Recipe community", prompt: "People share recipes with photos, like and comment on each other's posts", tags: ["Auth", "Storage", "Realtime"], layout: "social" },
];

function Thumb({ layout }: { layout: Layout }) {
  const bar = "rounded-full bg-fg/15";
  const block = "rounded bg-fg/[0.07]";
  return (
    <div className="flex h-full flex-col gap-1.5 p-3" aria-hidden>
      <div className="flex items-center justify-between">
        <div className="h-1.5 w-10 rounded-full bg-fg/30" />
        <div className="flex gap-1">
          <div className={cn(bar, "h-1 w-4")} />
          <div className={cn(bar, "h-1 w-4")} />
          <div className="h-1.5 w-6 rounded-full bg-accent/70" />
        </div>
      </div>
      {layout === "shop" && (
        <>
          <div className="mt-1 h-10 rounded bg-gradient-to-r from-accent/25 to-accent/5" />
          <div className="grid flex-1 grid-cols-3 gap-1.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={cn(block, "flex flex-col justify-end p-1")}>
                <div className={cn(bar, "h-1 w-2/3")} />
              </div>
            ))}
          </div>
        </>
      )}
      {layout === "dash" && (
        <div className="mt-1 grid flex-1 grid-cols-[1fr_2fr] gap-1.5">
          <div className={cn(block, "space-y-1 p-1.5")}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-1">
                <div className={cn("h-1.5 w-1.5 rounded-sm", i < 3 ? "bg-success/70" : "bg-fg/20")} />
                <div className={cn(bar, "h-1 flex-1")} />
              </div>
            ))}
          </div>
          <div className={cn(block, "flex items-end gap-1 p-1.5")}>
            {[40, 65, 50, 80, 70, 95, 60].map((h, i) => (
              <div key={i} className="flex-1 rounded-sm bg-accent/60" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      )}
      {layout === "portal" && (
        <div className="mt-1 grid flex-1 grid-cols-[1fr_3fr] gap-1.5">
          <div className={cn(block, "space-y-1.5 p-1.5")}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={cn("h-1 rounded-full", i === 1 ? "bg-accent/70" : "bg-fg/15")} />
            ))}
          </div>
          <div className={cn(block, "space-y-1 p-1.5")}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <div className={cn(bar, "h-1 w-1/2")} />
                <div className={cn("h-1.5 w-5 rounded-full", i % 2 ? "bg-success/60" : "bg-warning/60")} />
              </div>
            ))}
          </div>
        </div>
      )}
      {layout === "event" && (
        <>
          <div className="mt-1 flex h-12 flex-col items-center justify-center gap-1 rounded bg-gradient-to-b from-accent/30 to-transparent">
            <div className="h-1.5 w-20 rounded-full bg-fg/40" />
            <div className={cn(bar, "h-1 w-12")} />
          </div>
          <div className="grid flex-1 grid-cols-2 gap-1.5">
            <div className={cn(block, "space-y-1 p-1.5")}>
              {[0, 1, 2].map((i) => (
                <div key={i} className={cn(bar, "h-1")} />
              ))}
            </div>
            <div className={cn(block, "space-y-1 p-1.5")}>
              <div className="h-2 rounded-sm border border-fg/15" />
              <div className="h-2 rounded-sm border border-fg/15" />
              <div className="h-2 rounded-sm bg-accent/60" />
            </div>
          </div>
        </>
      )}
      {layout === "saas" && (
        <>
          <div className="mt-2 flex flex-col items-center gap-1">
            <div className="h-2 w-28 rounded-full bg-fg/40" />
            <div className={cn(bar, "h-1 w-20")} />
            <div className="mt-1 h-2 w-10 rounded-full bg-accent/70" />
          </div>
          <div className="mt-1 grid flex-1 grid-cols-3 gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className={cn(block, "space-y-1 p-1.5", i === 1 && "ring-1 ring-accent/60")}>
                <div className="h-1.5 w-5 rounded-full bg-fg/30" />
                <div className={cn(bar, "h-1")} />
                <div className={cn(bar, "h-1 w-2/3")} />
              </div>
            ))}
          </div>
        </>
      )}
      {layout === "social" && (
        <div className="mt-1 grid flex-1 grid-cols-2 gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn(block, "flex flex-col gap-1 p-1")}>
              <div className={cn("flex-1 rounded-sm", i % 3 === 0 ? "bg-accent/30" : "bg-fg/10")} />
              <div className="flex items-center gap-1">
                <div className="h-1.5 w-1.5 rounded-full bg-danger/60" />
                <div className={cn(bar, "h-1 flex-1")} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ExampleGallery() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {EXAMPLES.map((e, i) => (
        <figure
          key={e.name}
          className="group overflow-hidden rounded-xl border border-border bg-surface transition-colors hover:border-border-strong"
          data-reveal
          style={{ ["--lf-delay" as string]: `${(i % 3) * 70}ms` }}
        >
          <div className="h-40 border-b border-border bg-bg transition-transform duration-500 group-hover:scale-[1.02]">
            <Thumb layout={e.layout} />
          </div>
          <figcaption className="p-4">
            <p className="text-[14px] font-semibold">{e.name}</p>
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted">“{e.prompt}”</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {e.tags.map((t) => (
                <span key={t} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-subtle">
                  {t}
                </span>
              ))}
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
