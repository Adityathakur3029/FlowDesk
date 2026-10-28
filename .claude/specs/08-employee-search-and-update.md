# 08 — Employee search and update (`q` on GET /employees, PATCH /employees/:id)

**Status:** Done
**Branch:** `middleware`
**Depends on:** [01-db-setup](./01-db-setup.md) (`createRepository()`, `withTransaction()`, OpenAPI setup), [03-login](./03-login.md) (`requireAuth` re-reads the employee on every request, `requireRole`, `authNote`), [04-program-tasks](./04-program-tasks.md) (`likeContains()`, assignees), [05-comments](./05-comments.md) (mentions), [06-teams](./06-teams.md) (`employees.team_id`, `memberCount`, `UpdateTeamRequest` style)

## Goal

Two changes the FlowDesk frontend needs for its People page and its employee pickers.

1. **Search employees as you type.** `GET /employees` gains a `q` query parameter: a case-insensitive substring match on `name` or `emailId`. Three pickers use it: the member picker in "Create team", the @mention autocomplete in comments, and the assignee picker on tasks. Each calls `?q=jan&limit=10` on every keystroke, so the match and the order must be fast and predictable. Today the frontend would have to download every employee to search.
2. **Edit an employee.** A new `PATCH /employees/:id` lets an ADMIN change an employee's `name`, `role` and `isActive` from an Edit button on each People row. It's the only way to deactivate or reactivate an employee through the API. Team changes keep using `PUT` / `DELETE /teams/:teamId/members/:employeeId` (spec 06), so there's one way to change a team.
3. **Guard rails.** No admin can lock themselves out, and the organisation can't end up without an active ADMIN. Without these, one click on the People page could leave nobody able to manage FlowDesk.
4. **Housekeeping.** `POST /employees` returns its 409 with the `EMPLOYEE_EXISTS` code, the same as the invite routes already do, and the docs say so.

## Flow

```
Client (any employee)                        FlowDesk API                                   PostgreSQL
  │ GET /employees?q=jan&limit=10              │ requireAuth                                   │
  │───────────────────────────────────────────▶│ listEmployeesQuerySchema (q trimmed, 1-100)   │
  │                                            │ WHERE is_active AND (name ILIKE '%jan%'       │
  │                                            │   OR email_id ILIKE '%jan%') [AND role …]      │
  │                                            │ ORDER BY match rank, lower(name), id          │
  │◀───────────────────────────────────────────│ 200 { data: Employee[], meta }                │
  │                                            │                                               │
Client (ADMIN)                                 │                                               │
  │ PATCH /employees/:id { isActive: false }   │ requireAuth → requireRole(ADMIN)              │
  │───────────────────────────────────────────▶│ updateEmployeeSchema (strict, ≥ 1 field)      │
  │                                            │ BEGIN                                         │
  │                                            │ 1. removes an admin? lock active ADMIN rows   │
  │                                            │    FOR UPDATE, ordered by id                  │
  │                                            │ 2. find employee (inactive too)  else 404     │
  │                                            │ 3. self demote / deactivate?     else 409     │
  │                                            │ 4. last active ADMIN?            else 409     │
  │                                            │ 5. nothing changes? → return the row as is    │
  │                                            │ 6. UPDATE employees SET …                     │
  │◀───────────────────────────────────────────│ COMMIT → 200 { data: Employee }               │
  │                                            │                                               │
Client (the deactivated employee)              │                                               │
  │ any request with their old token           │ requireAuth: employee not active              │
  │───────────────────────────────────────────▶│                                               │
  │◀───────────────────────────────────────────│ 401 INVALID_AUTH_TOKEN                        │
```

`PATCH`, not `PUT`, because the body is partial. The admin lock in step 1 is what makes the last-admin rule hold when two admins demote each other at the same moment (see "Guard rails").

## Environment variables

None new.

## Packages

None new. Everything uses `drizzle-orm`, `zod` and `@asteasolutions/zod-to-openapi`, which are already installed.

## Folder layout (new and changed)

```
src/
  modules/employees/
    employee.validation.ts           CHANGED  q on listEmployeesQuerySchema; NEW updateEmployeeSchema
    employee.repository.ts           CHANGED  searchWhere(q), searchOrder(q), lockActiveAdmins()
    employee.service.ts              CHANGED  apply q + order; NEW updateEmployee(); EMPLOYEE_EXISTS code
    employee.controller.ts           CHANGED  update handler
    employee.routes.ts               CHANGED  PATCH /:id (requireRole ADMIN)
    employee.docs.ts                 CHANGED  q param + ordering, PATCH /employees/{id}, 409 codes
  modules/programs/
    program.repository.ts            CHANGED  likeStartsWith() next to likeContains() (shared private likeEscape)
  docs/registry.ts                   CHANGED  SELF_LOCKOUT, LAST_ADMIN in ErrorResponse.code
.claude/CLAUDE.md                    CHANGED  08 in the spec list
```

The request flow is the same as in specs 01 to 07: **route → requireAuth (→ requireRole) → controller (Zod) → service → repository → Drizzle**. The search conditions, the rank expression and the admin lock are built in `employee.repository.ts`, because services don't build queries. The update runs in `withTransaction()` and passes `tx` with `employeeRepository.withTx(tx)`.

## Schema

No table changes and no migration.

### Indexes for `q`

None are added. The checks:

- `employees` has a b-tree on `team_id` and the unique b-trees on `email_id` and `google_sub`. There's nothing on `lower(name)`.
- A b-tree on `lower(name)` or `lower(email_id)` can't serve `ILIKE '%jan%'`, because the pattern starts with a wildcard. It would only help a prefix search, and type-ahead needs substrings ("doe" finding "Jane Doe").
- Only a `pg_trgm` GIN index (`gin (name gin_trgm_ops)`, and one on `email_id`) helps a substring match. It needs `CREATE EXTENSION pg_trgm`, which can need superuser rights on a managed database.
- The table holds one row per person in the organisation: hundreds, at most a few thousand. A sequential scan of that, with the `ILIKE`, the rank and the sort, takes well under a millisecond, so the index would cost write time and a privileged migration for no measurable gain.

> **When to revisit:** add the two trigram indexes (and the extension) if `employees` grows past roughly 50,000 rows, or `EXPLAIN ANALYZE` of `GET /employees?q=…` shows more than about 20 ms. The query shape doesn't change when they're added.

## Search rules (`GET /employees?q=`)

### Validation

`q` is `z.string().trim().min(1).max(100).optional()`, the same rule as `q` on `GET /teams`:
- it's trimmed first, so `q=%20jan%20` searches for `jan`
- empty after trimming (`q=`, `q=%20%20`) → **400 `Validation failed`**, `details: [{ path: "q", message: "Too small: expected string to have >=1 characters" }]`
- over 100 characters after trimming → **400 `Validation failed`** ("Too big: expected string to have <=100 characters")
- leaving `q` out means no search, exactly as today

### Matching

- `name ILIKE likeContains(q) OR email_id ILIKE likeContains(q)`. `likeContains()` (`program.repository.ts`) escapes `\`, `%` and `_`, so `q=50%` matches the literal text `50%` and `q=a_b` doesn't match `axb`.
- `ILIKE` is case-insensitive. `email_id` is stored lowercased, so `q=Jane.Doe@` matches it too.
- No accent folding and no fuzzy matching: `q=jose` doesn't find `José`.
- `q` is ANDed with every other filter: `role`, `teamId` (UUID or `none`) and `includeInactive`. Inactive employees stay excluded unless `includeInactive=true`, which is what the mention and assignee pickers want (both reject inactive employees anyway, with `MENTION_NOT_FOUND` and `ASSIGNEE_NOT_FOUND`).
- `meta.total` counts the matching rows, so the client can show "12 matches".

### Ordering

| `q` | Order |
| --- | --- |
| absent | `created_at desc` (unchanged) |
| present | match rank, then `lower(name) asc`, then `id asc` |

The match rank is a `CASE` on the rows that already matched:

| Rank | The row… | Example for `q=jan` |
| --- | --- | --- |
| 0 | has a name or email equal to `q` (ignoring case) | `Jan`, or `jan@saajha.org` for `q=jan@saajha.org` |
| 1 | has a name that starts with `q`, a word in the name that starts with `q`, or an email that starts with `q` | `Janet King`, `Ana Janssen`, `jan.ek@saajha.org` |
| 2 | matches anywhere else | `Benjamin Ojanen` |

"A word in the name" means the text right after a space (`name ILIKE '% ' || <escaped q> || '%'`). The prefix patterns use `likeStartsWith()`, a new helper next to `likeContains()` with the same escaping.

> The rank costs nothing measurable: it's computed only for rows that already matched, on a table of a few thousand rows. It makes type-ahead feel right: typing `jan` puts `Jan` and `Janet` above `Benjamin`, and typing a surname (`doe`) finds `Jane Doe` in the top group. `lower(name)` then `id` keeps the order total, so pages don't shuffle between requests.

## Update rules (`PATCH /employees/:id`)

### Body (`updateEmployeeSchema`, registered as `UpdateEmployeeRequest`)

`z.strictObject`, the same style as `UpdateTeamRequest`:

| Field | Rule |
| --- | --- |
| `name` | optional; trimmed; 1-150 characters (the same schema as `CreateEmployeeRequest.name`) |
| `role` | optional; `EmployeeRole` (`ADMIN`, `MANAGER`, `MEMBER`) |
| `isActive` | optional; JSON boolean (`"true"` is rejected) |

- At least one field → else **400 `Validation failed`**, `details: [{ path: "", message: "At least one field is required" }]`.
- Unknown fields → **400**, `'Unrecognized key: "email"'`. That covers `email` (bound to the Google account and the invite, so never editable), `teamId` (use the team member routes) and `emailId`.
- `null` for any field → 400.

### Permissions

| Who | Can |
| --- | --- |
| `ADMIN` | edit `name`, `role` and `isActive` of any employee, including other ADMINs and inactive employees, within the guard rails |
| `MANAGER`, `MEMBER` | nothing: **403 `FORBIDDEN`** from `requireRole("ADMIN")` |

> **The whole endpoint is ADMIN only.** A MANAGER-can-edit-names rule would need a row-level check (can a manager rename an admin?) and a field-level one (name yes, role no), for little use: names come from the invite and rarely change, and the People page Edit button is an admin tool. The frontend shows Edit only to ADMINs. Self-service name changes (for example `PATCH /auth/me`) are a follow-up.

Because `requireRole` runs before the controller parses anything, a MANAGER or MEMBER gets 403 even for a bad id or body.

### Rules, in order

All inside one `withTransaction()`:

1. **Lock the admins, if this body could remove one.** The body can remove an active ADMIN when it sends `role` other than `ADMIN`, or `isActive: false`. In that case `employeeRepository.withTx(tx).lockActiveAdmins()`: `SELECT id FROM employees WHERE role = 'ADMIN' AND is_active ORDER BY id FOR UPDATE`. Otherwise no lock.
2. **Find the employee**, inactive ones included (`findById(id, { includeInactive: true })`). No row → **404 `Employee not found`** (no code, like the other 404s). This is read after the lock, so it sees any change a concurrent admin edit just committed.
3. **Self lockout.** If `id` is the caller's own id (`req.auth.employeeId`) and the body sends `isActive: false`, or a `role` other than `ADMIN` → **409 `SELF_LOCKOUT`**. Messages: "You can't deactivate your own account" (checked first) or "You can't change your own role". The caller is always an active ADMIN here, so `role: "ADMIN"` and `isActive: true` on yourself are no-ops and allowed, and so is changing your own `name`.
4. **Last admin.** If the employee is an active ADMIN now and wouldn't be after the update (the new role isn't `ADMIN`, or `isActive` becomes false), and the locked admins from step 1 contain no one else → **409 `LAST_ADMIN`** ("At least one active ADMIN must remain").
5. **No change.** If every sent field already has the sent value, return the row unchanged: 200, no write, `updatedAt` not bumped.
6. **Update** the changed fields with `employeeRepository.withTx(tx).updateById(id, …)` and return the row. `updatedAt` is set by `baseColumns()`'s `$onUpdate`.

> **Why step 4 can still matter after step 3.** With step 3 in place, the caller is an active ADMIN who isn't the target, so there's always another admin, and step 4 never fires for a single request. It fires when two admins act at the same moment: A demotes B while B demotes A. Each request alone sees two admins. With the lock, the second transaction waits for the first, then re-reads the admin set (READ COMMITTED re-checks the `WHERE` on the locked rows), sees one admin, and gets 409 `LAST_ADMIN`. Without the lock both would succeed and leave zero admins. Locking in `id` order means two such transactions take the locks in the same order and can't deadlock. Requests that can't remove an admin (renames, promotions, reactivations) take no lock and never wait.

> **Why 409 and not 403 or 400.** The request is valid and the caller has the role; it's refused because of the current state (who you are, how many admins exist). 403 would read as "you lack permission", which the frontend shows differently.

Known edge: the caller's own role is checked by `requireAuth` when the request starts. If another admin demotes the caller while the caller's request is in flight, that one request still completes. The next one gets 403.

### What deactivation does

| Thing | Effect |
| --- | --- |
| Sign-in token | `requireAuth` re-reads the employee on every request with the default scope, so the next request with any existing token gets **401 `INVALID_AUTH_TOKEN`** ("Invalid or expired access token"). Not `ACCOUNT_INACTIVE`. The frontend should treat it like any expired session and send them to sign-in |
| Signing in again | `POST /auth/google` → **403 `ACCOUNT_INACTIVE`** ("Your account has been deactivated") |
| Team | `team_id` is **kept** (spec 06). They drop out of `GET /teams/:teamId/members` and the team's `memberCount` goes down by one. `GET /employees?teamId=<team>&includeInactive=true` still lists them. Reactivating them puts them back in the same team, unless that team was deleted in the meantime (team delete clears `team_id` on inactive employees too) |
| Tasks | Nothing changes. Tasks assigned to them keep the assignee, tasks they reported keep the reporter, and responses still show them (spec 04). New assignments to them → 400 `ASSIGNEE_NOT_FOUND`. Reassigning their open tasks is the client's job (`GET /programs/:programId/tasks?assigneeId=<id>`) |
| Comments and mentions | Their comments and existing mentions stay and still show them (spec 05). New mentions of them → 400 `MENTION_NOT_FOUND` |
| Lists and pickers | `GET /employees` hides them unless `includeInactive=true`. `GET /employees/:id` returns 404 for them (unchanged) |
| Google account | `google_sub` stays bound, so after reactivation they sign in with the same Google account |

### What a role change does

The token carries a `role` claim, but `requireAuth` ignores it and takes the role from the DB row (spec 03). So the new role applies to the employee's **next request**, including `GET /auth/me`, with no new sign-in. Nothing else changes: their teams, tasks and comments stay.

## API

All routes need `Authorization: Bearer <accessToken>`, and all can return the shared `401` (`AUTH_REQUIRED` / `INVALID_AUTH_TOKEN`) and `500` responses. Successful bodies use `{ data }`, plus `meta` on lists. Error bodies are `{ error, code?, details? }`, and validation errors are `{ error: "Validation failed", details: [{ path, message }] }`.

### `GET /employees` — list and search employees (changed)
**Auth:** any active employee (unchanged).

Query (`listEmployeesQuerySchema`): `q` (new, see "Search rules"), `role`, `teamId` (UUID or `none`), `includeInactive`, `limit` (1-100, default 20), `offset` (≥ 0, default 0). All filters combine with AND.

Responses:
- `200 { data: Employee[], meta: { total, limit, offset } }`, ordered as in "Ordering"
- `400 Validation failed`: `q` empty after trimming or over 100 characters, unknown `role`, `teamId` not a UUID or `none`, non-boolean `includeInactive`, `limit` outside 1-100, negative `offset`

### `PATCH /employees/:id` — update an employee (new)
**Auth:** ADMIN only.

Params (`employeeIdParamSchema`): `id`, a UUID. Body: `UpdateEmployeeRequest` (see "Body"). Rules: see "Rules, in order".

Responses:
- `200 { data: Employee }` (`EmployeeResponse`), the employee after the update, or unchanged when nothing differed
- `400 Validation failed`: `id` not a UUID, an empty body, an unknown field (`email`, `teamId`, …), `name` empty or over 150 characters after trimming, unknown `role`, non-boolean `isActive`, or a `null`
- `400 Malformed JSON body`
- `403 FORBIDDEN`: the caller isn't an ADMIN
- `404 Employee not found`: no employee, active or not, has this id
- `409 SELF_LOCKOUT`: the caller tried to deactivate or demote themselves
- `409 LAST_ADMIN`: the change would leave no active ADMIN

### `POST /employees` — create an employee (changed)
`createEmployee` now throws `ConflictError(…, "EMPLOYEE_EXISTS")`, for both the pre-check and the unique-violation race. The 409 body becomes `{ error: "Employee with email jane.doe@saajha.org already exists", code: "EMPLOYEE_EXISTS" }`, matching `POST /invites`. Nothing else changes.

## Error classes (`src/lib/errors.ts`)

No new classes:
- `ConflictError`: `SELF_LOCKOUT`, `LAST_ADMIN`, and `EMPLOYEE_EXISTS` on `POST /employees`
- `NotFoundError`: `Employee not found`, no code

Add `SELF_LOCKOUT` and `LAST_ADMIN` to the `ErrorResponse.code` description in `src/docs/registry.ts`. `EMPLOYEE_EXISTS` is already listed.

## API documentation

- `employee.docs.ts`:
  - `GET /employees`: the `q` parameter (from the Zod `.meta`), the description states the matching (name or email, case-insensitive, wildcards literal), that it ANDs with the other filters, and both orderings with the rank tiers. The 400 description adds the `q` rule, with a `q` example.
  - `PATCH /employees/{id}`: new operation. Summary, a description of the editable fields, the rules in order, the deactivation and role-change side effects, idempotency, `BODY_HEADER` and `authNote("ADMIN")`. Request body `UpdateEmployeeRequest` with an example. Responses 200 (`EmployeeResponse`), 400 (examples: empty body, unknown field, bad `name`), 401, 403, 404, 409 (examples: `SELF_LOCKOUT` and `LAST_ADMIN`), 500.
  - `POST /employees`: the 409 names `EMPLOYEE_EXISTS` and its example has the `code`.
  - `GET /employees/{id}` description: point to `PATCH` for reactivation, and to `GET /employees?includeInactive=true` for reading inactive employees.
- `registry.ts`: the two new codes.
- `npm run docs:validate` must pass and list 37 routes (36 plus `PATCH /employees/{id}`).

## Acceptance checklist

- [x] `GET /employees?q=jan` → only employees with `jan` in their name or email, any case. `q=JAN` gives the same result
- [x] `q=%`, `q=_` and `q=\` match only names or emails containing those literal characters
- [x] `q=` and `q=%20%20` → 400 on `q`. 101 characters → 400. 100 characters → 200. `q=%20jan%20` → same as `q=jan`
- [x] `q` combines with `role`, `teamId`, `teamId=none` and `includeInactive=true`; `meta.total` counts matches
- [x] Order with `q`: exact > prefix / word prefix / email prefix > other substring, then name (ignoring case), then id. Without `q`: `createdAt` desc, as before
- [x] `PATCH /employees/:id` as a MANAGER or MEMBER → 403 `FORBIDDEN`
- [x] As an ADMIN: `{ name: "  New Name " }` → 200, `name: "New Name"`. `{ role: "MANAGER" }` on another employee → 200. `{}` → 400. `{ email: "x@y.z" }` / `{ teamId: … }` → 400. `{ name: "" }`, `{ role: "OWNER" }`, `{ isActive: "false" }`, `{ name: null }` → 400. A bad UUID → 400. An unknown UUID → 404
- [x] `{ isActive: false }` on an employee → 200. Their old token → 401 `INVALID_AUTH_TOKEN`. Their team's `memberCount` drops by one and `teamId` is kept. `{ isActive: true }` on the same (inactive) employee → 200, and they're back in the team
- [x] Self: `{ isActive: false }` → 409 `SELF_LOCKOUT`. `{ role: "MEMBER" }` → 409 `SELF_LOCKOUT`. `{ role: "ADMIN", name: "Me" }` → 200
- [x] Demoting or deactivating the only active ADMIN → 409 `LAST_ADMIN` *(through `updateEmployee()` directly, see Testing notes)*
- [ ] Two ADMINs demoting each other at the same moment → one 200, one 409 `LAST_ADMIN`; one active ADMIN remains *(not run end to end: the local DB has a real ADMIN, so there were always three. What was checked: a demotion waits while the active ADMIN rows are locked `FOR UPDATE` and completes after the lock is released, and a rename doesn't wait)*
- [x] Sending the current values → 200, `updatedAt` unchanged
- [x] A role change applies on the next request: a demoted MANAGER → MEMBER gets 403 on `POST /teams`, and `GET /auth/me` shows the new role, with the same token
- [x] `POST /employees` with an existing email → 409 with `code: "EMPLOYEE_EXISTS"`
- [x] `npm run typecheck`, `npm run build`, `npm run docs:validate` pass

## Testing notes

- Get tokens the way spec 03 does: test employees (ADMIN, a second ADMIN, MANAGER, MEMBER) and access tokens signed with `AUTH_JWT_SECRET`.
- `LAST_ADMIN` can't be reached through one HTTP request when step 3 works, which is the point. Check it by calling `updateEmployee()` directly with a caller id that isn't the target and isn't an admin, or by holding the admin lock in `psql` (`SELECT … WHERE role = 'ADMIN' AND is_active FOR UPDATE`) while the API demotes one of two admins, then committing a demotion of the other.

## Verified

On 2026-10-18, against the local DB:

- No migration (no schema change).
- `npm run typecheck`, `npm run build` and `npm run docs:validate` pass. The docs check lists 37 routes, including `PATCH /employees/{id}`. The generated `UpdateEmployeeRequest` has `additionalProperties: false`, and `q` shows `minLength: 1`, `maxLength: 100`.
- HTTP smoke test on a test server (57/57 pass), with zqx-tagged test employees (two ADMINs, a MANAGER, a MEMBER and search fixtures), a test team, and tokens signed with the configured secret:
  - **Search:** the rank order for `q=zqxjan` (exact, then word prefix / email prefix / name prefix sorted by name, then substring), case-insensitivity, trimming, literal `%`, `_` and `\`, an email match, `q=` / blank / 101 characters → 400, 100 characters → 200, AND with `role`, `teamId`, `teamId=none` and `includeInactive`, paging the ranked list with `meta.total`, and `createdAt desc` without `q`
  - **PATCH validation and roles:** MANAGER → 403, MEMBER with a bad id → 403, a trimmed rename, `{}`, `email`, `teamId`, empty or 151-character `name`, `role: "OWNER"`, `isActive: "false"`, `name: null`, a bad UUID → 400, an unknown UUID → 404, malformed JSON → 400
  - **Deactivation:** `teamId` kept, `memberCount` 1 → 0 → 1 on deactivate and reactivate, the old token → 401 `INVALID_AUTH_TOKEN` while inactive and accepted again after reactivation, `GET /employees/:id` → 404 while inactive
  - **Guard rails:** self deactivate and self demote → 409 `SELF_LOCKOUT` with the two messages, a self rename with `role: "ADMIN"` → 200, demoting another admin → 200. `LAST_ADMIN` for both deactivate and demote, by calling `updateEmployee()` with the DB's real ADMIN as the target and a non-admin caller; the real ADMIN was unchanged afterwards
  - **Lock:** with the active ADMIN rows held `FOR UPDATE` in a separate DB transaction, a demotion PATCH didn't complete within 800 ms and returned 200 after the rollback. A rename PATCH sent at the same time returned at once
  - **Other:** resending current values → 200 with the same `updatedAt`; a MANAGER demoted to MEMBER gets 403 on `POST /teams` and `/auth/me` shows `MEMBER` with the same token; `POST /employees` with an existing email in upper case → 409 `EMPLOYEE_EXISTS`
- All test rows were removed afterwards (the DB again holds its original one ADMIN and one MEMBER).

## Implementation notes

- `likeContains()` and the new `likeStartsWith()` share a private `likeEscape()` in `program.repository.ts`. The word-prefix pattern is `` `% ${likeStartsWith(q)}` ``.
- The rank and the conditions are `employeeRepository.searchWhere(q)` and `searchOrder(q)`. Without `q`, `listEmployees` passes no `orderBy`, so `findPage`'s default (`created_at desc`) applies as before.
- `updateEmployee(id, input, auth)` takes the `AuthContext`, like `listTasks` and `deleteTask`. Step 3 reuses the "removes an admin" flag from step 1 for the role check, since the caller is always an ADMIN.
- The 409 on PATCH documents three examples (`selfDeactivate`, `selfRole`, `lastAdmin`).

## Out of scope / follow-ups

- Trigram indexes for `q` (see "When to revisit")
- Accent-insensitive search (`unaccent`) and fuzzy matching
- A dedicated 401 `ACCOUNT_INACTIVE` from `requireAuth` for a deactivated employee's token. Today it's `INVALID_AUTH_TOKEN`, the same as an expired token (spec 03), and changing it is an auth contract change
- `GET /employees/:id?includeInactive=true` (read an inactive employee by id). Use the list with `includeInactive=true`, or the PATCH response
- Self-service profile edits (`PATCH /auth/me` for your own name)
- MANAGER rights on the People page
- Reassigning or unassigning a deactivated employee's open tasks automatically
- Changing an employee's email (it's bound to their Google account and invite)
- An activity log of role and status changes
- Automated tests (there's still no test runner)
