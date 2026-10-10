import { onWorkerStart } from "@/lib/queues";
import { db } from "@/lib/db";

// Foundation: make sure the single local Server row exists (runtime/metrics areas reference it).
onWorkerStart("ensure-local-server", async () => {
  const exists = await db.server.findFirst({ where: { isLocal: true } });
  if (!exists) await db.server.create({ data: { name: "local", isLocal: true, dockerSocket: process.env.DOCKER_SOCKET || "/var/run/docker.sock" } });
});
