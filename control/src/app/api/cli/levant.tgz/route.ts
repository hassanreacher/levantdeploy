import fs from "node:fs";
import { Readable } from "node:stream";

/**
 * GET /api/cli/levant.tgz — the levant CLI packed into the control image (ops area).
 *   npm i -g https://deploy.example.com/api/cli/levant.tgz
 * Public on purpose (the CLI contains no secrets; it authenticates with `levant login`).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const file = process.env.CLI_TARBALL || "/app/cli/levant.tgz";
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st?.isFile()) {
    return Response.json({ error: { code: "NOT_FOUND", message: "The CLI package is not bundled in this build — install it from the release zip: cd cli && npm i && npm run build && npm i -g ." } }, { status: 404 });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(st.size),
      "content-disposition": 'attachment; filename="levant.tgz"',
      "cache-control": "public, max-age=300",
    },
  });
}
