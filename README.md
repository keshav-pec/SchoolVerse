# SchoolVerse 🪐

The friendly School ERP. **Module 1: School & School Locations Setup.** See [Module1.md](Module1.md) for the full plan.

| Part | Scope | Status |
|---|---|---|
| 1 | Platform foundation: auth, tenant isolation, RBAC, audit infra, app shell | ✅ Done |
| 2 | School & Location master domain (API) | ⏳ Next |
| 3 | School Profile & Locations UI | — |
| 4 | Setup wizard, overview, master APIs, QA | — |

## Layout

```
SchoolVerse/
├─ backend/    Express 5 · TypeScript · Mongoose 9 · Zod 4 · JWT cookies · Vitest
└─ frontend/   React 19 · Vite 8 · Tailwind 4 · React Router · TanStack Query · react-hook-form
```

The two projects are independent, each with its own `package.json`, `node_modules` and configs. Nothing is installed in the root.

**Shared contract.** Schemas, roles, permissions, error codes and DTOs live in `backend/src/shared`, which is the source of truth. The frontend keeps a copy in `frontend/src/shared`. Both projects import it as `@shared`. After changing the backend copy, run `npm run sync-shared` in `frontend/`.

## Getting started

Requirements: Node 20.19+ (22 recommended) and a MongoDB **replica set** (MongoDB Atlas works as-is).

**Terminal 1: backend**
```bash
cd backend
npm install
# add your connection string to backend/.env → MONGODB_URI=...
npm run seed      # demo tenants + one user per role
npm run dev       # http://localhost:4000/api/v1
```

**Terminal 2: frontend**
```bash
cd frontend
npm install
npm run dev       # http://localhost:5173 (proxies /api to the backend)
```

Demo password for every seeded account: `Welcome@123`.

| Email | Role |
|---|---|
| admin@greenfield.demo | School Admin |
| faculty@greenfield.demo | Faculty (read-only) |
| staff@greenfield.demo | Staff (read-only) |
| parent@greenfield.demo | Parent (no config access) |
| admin@riverside.demo | School Admin of a second, isolated tenant |

> Running MongoDB locally? Start it as a replica set: `mongod --replSet rs0`, then `mongosh --eval "rs.initiate()"`.
> Transactions (primary-location switch, audit writes) don't work on a standalone server.

## Scripts

| Folder | Command | What it does |
|---|---|---|
| backend | `npm run dev` | API with hot reload |
| backend | `npm test` | Test suite (in-memory MongoDB replica set, no setup needed) |
| backend | `npm run seed` | Reset and reload demo data |
| backend | `npm run build` / `npm start` | Bundle to `dist/` and run it |
| frontend | `npm run dev` | Web app with hot reload |
| frontend | `npm run build` | Typecheck + production build to `dist/` |
| frontend | `npm run sync-shared` | Refresh `src/shared` from the backend |
| both | `npm run typecheck` / `npm run lint` | TypeScript / ESLint |

## Architecture rules (carried into every module)

- **Tenant isolation is structural.** `tenantId` comes only from the verified session. A Mongoose plugin throws `TENANT_SCOPE_MISSING` on any unscoped query. Cross-tenant IDs return 404.
- **Permissions are enforced on the server** with `requirePermission(...)`. The UI's `<Can>` only decides what to show.
- **IDs are permanent UUIDs.** Labels are for display only.
- **Errors are deterministic:** `{ error: { code, message, details?, requestId } }`. Codes live in `backend/src/shared/errors.ts`.
- **Audit is append-only** and written in the same transaction as the change it records.
