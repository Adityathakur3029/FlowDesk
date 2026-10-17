# 01 — Database setup (Drizzle ORM) + `employees` table

**Status:** Done
**Branch:** `db-setup`

## Goal

Bootstrap the data layer for FlowDesk:

1. Wire **Drizzle ORM** on top of the existing `pg` pool.
2. Establish a **migration flow** every future table goes through.
3. Define **base columns** shared by all tables.
4. Provide a **reusable repository** (query helpers with options) that the service layer uses.
5. Create the first table, **`employees`**, plus an API to seed it.

## Packages

| Package | Kind | Purpose |
| --- | --- | --- |
| `drizzle-orm` (0.45.x) | dep | Schema, query builder, runtime migrator |
| `drizzle-kit` (0.31.x) | dev dep | Generates SQL migrations from the schema |
| `zod` (4.x) | dep | Request validation |

## Folder layout

```
drizzle.config.ts              drizzle-kit config (schema path, out dir, DATABASE_URL)
drizzle/                       generated SQL migrations + meta/ snapshots (commit these)
src/
  db/
    index.ts                   pg Pool, `db = drizzle(pool, { schema })`, withTransaction, types
    migrate.ts                 programmatic migrator (applies ./drizzle)
    repository.ts              createRepository(table) — generic CRUD helpers
    schema/
      base.ts                  baseColumns()
      employees.ts             employee_role enum + employees table
      index.ts                 re-exports every table (drizzle-kit entry point)
  lib/errors.ts                AppError, NotFoundError, ConflictError, pg error helpers
  middleware/errorHandler.ts   maps Zod / AppError / unique-violation errors to HTTP
  modules/employees/
    employee.routes.ts         Express router
    employee.controller.ts     parse + validate request, call service, shape response
    employee.service.ts        business rules
    employee.repository.ts     createRepository(employees) + findByEmail
    employee.validation.ts     Zod schemas
```

Request flow: **route → controller (Zod) → service → repository → Drizzle → Postgres**. Controllers never touch Drizzle; services never touch `req`/`res`.

## Base columns

Every table spreads `...baseColumns()` (a function, so each table gets fresh column builders):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | `DEFAULT gen_random_uuid()` (Postgres 13+) |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()`, set to `new Date()` by Drizzle on every update (`$onUpdate`) |
| `is_active` | `boolean` | `NOT NULL DEFAULT true`. Used for soft delete. |

> `updated_at` is maintained by Drizzle, not a DB trigger, so raw SQL updates will not bump it.

## `employees` table

| Column | Type | Constraints |
| --- | --- | --- |
| base columns | | see above |
| `email_id` | `varchar(255)` | `NOT NULL`, `UNIQUE (employees_email_id_unique)`. Org email, stored lowercased. |
| `name` | `varchar(150)` | `NOT NULL` |
| `role` | `employee_role` enum (`ADMIN`, `MANAGER`, `MEMBER`) | `NOT NULL DEFAULT 'MEMBER'` |

Migration: `drizzle/0000_create_employees.sql`.

## Migration flow

| Command | What it does |
| --- | --- |
| `npm run db:generate -- --name <change>` | Diff `src/db/schema` against the last snapshot and write a new SQL file in `drizzle/` |
| `npm run db:migrate` | Apply pending migrations (dev, via tsx) |
| `npm run db:migrate:prod` | Same, from compiled `dist/` (run after `npm run build`, no drizzle-kit needed) |
| `npm run db:check` | Check migration files for consistency/conflicts |
| `npm run db:studio` | Browse the DB in Drizzle Studio |

Adding a table:
1. Create `src/db/schema/<table>.ts` with `...baseColumns()` (program-owned tables also get `programId` FK to `programs.id`).
2. Export it from `src/db/schema/index.ts`.
3. `npm run db:generate -- --name <table>`, review the SQL, commit it with the schema change.
4. `npm run db:migrate`.

Rules: never edit an applied migration, and never use `drizzle-kit push` against a shared DB. Applied migrations are tracked in `drizzle.__drizzle_migrations`.

## Repository (`src/db/repository.ts`)

`createRepository(table, executor = db)` works for any table built with `baseColumns()`. All reads hide soft-deleted rows (`is_active = false`) unless `includeInactive: true` is passed.

| Method | Description |
| --- | --- |
| `findById(id, { includeInactive? })` | One row or `undefined` |
| `findOne(where, { includeInactive? })` | First row matching a Drizzle `SQL` condition |
| `findMany({ where, orderBy, limit, offset, includeInactive })` | Defaults to `ORDER BY created_at DESC` |
| `findPage(opts)` | `{ items, total, limit, offset }`; limit defaults to 20, capped at 100 |
| `count(where?, opts)` / `exists(where, opts)` | |
| `create(data)` / `createMany(data[])` | Return inserted rows |
| `updateById(id, patch)` | `id`/`createdAt`/`updatedAt` not patchable; `undefined` if no match |
| `deactivate(id)` / `activate(id)` | Soft delete / restore |
| `hardDeleteById(id)` | Permanent delete; prefer `deactivate` |
| `withTx(tx)` | Same repository bound to a transaction |

Table-specific repositories spread the base and add lookups (e.g. `employeeRepository.findByEmail`).

Transactions:

```ts
await withTransaction(async (tx) => {
  const emp = await employeeRepository.withTx(tx).create({ ... });
  // other repos .withTx(tx) ...
});
```

## API

### `POST /employees` — seed an employee

Request:
```json
{ "email": "jane@saajha.org", "name": "Jane Doe", "role": "MANAGER" }
```
- `email`: required, trimmed, lowercased, valid email, max 255, unique (case-insensitive because of the lowercasing)
- `name`: required, trimmed, 1–150 chars
- `role`: `ADMIN` | `MANAGER` | `MEMBER`

Responses:
- `201` → `{ "data": { id, createdAt, updatedAt, isActive, emailId, name, role } }`
- `400` → `{ "error": "Validation failed", "details": [{ "path", "message" }] }`
- `409` → email already exists, including deactivated employees (the service checks first, and the DB unique constraint covers concurrent inserts)

### Supporting endpoints (for verification)
- `GET /employees?role=&includeInactive=&limit=&offset=` → `{ data: [...], meta: { total, limit, offset } }`
- `GET /employees/:id` → `200`, `400` for a non-UUID id, `404` if not found or inactive

## API documentation

All endpoints, including `/health-check`, are documented in OpenAPI 3.0.3, generated from the Zod validation schemas (see `src/docs/` and `employee.docs.ts`). Swagger UI is at `/docs` and the raw spec at `/openapi.json`. `npm run docs:validate` validates the spec and checks that the documented routes match the Express routes exactly.

A malformed JSON body returns `400 { error: "Malformed JSON body", details: [...] }`. Before this change it returned 500.

## Verified

- `tsc --noEmit` and `npm run build` pass.
- Migration `0000_create_employees` applied to the local DB.
- Manual smoke test: create (201, email normalised), duplicate (409), invalid body (400), list with role filter + pagination, bad UUID (400), unknown id (404). The test row was removed afterwards.

## Out of scope / follow-ups

- Auth and role-based access on these endpoints (anyone can seed right now).
- Automated tests (no test runner configured yet).
- `programs`, `tasks` (task assignee → `employees.id`), and the program-owned research entities.
