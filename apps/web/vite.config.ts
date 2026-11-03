import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Pierre's diff worker shares chunks with the app bundle, which requires
  // the ES worker format (IIFE can't code-split).
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4783",
    },
  },
});
