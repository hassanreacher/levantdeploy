import { Star } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";

const testimonials = [
  { name: "Sara Haddad", role: "Founder, Bloom", quote: "We launched in a weekend. Our customers love how simple everything feels." },
  { name: "Omar Khalil", role: "Product lead, Nimbus", quote: "The best tool we have adopted this year. It just works — every single time." },
  { name: "Lina Mansour", role: "Designer, Atelier", quote: "Beautiful out of the box and easy to make our own. Highly recommended." },
];

export default function Testimonials() {
  return (
    <section className="bg-muted/40 py-20">
      <div className="container">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Loved by our customers</h2>
          <p className="mt-4 text-muted-foreground">Here is what people are saying.</p>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {testimonials.map((t) => (
            <Card key={t.name}>
              <CardContent className="pt-6">
                <div className="mb-4 flex gap-1 text-primary">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-current" />
                  ))}
                </div>
                <p className="text-sm leading-relaxed">“{t.quote}”</p>
                <div className="mt-6 flex items-center gap-3">
                  <Avatar className="h-9 w-9">
                    <AvatarFallback>
                      {t.name
                        .split(" ")
                        .map((p) => p[0])
                        .join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-medium">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.role}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
