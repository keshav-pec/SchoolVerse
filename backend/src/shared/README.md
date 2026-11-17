# Shared contract (source of truth)

Schemas, enums, the permission matrix, error codes and DTOs used by **both** the API and the web app.

- Backend imports it as `@shared` (see `tsconfig.json` paths).
- The frontend imports this same folder as `@shared` (alias in `frontend/vite.config.ts` and
  `frontend/tsconfig.json`). Only use packages the frontend also depends on (`zod`,
  `libphonenumber-js`); add any new one to both `package.json` files and to the frontend's
  `resolve.dedupe` and `paths`.
