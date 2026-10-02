import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The redesign. Served by a second server instance on :7778 (pnpm start:v2).
export default defineConfig({
  root: "web-v2",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 7780,
    proxy: { "/api": "http://127.0.0.1:7778" },
  },
});
