import { ApiClientError } from "@/lib/client/api";

export function errMessage(e: unknown): string {
  return e instanceof ApiClientError ? e.message : e instanceof Error ? e.message : "Something went wrong";
}
