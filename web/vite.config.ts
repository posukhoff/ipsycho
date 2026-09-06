import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The client is served from `/app` by the same Nest process that serves the API, so `base` must
 * match or every hashed asset resolves against `/`.
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
