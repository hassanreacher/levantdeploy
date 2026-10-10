import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const faqs = [
  { q: "How do I get started?", a: "Create an account in seconds — no credit card required. You can start using everything right away." },
  { q: "Can I cancel anytime?", a: "Yes. There are no long-term contracts; you can upgrade, downgrade or cancel whenever you like." },
  { q: "Is my data secure?", a: "Absolutely. Your data is encrypted in transit and at rest, and backed up daily." },
  { q: "Do you offer support?", a: "Our team is happy to help by email, and paid plans include priority support." },
];

export default function Faq() {
  return (
    <section className="container max-w-3xl py-20">
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Frequently asked questions</h2>
        <p className="mt-4 text-muted-foreground">Can’t find the answer you’re looking for? Reach out to us.</p>
      </div>
      <Accordion type="single" collapsible className="w-full">
        {faqs.map((f, i) => (
          <AccordionItem key={f.q} value={`item-${i}`}>
            <AccordionTrigger>{f.q}</AccordionTrigger>
            <AccordionContent className="text-muted-foreground">{f.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
