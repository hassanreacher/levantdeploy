export const metadata = { title: "Next.js on LevantDeploy" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>{children}</body>
    </html>
  );
}
