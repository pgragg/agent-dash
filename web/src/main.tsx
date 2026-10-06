import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./exits.ts";
import "./styles.css";

// A rebuild deletes the old hashed chunks, so a tab opened before it cannot lazy-load mermaid.
// Reload to get the new ones, but not over typed text, and at most once a minute.
window.addEventListener("vite:preloadError", (event) => {
  const typed = [...document.querySelectorAll("textarea")].some((t) => t.value.trim());
  const last = Number(sessionStorage.getItem("agent-dash:chunk-reload") ?? 0);
  if (typed || Date.now() - last < 60_000) return;
  sessionStorage.setItem("agent-dash:chunk-reload", String(Date.now()));
  event.preventDefault();
  location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
