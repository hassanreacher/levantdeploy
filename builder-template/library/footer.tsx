import Link from "next/link";
import { Separator } from "@/components/ui/separator";

const columns = [
  { title: "Product", links: ["Features", "Pricing", "Changelog"] },
  { title: "Company", links: ["About", "Blog", "Careers"] },
  { title: "Legal", links: ["Privacy", "Terms", "Contact"] },
];

export default function Footer() {
  return (
    <footer className="border-t">
      <div className="container grid gap-8 py-12 md:grid-cols-4">
        <div>
          <p className="text-lg font-semibold">My App</p>
          <p className="mt-2 text-sm text-muted-foreground">Making great things simple.</p>
        </div>
        {columns.map((c) => (
          <div key={c.title}>
            <p className="mb-3 text-sm font-medium">{c.title}</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {c.links.map((l) => (
                <li key={l}>
                  <Link href="#" className="hover:text-foreground">
                    {l}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <Separator />
      <div className="container flex h-14 items-center justify-between text-sm text-muted-foreground">
        <p>© {new Date().getFullYear()} My App. All rights reserved.</p>
      </div>
    </footer>
  );
}
