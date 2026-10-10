import { PrismaClient } from "@prisma/client";

// Single PrismaClient per process (hot-reload safe). Shared by the Next app and the worker.
const g = globalThis as unknown as { __prisma?: PrismaClient };

export const db =
  g.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") g.__prisma = db;
