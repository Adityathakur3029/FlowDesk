# 06 — Teams (employee teams and program owner teams)

**Status:** Done
**Branch:** `teams`
**Depends on:** [01-db-setup](./01-db-setup.md) (`baseColumns()`, `createRepository()`, `withTransaction()`, OpenAPI setup), [03-login](./03-login.md) (`requireAuth`, `requireRole`, `bearerSecurity`, `authNote`, shared 401/403 responses), [04-program-tasks](./04-program-tasks.md) (`programs`, `getActiveProgram()`, `likeContains()`, program docs)

## Goal

Group employees into teams, and give every program a team that owns it.

1. **Teams.** A team is an organisation-level group with a name and a description. ADMINs and MANAGERs create and edit teams. Only an ADMIN can delete one.
2. **One team per employee.** An employee is in **at most one** team. Adding an employee who's already in team A to team B **moves** them: they leave A in the same step.
3. **Program owner team.** Every program has exactly one **owner team**. It's chosen when the program is created, and an ADMIN or MANAGER can hand ownership to another team later. It can't be cleared.
4. **Data only, for now.** The owner team is stored, returned and filterable. It doesn't change who can do what: every signed-in employee still sees and works on every program, as in spec 04. Team-based access control is a follow-up.

## Flow

```
Client (MANAGER)                              FlowDesk API                                    PostgreSQL
  │ POST /teams { name: "Research" }            │ requireAuth → requireRole(ADMIN, MANAGER)     │
  │────────────────────────────────────────────▶│ name free among active teams?  else 409       │
  │◀────────────────────────────────────────────│ 201 { data: Team }                            │
  │                                             │                                               │
  │ PUT /teams/:tid/members/:eid                │ BEGIN                                         │
  │────────────────────────────────────────────▶│ 1. lock team FOR SHARE (active?) else 404     │
  │                                             │ 2. employee active?              else 404     │
  │                                             │ 3. UPDATE employees SET team_id = :tid        │
  │◀────────────────────────────────────────────│ COMMIT → 200 { data: { employee,              │
  │                                             │                        previousTeamId } }     │
  │                                             │                                               │
  │ POST /programs { key, name, ownerTeamId }   │ BEGIN                                         │
  │────────────────────────────────────────────▶│ 1. lock team FOR SHARE (active?) else 400     │
  │                                             │ 2. key free?                     else 409     │
  │                                             │ 3. INSERT programs (owner_team_id)            │
  │◀────────────────────────────────────────────│ COMMIT → 201 { data: Program }                │
  │                                             │                                               │
  │ DELETE /teams/:tid   (ADMIN)                │ BEGIN; lock team FOR UPDATE                   │
  │────────────────────────────────────────────▶│ 1. owns an active program?       else 409     │
  │                                             │ 2. UPDATE employees SET team_id = NULL        │
  │                                             │ 3. teams.is_active = false                    │
  │◀────────────────────────────────────────────│ COMMIT → 204                                  │
```

Anything that attaches something to a team locks the team row `FOR SHARE` inside its transaction: program create, a program PATCH that changes `ownerTeamId`, and adding a member. Deleting a team takes `FOR UPDATE` on the same row. So a team can't be deleted while a program or member is being attached to it, and a delete can't miss a program created at the same moment. Shared locks don't block each other, so concurrent attaches to the same team don't wait for one another.

## Environment variables

None new.

## Packages

None new. Everything uses `drizzle-orm`, `zod` and `@asteasolutions/zod-to-openapi`, which are already installed.

## Folder layout (new and changed)

```
src/
  db/schema/
    teams.ts                         NEW  teams table
    employees.ts                     CHANGED  team_id FK + index
    programs.ts                      CHANGED  owner_team_id FK + index
    index.ts                         CHANGED  export teams
  modules/teams/                     NEW
    team.routes.ts                   /teams CRUD + /:teamId/members
    team.controller.ts
    team.service.ts                  rules, transactions
    team.repository.ts               createRepository(teams) + findByName, lockForUpdate, lockForShare,
                                     findPageWithCounts / findByIdWithCount (member counts)
    team.validation.ts               Zod schemas (also drive the docs)
    team.dto.ts                      toTeamDto
    team.docs.ts
  modules/employees/
    employee.repository.ts           CHANGED  setTeam, clearTeam
    employee.validation.ts           CHANGED  teamId filter on listEmployeesQuerySchema
    employee.service.ts              CHANGED  apply the teamId filter
    employee.dto.ts                  CHANGED  teamId
    employee.docs.ts                 CHANGED  teamId on Employee, teamId query param
  modules/programs/
    program.repository.ts            CHANGED  findActiveByOwnerTeam
    program.validation.ts            CHANGED  ownerTeamId on create / update / list
    program.service.ts               CHANGED  owner team check, transactions on create and update
    program.dto.ts                   CHANGED  ownerTeamId
    program.docs.ts                  CHANGED  ownerTeamId, OWNER_TEAM_NOT_FOUND
  docs/registry.ts                   CHANGED  new error codes
  docs/openapi.ts                    CHANGED  import team.docs, Teams tag
  app.ts                             CHANGED  routeModules: /teams
drizzle/0006_create_teams.sql        NEW  generated migration
.claude/CLAUDE.md                    CHANGED  Team in the domain model, 06 in the spec list
```

The request flow is the same as in specs 01 to 05: **route → requireAuth (→ requireRole) → controller (Zod) → service → repository → Drizzle**. Services don't build queries. Multi-step writes use `withTransaction()` (`src/db/index.ts`) and pass the transaction to repositories with `.withTx(tx)`.

Teams aren't program-owned, so the router is a plain `Router()` mounted at `/teams` in `routeModules`, next to `/employees` and `/invites`.

The program service imports `teamRepository` for the owner team check. The team service imports `programRepository` (for the delete check) and `employeeRepository`. No module imports another module's service, so there's no cycle.

## Schema

### `teams` (new)

| Column | Type | Constraints |
| --- | --- | --- |
| `...baseColumns()` | | `id`, `created_at`, `updated_at`, `is_active` (`false` = deleted) |
| `name` | `varchar(100)` | not null. Stored trimmed, with its case as sent |
| `description` | `text` | nullable |

- Partial unique index `teams_active_name_unique` on `lower(name) WHERE is_active`. Names are unique case-insensitively **among active teams**.
- Teams are organisation-level, like employees, so there's no `program_id`.

> A deleted team's name can be reused, unlike a program key. Program keys are baked into task keys that people paste around, so they stay reserved. A team name is only a label, and "Research" should be available again after the old Research team is deleted.

### `employees` (changed)

| Column | Type | Constraints |
| --- | --- | --- |
| `team_id` | `uuid` | nullable, FK → `teams.id`. `NULL` = not in any team |

Index `employees_team_id_idx` on `team_id`.

> "One team per employee" holds by construction: it's a single column, not a join table, so the rule needs no check. If employees ever need several teams, this becomes a `team_members` table (see Out of scope).

Deactivated employees **keep** their `team_id`, so reactivating them later restores their team. They aren't listed as members or counted in `memberCount`.

### `programs` (changed)

| Column | Type | Constraints |
| --- | --- | --- |
| `owner_team_id` | `uuid` | nullable, FK → `teams.id` |

Index `programs_owner_team_id_idx` on `owner_team_id`.

> **The column is nullable in the DB, but the API never leaves it null.** Programs created before this spec have no team, and adding a `NOT NULL` column without a default fails on a non-empty table. The API requires `ownerTeamId` on create and rejects `null` on PATCH, so only legacy programs have `ownerTeamId: null`. An ADMIN or MANAGER fixes them with `PATCH /programs/:programId { ownerTeamId }`. When none are left, a later migration can add `NOT NULL`.

Soft-deleted programs keep their `owner_team_id`, even after that team is deleted too.

`teams.ts` imports nothing from the other schema files, and `employees.ts` and `programs.ts` import `teams` from it, so there's no import cycle.

Migration: `npm run db:generate -- --name create_teams` → `drizzle/0006_create_teams.sql`. It should contain only `CREATE TABLE teams`, the two `ADD COLUMN`s (nullable), the FKs and the indexes, with no hand edits. Review it, run `npm run db:migrate`, then `npm run db:check`.

## Team rules

### Names

- `name` is trimmed, 1 to 100 characters.
- Create and rename both check `teamRepository.findByName(name)`, which is case-insensitive and looks at active teams only. If another active team already has the name → **409 `TEAM_NAME_EXISTS`** ("Team name Research is already taken").
  - Renaming a team to its own name, or the same name in a different case, is allowed.
- A unique-violation race (`PG_UNIQUE_VIOLATION`) maps to the same 409, the same way `createProgram` handles `PROGRAM_KEY_EXISTS`.

### Membership

- **Add / move** (`PUT /teams/:teamId/members/:employeeId`), in one transaction:
  1. `teamRepository.lockForShare(teamId)`. If the team isn't active → **404 `Team not found`**.
  2. Load the employee (default scope, so active only). Not found → **404 `Employee not found`**.
  3. `previousTeamId = employee.teamId`.
  4. If it's already `teamId`, change nothing. Otherwise `employeeRepository.setTeam(employeeId, teamId)`.
  5. Return `{ employee, previousTeamId }`. `previousTeamId` is `null` when the employee had no team, and equals `teamId` when nothing changed.
- **Remove** (`DELETE /teams/:teamId/members/:employeeId`):
  1. The team is active → else **404 `Team not found`**.
  2. The employee is active **and** `employee.team_id = teamId` → else **404 `Team member not found`**.
  3. Set `team_id = NULL`.
- Moving an employee needs no lock on their old team. Deleting the old team at the same moment only clears `team_id` where it still points at that team (step 3 under "Deleting a team"), so the move survives either way.

> PUT, not POST, because the call is idempotent: sending it twice leaves the same state. The response is 200 with a body, not 204, so the client learns `previousTeamId` and can say "moved from Design".

### Deleting a team

In one transaction:

1. `teamRepository.lockForUpdate(teamId)`. If the team isn't active → **404 `Team not found`**.
2. `programRepository.findActiveByOwnerTeam(teamId, 20)`. If it returns anything → **409 `TEAM_OWNS_PROGRAMS`** ("Team still owns active programs; move them to another team first"). `details` is `{ programs: [{ id, key, name }] }`, with up to 20 programs ordered by `key`.
3. `employeeRepository.clearTeam(teamId)`: `UPDATE employees SET team_id = NULL WHERE team_id = :teamId`. This covers inactive employees too, so nobody points at a deleted team.
4. `teamRepository.deactivate(teamId)`.

> Members are released, not a reason to block the delete. Moving a team's people elsewhere first would take one call per person, and an empty team is the expected end state anyway. Programs do block the delete, because every program must keep an owner team.

### Program owner team

- On `POST /programs`, `ownerTeamId` is required. On `PATCH /programs/:programId` it's optional, but not nullable.
- In the program's transaction, `teamRepository.withTx(tx).lockForShare(ownerTeamId)` must return an active team → else **400 `OWNER_TEAM_NOT_FOUND`** ("Owner team not found").
  - It's 400, not 404, because the bad id is in the body, not the path. That follows `ASSIGNEE_NOT_FOUND` in spec 04.
- On create, the owner team check runs **before** the key check: `OWNER_TEAM_NOT_FOUND` wins over `PROGRAM_KEY_EXISTS` when both apply.
- A PATCH that doesn't send `ownerTeamId` doesn't touch the team, and needs no team lock.
- Spec 04's `createProgram` and `updateProgram` don't use transactions yet. Both now run in `withTransaction()`, because the team lock has to last until the insert or update commits.

## Permissions

| Route | Roles |
| --- | --- |
| `POST /teams`, `PATCH /teams/:teamId` | `ADMIN`, `MANAGER` |
| `DELETE /teams/:teamId` | `ADMIN` |
| `PUT /teams/:teamId/members/:employeeId`, `DELETE /teams/:teamId/members/:employeeId` | `ADMIN`, `MANAGER` |
| `GET /teams`, `GET /teams/:teamId`, `GET /teams/:teamId/members` | any |
| `POST /programs`, `PATCH /programs/:programId` (now including `ownerTeamId`) | `ADMIN`, `MANAGER` (unchanged) |

Every rule is a plain role check, so `requireRole(...)` covers all of it. There are no row-level checks. A MANAGER can move any employee, including an ADMIN, and can manage teams they aren't in.

> MANAGERs can create teams because they already create programs, and a new program needs an owner team. If only ADMINs could create teams, a MANAGER couldn't set up a program for a new group without asking an ADMIN first.

## API

All routes need `Authorization: Bearer <accessToken>`, and all can return the shared `401` (`AUTH_REQUIRED` / `INVALID_AUTH_TOKEN`) and `500` responses. Role-restricted routes can return the shared `403 FORBIDDEN`. Successful bodies use `{ data }`, plus `meta` on lists. Error bodies are `{ error, code?, details? }`.

### Response shapes

`Team` (`toTeamDto(team, memberCount)`):
```json
{ "id": "…", "createdAt": "…", "updatedAt": "…", "isActive": true,
  "name": "Research", "description": "User and market research", "memberCount": 4 }
```
`memberCount` is the number of **active** employees whose `team_id` is this team. The repository computes it with a grouped count (`findPageWithCounts`, `findByIdWithCount`), not a stored column.

`Employee` (`toEmployeeDto`) gains one field:
```json
{ "id": "…", "emailId": "jane.doe@saajha.org", "name": "Jane Doe", "role": "MEMBER",
  "teamId": "3f2c…", "…": "…" }
```

`Program` (`toProgramDto`) gains one field:
```json
{ "id": "…", "key": "MKT", "name": "Marketing Research", "status": "ACTIVE",
  "ownerTeamId": "3f2c…", "…": "…" }
```

Responses return team **ids**, not embedded `{ id, name }` summaries. That keeps `toEmployeeDto` and `toProgramDto` as pure row mappings. Otherwise every employee and program query (including `requireAuth`'s lookup, `/auth/me` and invite accept) would need a join. Teams are a short list, so clients resolve names with `GET /teams`. `teamId` reaches `/employees`, `/auth/me` and `POST /invites/accept` automatically, because they all use `toEmployeeDto`.

### Teams

#### `POST /teams` — create a team
**Roles:** `ADMIN`, `MANAGER`.

Body (`createTeamSchema`):
- `name`: required, trimmed, 1 to 100 characters
- `description`: optional, up to 2,000 characters, or `null`

Responses: `201 { data: Team }` (`memberCount: 0`). `400` validation. `403 FORBIDDEN`. `409 TEAM_NAME_EXISTS`.

#### `GET /teams` — list teams
**Roles:** any.

Query (`listTeamsQuerySchema`):
- `q`: optional, 1 to 100 characters. Case-insensitive substring of `name`, escaped with `likeContains()` from `program.repository.ts`
- `limit` / `offset`: same as `/employees`

Results are sorted by `lower(name) asc`. Deleted teams are never listed. Responses: `200 { data: Team[], meta: PaginationMeta }`. `400` validation.

#### `GET /teams/:teamId` — get a team
**Roles:** any.

`teamId` is a UUID (`teamIdParamSchema`). Responses: `200 { data: Team }`. `400` bad UUID. `404 Team not found`, which includes deleted teams.

#### `PATCH /teams/:teamId` — update a team
**Roles:** `ADMIN`, `MANAGER`.

Body (`updateTeamSchema`, `.strict()`): `name` and/or `description` (nullable). At least one field is required, otherwise 400 `Validation failed` ("At least one field is required"). Unknown fields → 400.

Rules, in order: team active → else 404. Name free → else 409 `TEAM_NAME_EXISTS`.

Responses: `200 { data: Team }`. `400`. `403 FORBIDDEN`. `404`. `409 TEAM_NAME_EXISTS`.

#### `DELETE /teams/:teamId` — delete a team
**Roles:** `ADMIN`.

The steps are under "Deleting a team".

Responses: `204`. `403 FORBIDDEN`. `404`. `409 TEAM_OWNS_PROGRAMS`, with `details.programs`.

#### `GET /teams/:teamId/members` — list a team's members
**Roles:** any.

Query: `limit` / `offset`, same as `/employees`. Returns active employees with `team_id = :teamId`, sorted by `name asc`, then `id`.

Responses: `200 { data: Employee[], meta: PaginationMeta }`. `400`. `404 Team not found`.

#### `PUT /teams/:teamId/members/:employeeId` — add or move an employee into a team
**Roles:** `ADMIN`, `MANAGER`.

Params (`teamMemberParamSchema`): `teamId` and `employeeId`, both UUIDs. No body. The steps are under "Membership".

Responses: `200 { data: { employee: Employee, previousTeamId: string | null } }` (the `TeamMembershipResponse` schema). `400` bad UUID. `403 FORBIDDEN`. `404 Team not found` / `Employee not found`.

#### `DELETE /teams/:teamId/members/:employeeId` — remove an employee from a team
**Roles:** `ADMIN`, `MANAGER`.

Responses: `204`. `400` bad UUID. `403 FORBIDDEN`. `404 Team not found` / `Team member not found`.

### Changes to existing routes

#### `GET /employees` — new `teamId` filter
`listEmployeesQuerySchema` gains `teamId`: a UUID, or the literal `none`. A UUID matches `employees.team_id = :teamId`, and `none` matches `team_id IS NULL` (people not yet in a team). It combines with `role` and `includeInactive`. The team isn't checked for existence: an unknown or deleted team simply returns no rows, as other filters do. Anything else → 400 `Validation failed`.

#### `POST /programs` — `ownerTeamId` required
`createProgramSchema` gains `ownerTeamId: z.uuid()` (required). Rules, in one transaction: owner team → `OWNER_TEAM_NOT_FOUND`, then key → `PROGRAM_KEY_EXISTS`.

Responses add `400 OWNER_TEAM_NOT_FOUND`. A body without `ownerTeamId` → 400 `Validation failed`.

> **Breaking change for clients:** a `POST /programs` that worked before this spec now fails with 400 until it sends `ownerTeamId`.

#### `PATCH /programs/:programId` — `ownerTeamId` can change
`updateProgramSchema` gains an optional `ownerTeamId: z.uuid()`. It isn't nullable, so `null` → 400 `Validation failed` ("A program must have an owner team"). `key` is still rejected. Rules, in one transaction: program active → else 404, then owner team (when sent) → `OWNER_TEAM_NOT_FOUND`.

Responses add `400 OWNER_TEAM_NOT_FOUND`.

#### `GET /programs` — new `ownerTeamId` filter
`listProgramsQuerySchema` gains an optional `ownerTeamId` (UUID), which matches `programs.owner_team_id`. It combines with `status` and `q`.

## Error classes (`src/lib/errors.ts`)

No new classes. The existing ones cover everything:
- `BadRequestError`: `OWNER_TEAM_NOT_FOUND`
- `ConflictError`: `TEAM_NAME_EXISTS`, and `TEAM_OWNS_PROGRAMS` (its `details` carries the programs)
- `NotFoundError`: `Team not found`, `Team member not found`. No codes, the same as `Program not found`

Add the three new codes to the `ErrorResponse.code` description in `src/docs/registry.ts`. Extend the `details` description to mention the programs on `TEAM_OWNS_PROGRAMS`.

## API documentation

- `team.docs.ts`:
  - documents all 8 team routes
  - registers `Team`, `TeamResponse`, `TeamListResponse`, `CreateTeamRequest`, `UpdateTeamRequest` and `TeamMembershipResponse` from the Zod schemas and DTO shapes
  - each operation uses `bearerSecurity` and `authNote(...)` with the roles from the Permissions table
  - the PUT member description says it moves the employee out of any other team, and that it's idempotent
  - the DELETE team description says it releases members and is blocked by active programs
  - every error above has an example under the right status
- `employee.docs.ts`: `teamId` (nullable UUID, "The employee's team; null when not in a team") on the `Employee` schema and its examples, plus the `teamId` query parameter on `GET /employees`.
- `program.docs.ts`:
  - `ownerTeamId` on `Program` (nullable, with a description saying null only appears on programs created before teams existed)
  - required `ownerTeamId` on `CreateProgramRequest`, optional non-nullable on `UpdateProgramRequest`
  - the `ownerTeamId` list filter
  - `OWNER_TEAM_NOT_FOUND` examples on create and update
- `registry.ts`: the new error codes and the `details` description.
- `openapi.ts`: import `team.docs`. Add the tag `Teams` ("Teams of employees; every program has an owner team").
- `npm run docs:validate` must pass and list the 8 new routes.

## Acceptance checklist

- [x] Migration `0006_create_teams` generated, reviewed, applied. It holds nullable columns only. `npm run db:check` passes
- [x] `POST /teams` as a MANAGER → 201, `memberCount: 0`. As a MEMBER → 403. `"research"` while an active `"Research"` exists → 409 `TEAM_NAME_EXISTS`. After deleting `Research`, creating it again → 201
- [x] `PATCH /teams/:id` renaming to another active team's name → 409. Renaming to its own name in a different case → 200. An empty body or an unknown field → 400
- [x] `PUT /teams/A/members/E` → 200, `previousTeamId: null`, `employee.teamId = A`. Again → 200, `previousTeamId = A`. `PUT /teams/B/members/E` → 200, `previousTeamId = A`, and E appears in B's members and not in A's. `memberCount` follows
- [x] PUT with an inactive or unknown employee → 404 `Employee not found`. With a deleted team → 404 `Team not found`. As a MEMBER → 403 *(exercised with an inactive employee; an unknown id takes the same lookup path)*
- [x] `DELETE /teams/B/members/E` → 204, and `teamId` is null. Again, or for an employee in another team → 404 `Team member not found`
- [x] `GET /employees?teamId=<A>` and `?teamId=none` filter correctly. `?teamId=abc` → 400. `/auth/me` returns `teamId`
- [x] `POST /programs` without `ownerTeamId` → 400. With a deleted or unknown team → 400 `OWNER_TEAM_NOT_FOUND`. With an active team → 201, with `ownerTeamId` set
- [x] `PATCH /programs/:id { ownerTeamId: B }` → 200. `{ ownerTeamId: null }` → 400. A PATCH without `ownerTeamId` leaves it unchanged. `GET /programs?ownerTeamId=B` lists the program
- [x] `DELETE /teams/A` as a MANAGER → 403. As an ADMIN while A owns an active program → 409 `TEAM_OWNS_PROGRAMS`, with that program in `details.programs`. After the program moves to B (or is soft-deleted) → 204, A's former members have `teamId: null`, and `GET /teams/A` → 404
- [x] A program created before this migration shows `ownerTeamId: null`, and can be given a team with PATCH
- [ ] Every team route returns 401 without a token *(exercised on `GET /teams` only; every route in `team.routes.ts` has `requireAuth`)*
- [x] `npm run typecheck`, `npm run build`, `npm run docs:validate` pass

## Testing notes

- Get a token the way spec 03 does (`npm run auth:bootstrap-admin` plus a real or test-signed token), then use Swagger UI at `/docs`.
- To check the delete/attach lock, open two transactions in `psql`. In the first, `SELECT … FROM teams WHERE id = :A FOR SHARE` (as program create does), then run `DELETE /teams/A` from the API. The delete should wait until the first transaction ends, then see the new program and return 409.
- Existing local programs show `ownerTeamId: null` right after the migration. That's the legacy case in the checklist.

## Verified

On 2026-10-17, against the local DB:

- Migration `0006_create_teams` was generated and reviewed: one `CREATE TABLE`, two nullable `ADD COLUMN`s, the FKs and three indexes, with no hand edits. It was applied, and `npm run db:check` passes.
- `npm run typecheck`, `npm run build` and `npm run docs:validate` pass. The docs check lists 36 routes, 8 of them new.
- HTTP smoke test on a test server (46/46 pass). It used test employees (ADMIN, MANAGER, two MEMBERs, one inactive) and access tokens signed with the configured secret.
  - **Teams:**
    - a MANAGER can create, a MEMBER gets 403
    - a duplicate name in another case gets 409, a rename to another team's name gets 409, and a rename to its own name in another case is allowed
    - an empty or unknown-field PATCH gets 400
    - `q` search, a bad UUID (400), an unknown team (404)
    - a deleted team's name can be reused
  - **Membership:**
    - add (`previousTeamId: null`), an idempotent repeat (`previousTeamId` = the team), and a move (`previousTeamId` = the old team)
    - member lists and `memberCount` follow the moves
    - an inactive employee gets 404, a MEMBER gets 403
    - remove works, and removing again or from the wrong team gets 404 `Team member not found`
    - `GET /employees?teamId=<id>|none` filters, `teamId=abc` gets 400, and `/auth/me` returns `teamId`
  - **Owner team:**
    - create without `ownerTeamId` (400) or with an unknown team (400 `OWNER_TEAM_NOT_FOUND`) fails, and create with a team works
    - `PROGRAM_KEY_EXISTS` still applies
    - a PATCH with `ownerTeamId: null` gets 400 "A program must have an owner team", and a PATCH without it keeps it
    - moving a program to another team, the `ownerTeamId` list filter, and a PATCH to a deleted team (400)
    - a legacy program (inserted without a team) shows `ownerTeamId: null` and can be given one
  - **Delete:**
    - a MANAGER gets 403, and an owning team gets 409 with the program in `details.programs`
    - after the program moves, it returns 204, the team returns 404, members (including an inactive one) are released, and PUT to the deleted team gets 404
- **Lock check:** one transaction held `FOR SHARE` on a team and inserted a program it owns, and then `DELETE /teams/:id` was sent. The delete waited while the lock was held. After the commit, it returned 409 `TEAM_OWNS_PROGRAMS`.
- All test rows were removed afterwards.

## Implementation notes

- **Where the queries live:**
  - The member list is `employeeRepository.findTeamMembersPage`, and the team service calls it after checking the team.
  - Member counts come from one grouped query per page (`memberCounts` in `team.repository.ts`), used by `findByIdWithCount` and `findPageWithCounts`.
- **Program create:** the key check now runs inside the same transaction as the owner team lock. The unique-violation race still maps to `PROGRAM_KEY_EXISTS`.
- **Docs:**
  - The members list response is registered as `TeamMemberListResponse`.
  - The program create and PATCH 400s now show both the validation shape and the `OWNER_TEAM_NOT_FOUND` shape (`badRequest` in `program.docs.ts`, the same pattern as the task docs).
  - The shared `exampleEmployee` has `teamId: null`.

## Out of scope / follow-ups

- **Team-based access control.** For example, only owner-team members (plus ADMIN) can edit a program or write its tasks, or a program's task assignees must come from its owner team. This would build on spec 04's "per-program membership" follow-up.
- Team leads and roles inside a team (`lead_id`, team admins)
- An employee in several teams (it would replace `employees.team_id` with a `team_members` table), and members from other teams working on a program
- A `teamId` on `POST /employees` and on invites, so new people join a team on accept
- Embedding `team` / `ownerTeam` summaries (`{ id, name }`) in employee, program and task responses. Ids only for now
- A `programCount` on teams, and a `GET /teams/:teamId/programs` shortcut (use `GET /programs?ownerTeamId=`)
- Restoring deleted teams
- Backfilling an owner team on legacy programs, and then making `owner_team_id` `NOT NULL`
- An activity log of team and ownership changes
- Automated tests (there's still no test runner)
