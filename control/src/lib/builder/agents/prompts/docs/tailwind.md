# Tailwind + shadcn theme tokens
- Colors come from CSS variables in `app/globals.css` (`:root { --primary: 24 70% 35%; … }` and `.dark { … }`), mapped in
  `tailwind.config.ts` (`primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" }`).
- Use classes: `bg-background text-foreground`, `bg-card text-card-foreground`, `bg-primary text-primary-foreground hover:bg-primary/90`,
  `bg-secondary`, `bg-muted text-muted-foreground`, `bg-accent`, `border-border`, `ring-ring`, `text-destructive`, `rounded-lg` (= var(--radius)).
- Layout: `container mx-auto px-4`, `max-w-6xl`, `grid gap-6 sm:grid-cols-2 lg:grid-cols-3`, `flex flex-col md:flex-row`, sections `py-16 md:py-24`.
- Typography: `text-4xl md:text-6xl font-bold tracking-tight`, `text-lg text-muted-foreground`, `leading-relaxed`, `text-balance`.
- Effects: `shadow-sm`, `hover:shadow-md transition-shadow`, `bg-gradient-to-br from-primary/20 to-background`, `backdrop-blur`.
- Dark mode: `darkMode: ["class"]`; tokens switch automatically — never write `dark:` overrides for token colors.
- Don't use arbitrary hex values (`bg-[#123456]`) in components; add a token instead.
