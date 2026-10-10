/** Pure diff of branch heads (used by polling.ts, unit tested). */
export function diffHeads(prev: Record<string, string>, next: Record<string, string>) {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [b, sha] of Object.entries(next)) if (prev[b] !== sha) changed.push(b);
  for (const b of Object.keys(prev)) if (!(b in next)) deleted.push(b);
  return { changed, deleted };
}
