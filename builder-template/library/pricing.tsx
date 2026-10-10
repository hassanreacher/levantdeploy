import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const plans = [
  {
    name: "Starter",
    price: "$0",
    period: "/month",
    description: "For individuals getting started.",
    features: ["1 project", "Basic analytics", "Community support"],
    cta: "Start free",
    featured: false,
  },
  {
    name: "Pro",
    price: "$19",
    period: "/month",
    description: "For growing businesses.",
    features: ["Unlimited projects", "Advanced analytics", "Priority support", "Custom domain"],
    cta: "Get Pro",
    featured: true,
  },
  {
    name: "Team",
    price: "$49",
    period: "/month",
    description: "For teams that need more.",
    features: ["Everything in Pro", "Team members", "Roles & permissions", "SSO"],
    cta: "Contact sales",
    featured: false,
  },
];

export default function Pricing() {
  return (
    <section className="container py-20">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Simple, transparent pricing</h2>
        <p className="mt-4 text-muted-foreground">Choose the plan that fits. Upgrade or cancel anytime.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {plans.map((p) => (
          <Card key={p.name} className={cn("flex flex-col", p.featured && "border-primary shadow-lg")}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{p.name}</CardTitle>
                {p.featured ? <Badge>Most popular</Badge> : null}
              </div>
              <CardDescription>{p.description}</CardDescription>
              <p className="pt-4">
                <span className="text-4xl font-bold">{p.price}</span>
                <span className="text-muted-foreground">{p.period}</span>
              </p>
            </CardHeader>
            <CardContent className="flex-1">
              <ul className="space-y-2 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-primary" />
                    {f}
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button className="w-full" variant={p.featured ? "default" : "outline"}>
                {p.cta}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </section>
  );
}
