import Link from "next/link";
import { ArrowRight, Database, Palette, Rocket, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const features = [
  { icon: Sparkles, title: "Describe it", description: "Tell the builder what you want in plain language and watch it take shape." },
  { icon: Palette, title: "Edit visually", description: "Click any element to change its text, colors, images and layout." },
  { icon: Database, title: "Real backend", description: "Auth, Postgres, storage and realtime — wired up with one click." },
  { icon: Rocket, title: "Publish", description: "Ship to a live URL with your own domain whenever you are ready." },
];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="h-4 w-4" />
            </span>
            My App
          </Link>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" asChild>
              <Link href="#features">Features</Link>
            </Button>
            <Button asChild>
              <Link href="#get-started">Get started</Link>
            </Button>
          </nav>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.15),transparent_60%)]" />
        <div className="container flex flex-col items-center py-24 text-center md:py-32">
          <Badge variant="secondary" className="mb-6">
            Your app starts here
          </Badge>
          <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">Build something people love</h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
            This is your new Next.js app. Ask the builder to turn it into anything — a landing page, a dashboard, a store or a full SaaS.
          </p>
          <div id="get-started" className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Button size="lg">
              Start building
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="#features">Learn more</Link>
            </Button>
          </div>
        </div>
      </section>

      <section id="features" className="container py-20">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">Everything you need</h2>
          <p className="mt-4 text-muted-foreground">A modern stack with sensible defaults, ready for your ideas.</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <Card key={f.title} className="transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <f.icon className="h-5 w-5" />
                </div>
                <CardTitle className="text-lg">{f.title}</CardTitle>
                <CardDescription>{f.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <footer className="mt-auto border-t">
        <div className="container flex h-16 items-center justify-between text-sm text-muted-foreground">
          <p>© {new Date().getFullYear()} My App</p>
          <p>Made with LevantDeploy</p>
        </div>
      </footer>
    </main>
  );
}
