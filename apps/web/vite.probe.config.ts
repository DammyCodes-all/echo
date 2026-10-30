import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// TEMP PROBE CONFIG — never commit. Native /api proxy at the snapshot daemon
// (4785) with HMR disabled so concurrent tree edits can't reload the page
// mid-diagnosis. Delete after use.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5201,
    strictPort: true,
    hmr: false,
    proxy: {
      "/api": "http://127.0.0.1:4785",
    },
  },
});
