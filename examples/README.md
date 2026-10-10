# LevantDeploy examples

Small apps that LevantDeploy builds with zero configuration (each listens on `$PORT`).

| folder | detected as | notes |
|---|---|---|
| node-express | Express (npm) | `npm start` |
| nextjs | Next.js 15 (npm) | standalone output forced at build time |
| vite-react | Vite SPA (pnpm) | served by Caddy with SPA fallback |
| bun-min / deno-min | Bun / Deno | |
| python-fastapi / flask / python-django-min | FastAPI / Flask / Django | uvicorn / gunicorn added automatically |
| php-plain | PHP 8.3 + Apache | |
| go-http | Go | static binary on alpine |
| rust-axum | Rust | |
| ruby-sinatra | Rack (puma) | |
| java-spring-min | Spring Boot (Maven) | |
| dotnet-min | ASP.NET Core 8 | |
| static-html | Static HTML | pretty URLs + 404.html |
| dockerfile-custom | its own Dockerfile | |
| compose-app | Docker Compose (web + redis) | |

Build them all through the real engine: `cd control && npx tsx --env-file=.env.build scripts/build-examples.ts` (see the script header for flags).
