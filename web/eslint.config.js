import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The client's own lint config. The root one covers `src tests scripts` and is type-aware against
 * the server's tsconfig; pointing it at `web/` too would mean one project service spanning two
 * different `lib` sets. Two configs, one prettier — `.prettierrc` at the repository root applies
 * here as well, so there is still exactly one code style.
 */
export default tseslint.config({ ignores: ["dist/**", "node_modules/**"] }, js.configs.recommended, ...tseslint.configs.recommended, {
  files: ["**/*.{ts,tsx}"],
  languageOptions: {
    globals: {
      window: "readonly",
      document: "readonly",
      navigator: "readonly",
      location: "readonly",
      history: "readonly",
      localStorage: "readonly",
      sessionStorage: "readonly",
      fetch: "readonly",
      Response: "readonly",
      Request: "readonly",
      Headers: "readonly",
      URL: "readonly",
      URLSearchParams: "readonly",
      AbortSignal: "readonly",
      AbortController: "readonly",
      setTimeout: "readonly",
      clearTimeout: "readonly",
      console: "readonly",
      HTMLElement: "readonly",
      RequestInit: "readonly",
    },
  },
  rules: {
    "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    "@typescript-eslint/no-explicit-any": "error",
    "no-console": ["error", { allow: ["warn", "error"] }],
  },
});
