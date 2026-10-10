/** Small animated (CSS, see landing.css `.lf-icon`) icons for the backend grid. 32×32, currentColor + accent. */
const A = "rgb(var(--accent))";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 32 32" className="lf-icon h-8 w-8 text-fg" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export function DatabaseIcon() {
  return (
    <Frame>
      <ellipse cx="16" cy="8" rx="9" ry="3.5" />
      <path d="M7 8v16c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5V8" />
      <path d="M7 14c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5M7 19.5c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5" opacity=".5" />
      <circle className="lf-fill" cx="11" cy="13.5" r="1" fill={A} stroke="none" />
      <circle className="lf-fill d2" cx="11" cy="19" r="1" fill={A} stroke="none" />
      <circle className="lf-fill d3" cx="11" cy="24.5" r="1" fill={A} stroke="none" />
    </Frame>
  );
}

export function AuthIcon() {
  return (
    <Frame>
      <rect x="7" y="14" width="18" height="13" rx="3" />
      <path d="M11 14v-3.5a5 5 0 0 1 10 0V14" />
      <circle className="lf-blink" cx="16" cy="19.5" r="1.8" fill={A} stroke="none" />
      <path d="M16 21.5v2" stroke={A} />
    </Frame>
  );
}

export function RestIcon() {
  return (
    <Frame>
      <path d="M11 6c-3 0-3 2-3 4v3c0 2-2 3-2 3s2 1 2 3v3c0 2 0 4 3 4M21 6c3 0 3 2 3 4v3c0 2 2 3 2 3s-2 1-2 3v3c0 2 0 4-3 4" />
      <g className="lf-dotx">
        <circle cx="13" cy="16" r="1.3" fill={A} stroke="none" />
        <circle cx="19" cy="16" r="1.3" fill="currentColor" stroke="none" opacity=".5" />
      </g>
    </Frame>
  );
}

export function RealtimeIcon() {
  return (
    <Frame>
      <circle cx="16" cy="16" r="2.4" fill={A} stroke="none" />
      <circle className="lf-wave" cx="16" cy="16" r="7" stroke={A} />
      <circle className="lf-wave d2" cx="16" cy="16" r="11.5" stroke={A} opacity=".7" />
      <path d="M8.5 23.5a10.6 10.6 0 0 1 0-15M23.5 8.5a10.6 10.6 0 0 1 0 15" opacity=".35" />
    </Frame>
  );
}

export function StorageIcon() {
  return (
    <Frame>
      <path d="M5 11.5V25a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V13.5a2 2 0 0 0-2-2H15l-2.5-3H7a2 2 0 0 0-2 2z" />
      <g className="lf-slide">
        <rect x="12" y="15" width="8" height="9" rx="1.2" stroke={A} />
        <path d="M14 18.5h4M14 21h2.5" stroke={A} />
      </g>
    </Frame>
  );
}

export function FunctionsIcon() {
  return (
    <Frame>
      <path d="M9 6h6M9 26h6" opacity=".5" />
      <path d="M12 6 9 26" opacity=".5" />
      <path className="lf-blink" d="M20 5 14.5 17H19l-2 10 8-13.5h-5L22 5z" stroke={A} fill="rgb(var(--accent) / 0.15)" />
    </Frame>
  );
}

export function StudioIcon() {
  return (
    <Frame>
      <rect x="5" y="6" width="22" height="20" rx="2.5" />
      <path d="M5 11.5h22M12.5 11.5V26" opacity=".5" />
      <rect className="lf-rowhl" x="6" y="12.5" width="20" height="4.5" rx="1" fill="rgb(var(--accent) / 0.25)" stroke="none" />
      <path d="M15 15h8M15 20.5h6M15 23.5h7" opacity=".6" />
    </Frame>
  );
}
