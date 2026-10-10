export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>Hello from Next.js on LevantDeploy</h1>
      <p>Rendered at {new Date().toISOString()} ({process.env.LEVANT_ENV ?? "local"})</p>
    </main>
  );
}
