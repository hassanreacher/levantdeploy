import { cn, initials } from "@/lib/utils";

/** Image avatar or a deterministic gradient with initials. */
export function Avatar({ name, src, size = 24, className, square }: { name: string; src?: string | null; size?: number; className?: string; square?: boolean }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const style = { width: size, height: size, fontSize: Math.max(9, size * 0.4) };
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={name} style={style} className={cn("shrink-0 object-cover", square ? "rounded-md" : "rounded-full", className)} />;
  }
  return (
    <span
      aria-hidden
      style={{ ...style, backgroundImage: `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 60) % 360} 70% 45%))` }}
      className={cn("inline-flex shrink-0 items-center justify-center font-semibold text-white", square ? "rounded-md" : "rounded-full", className)}
    >
      {size >= 20 ? initials(name) : ""}
    </span>
  );
}
