import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// LevantDeploy visual editor bridge — only in the live preview (dev server with NEXT_PUBLIC_LEVANT_EDITOR=1).
// The flag is inlined at build time, so production builds don't include the bridge at all.
const LevantBridge = process.env.NEXT_PUBLIC_LEVANT_EDITOR === "1" ? dynamic(() => import("@/components/levant/bridge")) : null;

export const metadata: Metadata = {
  title: "My App",
  description: "Built with LevantDeploy",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        {children}
        <Toaster richColors position="top-center" />
        {LevantBridge ? <LevantBridge /> : null}
      </body>
    </html>
  );
}
