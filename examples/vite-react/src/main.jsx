import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [n, setN] = useState(0);
  const path = window.location.pathname;
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "4rem auto" }}>
      <h1>Hello from Vite + React on LevantDeploy</h1>
      <p>Client-side route: {path} (SPA fallback serves index.html)</p>
      <button onClick={() => setN(n + 1)}>clicked {n} times</button>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
