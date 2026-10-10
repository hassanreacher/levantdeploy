# Accessibility checklist
- One `<h1>` per page, headings in order; landmarks `header nav main footer`; `<main id="main">` + skip link for big sites.
- Images: meaningful `alt` (empty `alt=""` for decorative). Icon-only buttons: `aria-label`. Icons next to text: `aria-hidden`.
- Forms: `<Label htmlFor="email">` + `<Input id="email" type="email" autoComplete="email" required />`; errors linked with `aria-describedby`; `aria-invalid` on invalid fields; announce async results (`role="status"` / toast).
- Interactive elements are `<button>`/`<a>`, not clickable divs; visible focus (`focus-visible:ring-2 ring-ring`); keyboard reachable menus (shadcn handles this).
- Color contrast ≥ 4.5:1 for text; don't convey state by color only. Respect `motion-reduce:` for animations.
- Touch targets ≥ 40px on mobile; responsive from 375px without horizontal scroll.
