# Landing area: notes and shared-file changes

## What it owns
- `/` signed out → `src/components/landing/landing.tsx`. `src/app/page.tsx` still redirects signed-in users to their team.
- Public pages under `src/app/(marketing)/`: `/features`, `/pricing` (plans come from the `Plan` table and fall back to `DEFAULT_PLANS` in `src/lib/plans/limits.ts`), `/docs` (an index of the repo guides plus install commands).
- `src/components/landing/**`: hero 3D scene (`hero-scene.tsx`), its static fallback and loader, demos (terminal, agent), plan cards, site chrome, `landing.css`.

## Messaging
One product: "your frontend, backend and database in one project". The backend is part of every project. "LevantBase" only appears as the name of the backend engine, in fine print.

## Dependencies added (exact versions)
- `three@0.185.1`, `@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8` (only `Float` and `AdaptiveDpr` are used)
- dev: `@types/three@0.185.4`
- No framer-motion. Scroll reveals use CSS plus one IntersectionObserver (`reveal-observer.tsx`).

The three.js chunk (~740 KB minified, about 200 KB gzipped) loads only on the client. It loads through `next/dynamic({ ssr:false })` after `requestIdleCallback`, and only when WebGL is available and `prefers-reduced-motion` is not set. In every other case, and while it loads, the SVG fallback shows. `?static=1` forces the fallback. The canvas pauses (`frameloop="never"`) when it is off screen.

## Shared-file changes (small, additive)
- `src/middleware.ts`: added `/features`, `/pricing` and `/docs` to `PUBLIC_PAGES`.
- `src/lib/teams.ts`: added `features` and `pricing` to `RESERVED_TEAM_SLUGS` (`docs` was already reserved).
- `tsconfig.json`: added `"storage-*"` to `exclude`. Other areas' runtime storage dirs (e.g. `storage-bruntime/…/functions/*.ts`, Deno code) were breaking `tsc` and `next build`.

## CSP
No change needed. three.js and R3F use no `eval`, no `wasm` and no workers, and the glow textures are made with canvas (`CanvasTexture`). No CSP violations were logged in the Playwright runs.

## Known notes
- R3F 9.7 logs a console warning with three r185: `THREE.Clock: This module has been deprecated` (from R3F, harmless).
- Rapid same-tab `page.goto` between pages in Playwright (for example `/docs` → `/` right after `networkidle`) sometimes logged React #418 in the production build. This was not reproducible:
  - in dev
  - with fresh browser contexts (60 loads)
  - with client-side navigation (18 navigations plus reloads)

## Round 2: AI Builder as the hero story
- Hero: "Describe it. We build it, host it, and give it a backend." The prompt box is builder-ui's
  `<BuilderPromptHero showHeading={false} signUpHref={invite ? "/login" : "/register"}/>`. It saves the prompt in
  `localStorage["ld-builder-pending"]` and sends the visitor to sign-up, and the team Overview or Build page then starts the build.
  This was verified: picking the "Habit tracker" chip and pressing Build it goes to `/register` with the pending prompt stored.
  The 3D hero stays below the prompt.
- New sections:
  - `#builder` (`agent-team.tsx`): the agent pipeline plan → design → code → check → fix → publish, with an event log and a
    model router showing groq 429 and the fallback to openrouter.
  - `#editor` (`visual-edit-demo.tsx`): mock editor showing select, inline text edit, style swatch, dragging a section and a commit toast.
  - `#examples` (`example-gallery.tsx`): 6 static cards with CSS-drawn thumbnails.
  - The Backend section is now titled "Backend included".
- Plans: `src/components/landing/plans.ts` reads `Plan.limits.builder` through `parseLimits(limits, defaultLimitsForSlug(slug))`.
  The cards and the /pricing table show AI Builder credits (Hobby 5/day, 30/month and 5 apps; Pro 100/month + 5/day bonus;
  Team 500/month).
- /features has an "AI Builder" section (`BUILDER_FEATURES` in `content.tsx`). New FAQ entries: what the Builder makes,
  AI providers and fallback, code and data ownership, what a credit is.
- Screenshots: `docs/screenshots/landing/30-…48-*.png`. Files 00–25 are from round 1 and show the old hero.
- The build dir `.next-landing` was deleted afterwards because the disk was full: the `output: "standalone"` trace copy hit ENOSPC.
  The build itself was fine.
