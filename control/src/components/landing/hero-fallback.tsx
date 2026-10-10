import { cn } from "@/lib/utils";

/**
 * Static SVG version of the hero motion graphic. Shown: on the server render, while three.js loads, without WebGL
 * and with prefers-reduced-motion (its own subtle CSS motion is wrapped in `motion-safe`).
 */
export function HeroFallback({ className }: { className?: string }) {
  const nodes = Array.from({ length: 34 }, (_, i) => {
    const y = 1 - (i / 33) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = Math.PI * (3 - Math.sqrt(5)) * i;
    return { x: Math.cos(th) * r, y, z: Math.sin(th) * r };
  });
  return (
    <svg viewBox="0 0 1000 400" className={cn("h-full w-full", className)} aria-hidden focusable="false" preserveAspectRatio="xMidYMid meet">
      <defs>
        <radialGradient id="lf-glow">
          <stop offset="0" stopColor="rgb(var(--accent))" stopOpacity=".55" />
          <stop offset="1" stopColor="rgb(var(--accent))" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* path git → ring → globe */}
      <path
        d="M120 175 C 210 120, 300 150, 380 190 S 560 150, 690 180"
        fill="none"
        stroke="rgb(var(--subtle))"
        strokeWidth="1.5"
        strokeDasharray="6 6"
        className="motion-safe:animate-[lf-dash_1.6s_linear_infinite]"
      />
      {/* git node */}
      <circle cx="120" cy="175" r="60" fill="url(#lf-glow)" />
      <path d="M120 140 155 175 120 210 85 175Z" fill="none" stroke="rgb(var(--fg))" strokeWidth="1.5" />
      <path d="M120 158 137 175 120 192 103 175Z" fill="rgb(var(--accent))" />
      {/* code cubes */}
      {[
        [215, 140],
        [290, 158],
        [470, 172],
        [560, 165],
      ].map(([x, y], i) => (
        <rect
          key={i}
          x={x - 7}
          y={y - 7}
          width="14"
          height="14"
          rx="2"
          transform={`rotate(${20 + i * 17} ${x} ${y})`}
          fill={i < 2 ? "rgb(var(--fg))" : "rgb(var(--accent))"}
          opacity=".9"
        />
      ))}
      {/* build ring */}
      <circle cx="400" cy="185" r="95" fill="url(#lf-glow)" opacity=".7" />
      <ellipse cx="400" cy="185" rx="34" ry="86" fill="none" stroke="rgb(var(--accent))" strokeWidth="4" />
      <ellipse cx="400" cy="185" rx="44" ry="106" fill="none" stroke="rgb(var(--fg))" strokeOpacity=".3" strokeWidth="1" />
      {/* globe */}
      <circle cx="760" cy="180" r="160" fill="url(#lf-glow)" opacity=".5" />
      <g transform="translate(760 180)">
        <circle r="105" fill="none" stroke="rgb(var(--subtle))" strokeOpacity=".7" />
        {[-60, -20, 20, 60].map((lat) => {
          const ry = Math.cos((lat * Math.PI) / 180) * 105;
          return <ellipse key={lat} cy={Math.sin((lat * Math.PI) / 180) * -105} rx={ry} ry={ry * 0.22} fill="none" stroke="rgb(var(--subtle))" strokeOpacity=".45" />;
        })}
        {[0, 35, 70].map((a) => (
          <ellipse key={a} rx={Math.cos((a * Math.PI) / 180) * 105} ry="105" fill="none" stroke="rgb(var(--subtle))" strokeOpacity=".45" />
        ))}
        {nodes
          .filter((n) => n.z > -0.2)
          .map((n, i) => (
            <circle key={i} cx={n.x * 105} cy={n.y * 105} r={2.5 + n.z * 1.5} fill="rgb(var(--accent))" />
          ))}
        <path d="M-60 -50 Q 0 -150 70 -30" fill="none" stroke="rgb(var(--accent))" strokeOpacity=".6" />
        <path d="M-80 30 Q 10 -40 50 70" fill="none" stroke="rgb(var(--accent))" strokeOpacity=".6" />
        <ellipse rx="128" ry="26" fill="none" stroke="rgb(var(--fg))" strokeOpacity=".3" />
      </g>
      {/* database */}
      <g transform="translate(560 315)">
        <circle r="70" fill="url(#lf-glow)" opacity=".7" />
        {[0, 1, 2].map((i) => (
          <g key={i} transform={`translate(0 ${-i * 20})`}>
            <ellipse rx="34" ry="9" fill="none" stroke={i === 2 ? "rgb(var(--accent))" : "rgb(var(--fg))"} strokeWidth="1.5" />
            <path d="M-34 0v12M34 0v12" stroke="rgb(var(--fg))" strokeOpacity=".5" />
          </g>
        ))}
        <ellipse rx="56" ry="15" cy="-40" fill="none" stroke="rgb(var(--accent))" strokeOpacity=".5" className="motion-safe:animate-[lf-pulse_2.4s_ease-out_infinite]" style={{ transformOrigin: "0 -40px" }} />
      </g>
      <path d="M590 285 Q 640 270 690 255" fill="none" stroke="rgb(var(--accent))" strokeOpacity=".5" strokeWidth="1.5" />
    </svg>
  );
}
