import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./exits.ts";
import { reloadForNewBuild } from "./lib.tsx";
import "./styles.css";

// A rebuild deletes the old hashed chunks, so a tab opened before it cannot lazy-load mermaid.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
