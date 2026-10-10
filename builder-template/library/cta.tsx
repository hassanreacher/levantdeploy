import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Cta() {
  return (
    <section className="container py-20">
      <div className="relative overflow-hidden rounded-2xl bg-primary px-6 py-16 text-center text-primary-foreground sm:px-16">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Ready to get started?</h2>
        <p className="mx-auto mt-4 max-w-xl text-primary-foreground/80">Join thousands of happy customers today. It only takes a minute.</p>
        <div className="mt-8 flex justify-center gap-3">
          <Button size="lg" variant="secondary" asChild>
            <Link href="#">Create your account</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
