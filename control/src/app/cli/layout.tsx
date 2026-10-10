import Link from "next/link";
import { Logo } from "@/components/shell/logo";

export default function CliLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-0 grid-bg [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]" />
      <header className="relative flex h-16 items-center px-6">
        <Link href="/" aria-label="LevantDeploy home">
          <Logo withText />
        </Link>
      </header>
      <main className="relative flex flex-1 items-start justify-center px-4 pb-16 pt-[8vh]">
        <div className="w-full max-w-[420px] animate-slide-up">{children}</div>
      </main>
    </div>
  );
}
