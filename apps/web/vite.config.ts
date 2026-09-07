import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev/build tooling only — test execution goes through vitest.config.ts,
// vitest does NOT read this file (it has its own defineConfig).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `api/client.ts` defaults `VITE_API_BASE_URL` to "" and hits relative
    // `/analyses` / `/analyses/:id`, so a same-origin dev proxy needs zero
    // client code change and no env var to manage — cleaner than a
    // `.env.development`. apps/api listens on `process.env.PORT ?? 3000`
    // (see apps/api/src/main.ts).
    proxy: {
      "/analyses": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
