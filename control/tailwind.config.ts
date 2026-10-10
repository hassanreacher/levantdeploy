import type { Config } from "tailwindcss";

// Monochrome palette driven by CSS variables (see src/app/globals.css) + one accent (blue).
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        "bg-subtle": v("bg-subtle"),
        surface: v("surface"),
        "surface-2": v("surface-2"),
        border: v("border"),
        "border-strong": v("border-strong"),
        fg: v("fg"),
        muted: v("muted"),
        subtle: v("subtle"),
        accent: v("accent"),
        "accent-fg": v("accent-fg"),
        success: v("success"),
        warning: v("warning"),
        danger: v("danger"),
        info: v("info"),
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: { DEFAULT: "6px", md: "8px", lg: "12px" },
      boxShadow: {
        card: "0 1px 2px rgb(0 0 0 / 0.04), 0 0 0 1px rgb(var(--border) / 1)",
        pop: "0 8px 30px rgb(0 0 0 / 0.24), 0 0 0 1px rgb(var(--border) / 1)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "scale-in": { from: { opacity: "0", transform: "scale(.97) translateY(4px)" }, to: { opacity: "1", transform: "none" } },
        "slide-up": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "none" } },
        pulse2: { "0%,100%": { opacity: "1" }, "50%": { opacity: ".35" } },
      },
      animation: {
        "fade-in": "fade-in .15s ease-out",
        "scale-in": "scale-in .16s ease-out",
        "slide-up": "slide-up .2s ease-out",
        pulse2: "pulse2 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
