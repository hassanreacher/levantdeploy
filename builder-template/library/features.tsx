import { BarChart3, Lock, Zap, Globe, Users, Sparkles } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const features = [
  { icon: Zap, title: "Lightning fast", description: "Optimized from the ground up so everything feels instant." },
  { icon: Lock, title: "Secure by default", description: "Best-practice security and privacy built into every layer." },
  { icon: BarChart3, title: "Powerful analytics", description: "Understand what works with clear, real-time insights." },
  { icon: Globe, title: "Works everywhere", description: "Beautiful on phones, tablets and desktops alike." },
  { icon: Users, title: "Built for teams", description: "Invite your team and collaborate without friction." },
  { icon: Sparkles, title: "Delightful details", description: "Thoughtful touches that your customers will love." },
];

export default function Features() {
  return (
    <section className="container py-20">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Everything you need</h2>
        <p className="mt-4 text-muted-foreground">Powerful features that help you move faster and do more.</p>
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
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
  );
}
