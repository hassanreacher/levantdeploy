import { Avatar, AvatarFallback } from "@/components/ui/avatar";

const members = [
  { name: "Nour Saleh", role: "CEO & Co-founder" },
  { name: "Karim Aziz", role: "CTO & Co-founder" },
  { name: "Maya Fares", role: "Head of Design" },
  { name: "Yousef Nasser", role: "Head of Growth" },
];

export default function Team() {
  return (
    <section className="container py-20">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Meet the team</h2>
        <p className="mt-4 text-muted-foreground">The people building it every day.</p>
      </div>
      <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {members.map((m) => (
          <div key={m.name} className="flex flex-col items-center text-center">
            <Avatar className="h-24 w-24">
              <AvatarFallback className="text-xl">
                {m.name
                  .split(" ")
                  .map((p) => p[0])
                  .join("")}
              </AvatarFallback>
            </Avatar>
            <p className="mt-4 font-medium">{m.name}</p>
            <p className="text-sm text-muted-foreground">{m.role}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
