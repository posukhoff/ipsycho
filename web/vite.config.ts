import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The client is served from `/app` by the same Nest process that serves the API, so `base` must
 * match or every hashed asset resolves against `/`.
 *
 * `assetsDir` is left at Vite's default (`assets`) on purpose: the Caddyfile gives
 * `/app/assets/*` its own `handle` block with `Cache-Control: immutable`, and a renamed directory
 * stops matching it silently — assets would merely go uncached, never stale, which is exactly the
 * kind of regression nobody notices.
 *
 * `fs.allow` reaches one level up because the contract lives in `src/api/contracts/` and is shared
 * with the server rather than copied. A second copy is the thing this whole change exists to avoid.
 */
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [".."] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
