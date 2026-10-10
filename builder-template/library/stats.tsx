const stats = [
  { value: "10k+", label: "Happy customers" },
  { value: "99.9%", label: "Uptime" },
  { value: "24/7", label: "Support" },
  { value: "50+", label: "Countries" },
];

export default function Stats() {
  return (
    <section className="border-y bg-muted/40">
      <div className="container grid grid-cols-2 gap-8 py-16 text-center md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label}>
            <p className="text-4xl font-bold tracking-tight text-primary">{s.value}</p>
            <p className="mt-2 text-sm text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
