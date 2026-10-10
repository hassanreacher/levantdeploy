import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.15),transparent_60%)]" />
      <div className="container flex flex-col items-center py-24 text-center md:py-32">
        <Badge variant="secondary" className="mb-6">
          New — just launched
        </Badge>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">The fastest way to grow your business</h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">Everything you need to launch, manage and scale — in one simple, beautiful place.</p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Button size="lg" asChild>
            <Link href="#">
              Get started free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="#">See how it works</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
