import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

const posts = [
  {
    slug: "getting-started",
    title: "Getting started in five minutes",
    excerpt: "A quick tour of everything you need to know to hit the ground running.",
    tag: "Guide",
    date: "Mar 12, 2026",
  },
  {
    slug: "whats-new",
    title: "What’s new this month",
    excerpt: "New features, improvements and fixes we shipped over the last few weeks.",
    tag: "Product",
    date: "Mar 3, 2026",
  },
  {
    slug: "customer-story",
    title: "How Bloom grew 3× in a year",
    excerpt: "Lessons from one of our fastest-growing customers.",
    tag: "Story",
    date: "Feb 21, 2026",
  },
];

export default function BlogList() {
  return (
    <section className="container py-20">
      <div className="mb-12 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">From the blog</h2>
          <p className="mt-2 text-muted-foreground">News, guides and stories.</p>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        {posts.map((p) => (
          <Link key={p.slug} href={`/blog/${p.slug}`} className="group">
            <Card className="h-full transition-shadow group-hover:shadow-md">
              <CardHeader>
                <Badge variant="secondary" className="w-fit">
                  {p.tag}
                </Badge>
                <CardTitle className="pt-2 text-xl group-hover:text-primary">{p.title}</CardTitle>
                <CardDescription>{p.excerpt}</CardDescription>
              </CardHeader>
              <CardFooter className="text-xs text-muted-foreground">{p.date}</CardFooter>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
