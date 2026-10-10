/** Wireframe thumbnails for the "Add section" library (pure SVG, theme-aware via currentColor tokens). */
import { cn } from "@/lib/utils";

const R = ({ x, y, w, h, o = 0.18, r = 2 }: { x: number; y: number; w: number; h: number; o?: number; r?: number }) => <rect x={x} y={y} width={w} height={h} rx={r} fill="currentColor" opacity={o} />;
const A = ({ x, y, w, h, r = 2 }: { x: number; y: number; w: number; h: number; r?: number }) => <rect x={x} y={y} width={w} height={h} rx={r} className="fill-accent" opacity={0.85} />;

function cols(n: number, y: number, h: number, render: (x: number, w: number, i: number) => React.ReactNode) {
  const gap = 6;
  const w = (148 - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => render(6 + i * (w + gap), w, i));
}

const SHAPES: Record<string, React.ReactNode> = {
  navbar: (
    <>
      <R x={6} y={8} w={160} h={20} o={0.08} />
      <R x={12} y={15} w={22} h={6} o={0.4} />
      <R x={70} y={16} w={14} h={4} />
      <R x={90} y={16} w={14} h={4} />
      <R x={110} y={16} w={14} h={4} />
      <A x={138} y={13} w={22} h={10} />
      <R x={6} y={40} w={160} h={54} o={0.05} />
    </>
  ),
  hero: (
    <>
      <R x={66} y={14} w={40} h={5} o={0.12} r={3} />
      <R x={30} y={26} w={112} h={10} o={0.45} />
      <R x={46} y={42} w={80} h={5} />
      <R x={56} y={51} w={60} h={5} />
      <A x={52} y={66} w={32} h={11} />
      <R x={88} y={66} w={32} h={11} o={0.12} />
    </>
  ),
  features: (
    <>
      <R x={46} y={10} w={80} h={7} o={0.4} />
      {cols(3, 28, 60, (x, w, i) => (
        <g key={i}>
          <R x={x} y={28} w={w} h={62} o={0.08} r={3} />
          <A x={x + 6} y={35} w={10} h={10} />
          <R x={x + 6} y={52} w={w - 16} h={5} o={0.35} />
          <R x={x + 6} y={62} w={w - 12} h={4} />
          <R x={x + 6} y={70} w={w - 20} h={4} />
        </g>
      ))}
    </>
  ),
  pricing: (
    <>
      <R x={50} y={8} w={72} h={7} o={0.4} />
      {cols(3, 22, 70, (x, w, i) => (
        <g key={i}>
          <rect x={x} y={22} width={w} height={70} rx={3} fill="none" stroke="currentColor" strokeOpacity={i === 1 ? 0 : 0.25} />
          {i === 1 && <rect x={x} y={22} width={w} height={70} rx={3} fill="none" className="stroke-accent" strokeWidth={1.5} />}
          <R x={x + 6} y={29} w={20} h={4} o={0.35} />
          <R x={x + 6} y={39} w={26} h={9} o={0.5} />
          <R x={x + 6} y={55} w={w - 14} h={3} />
          <R x={x + 6} y={62} w={w - 20} h={3} />
          {i === 1 ? <A x={x + 6} y={76} w={w - 12} h={9} /> : <R x={x + 6} y={76} w={w - 12} h={9} o={0.12} />}
        </g>
      ))}
    </>
  ),
  testimonials: (
    <>
      <R x={46} y={10} w={80} h={7} o={0.4} />
      {cols(3, 28, 60, (x, w, i) => (
        <g key={i}>
          <R x={x} y={28} w={w} h={60} o={0.08} r={3} />
          <R x={x + 6} y={36} w={w - 12} h={4} />
          <R x={x + 6} y={44} w={w - 16} h={4} />
          <R x={x + 6} y={52} w={w - 20} h={4} />
          <circle cx={x + 12} cy={76} r={5} fill="currentColor" opacity={0.3} />
          <R x={x + 21} y={74} w={22} h={4} o={0.35} />
        </g>
      ))}
    </>
  ),
  faq: (
    <>
      <R x={40} y={8} w={92} h={7} o={0.4} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x={26} y={24 + i * 17} width={120} height={14} rx={2} fill="none" stroke="currentColor" strokeOpacity={0.25} />
          <R x={32} y={29 + i * 17} w={70} h={4} o={0.35} />
          <R x={136} y={29 + i * 17} w={4} h={4} o={0.4} />
        </g>
      ))}
    </>
  ),
  cta: (
    <>
      <A x={10} y={18} w={152} h={64} r={5} />
      <rect x={46} y={32} width={80} height={8} rx={2} fill="white" opacity={0.85} />
      <rect x={56} y={46} width={60} height={4} rx={2} fill="white" opacity={0.6} />
      <rect x={70} y={58} width={32} height={11} rx={2} fill="white" opacity={0.95} />
    </>
  ),
  stats: (
    <>
      {cols(4, 30, 40, (x, w, i) => (
        <g key={i}>
          <R x={x + 4} y={32} w={w - 8} h={4} />
          <R x={x + 2} y={42} w={w - 4} h={14} o={0.5} />
        </g>
      ))}
    </>
  ),
  gallery: (
    <>
      <R x={6} y={8} w={50} h={7} o={0.4} />
      {[0, 1].map((r) =>
        cols(3, 22 + r * 36, 30, (x, w, i) => <R key={`${r}${i}`} x={x} y={22 + r * 36} w={w} h={30} o={0.2 + ((i + r) % 3) * 0.08} r={3} />),
      )}
    </>
  ),
  team: (
    <>
      <R x={50} y={8} w={72} h={7} o={0.4} />
      {cols(4, 28, 50, (x, w, i) => (
        <g key={i}>
          <circle cx={x + w / 2} cy={44} r={12} fill="currentColor" opacity={0.25} />
          <R x={x + 4} y={62} w={w - 8} h={4} o={0.35} />
          <R x={x + 8} y={70} w={w - 16} h={3} />
        </g>
      ))}
    </>
  ),
  "blog-list": (
    <>
      <R x={6} y={8} w={60} h={7} o={0.4} />
      {cols(3, 22, 70, (x, w, i) => (
        <g key={i}>
          <R x={x} y={22} w={w} h={30} o={0.22} r={3} />
          <R x={x} y={57} w={22} h={3} />
          <R x={x} y={64} w={w - 6} h={5} o={0.35} />
          <R x={x} y={73} w={w - 14} h={5} o={0.35} />
        </g>
      ))}
    </>
  ),
  "contact-form": (
    <>
      <R x={46} y={8} w={60} h={7} o={0.4} />
      <rect x={46} y={22} width={80} height={10} rx={2} fill="none" stroke="currentColor" strokeOpacity={0.3} />
      <rect x={46} y={36} width={80} height={10} rx={2} fill="none" stroke="currentColor" strokeOpacity={0.3} />
      <rect x={46} y={50} width={80} height={24} rx={2} fill="none" stroke="currentColor" strokeOpacity={0.3} />
      <A x={46} y={79} w={80} h={10} />
    </>
  ),
  "auth-forms": (
    <>
      <R x={56} y={12} w={60} h={7} o={0.45} />
      <R x={62} y={23} w={48} h={4} />
      <rect x={52} y={34} width={68} height={10} rx={2} fill="none" stroke="currentColor" strokeOpacity={0.3} />
      <rect x={52} y={48} width={68} height={10} rx={2} fill="none" stroke="currentColor" strokeOpacity={0.3} />
      <A x={52} y={63} w={68} h={10} />
      <R x={64} y={80} w={44} h={4} />
    </>
  ),
  footer: (
    <>
      <R x={6} y={14} w={160} h={50} o={0.05} />
      <R x={6} y={70} w={160} h={1} o={0.3} r={0} />
      <R x={12} y={80} w={50} h={4} />
      <R x={100} y={80} w={16} h={4} />
      <R x={120} y={80} w={16} h={4} />
      <R x={140} y={80} w={16} h={4} />
    </>
  ),
};

export function SectionPreview({ id, className }: { id: string; className?: string }) {
  return (
    <svg viewBox="0 0 172 100" className={cn("text-fg", className)} role="img" aria-label={`${id} preview`}>
      {SHAPES[id] ?? <R x={20} y={20} w={132} h={60} />}
    </svg>
  );
}
