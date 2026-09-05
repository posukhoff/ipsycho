/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` swaps the transport for `src/mocks/`, so a screen can be built with no backend running. */
  readonly VITE_API_MOCK?: string;
  /** Where the API lives when it is not same-origin, e.g. a dev server proxying a staging host. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
