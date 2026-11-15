# Shared contract (source of truth)

Schemas, enums, the permission matrix, error codes and DTOs used by **both** the API and the web app.

- Backend imports it as `@shared` (see `tsconfig.json` paths).
- The frontend keeps a copy in `frontend/src/shared`. After changing anything here, run
  `npm run sync-shared` inside `frontend/` to refresh that copy.
