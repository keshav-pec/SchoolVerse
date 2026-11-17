/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** `true` on a testing build whose API has `DEV_OUTBOX` on: shows the link to the dev outbox. */
  readonly VITE_DEV_OUTBOX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
