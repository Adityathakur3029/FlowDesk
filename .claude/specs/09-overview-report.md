# 09 — Overview report (GET /reports/overview, program completion times)

**Status:** Done
**Branch:** `middleware`
**Depends on:** [04-program-tasks](./04-program-tasks.md) (`programs`, `tasks`, `tasks.completed_at`, program `startDate`/`endDate`, `INVALID_DATE_RANGE`), [06-teams](./06-teams.md) (`programs.owner_team_id`), [03-login](./03-login.md) (`requireAuth`, `authNote`)

> **Changed by [10-boards](./10-boards.md):**
> - New `scope=all|programs|boards` query param and a `boards[]` breakdown.
> - Board tasks count in every task number (event and snapshot), even on a deleted board.
> - `totals.openTasks`/`overdueTasks` are now counted in SQL instead of summed from `programs[]`.
> - Program-only numbers are 0/empty under `scope=boards`.
>
> The definitions below still hold for program tasks.

## Goal

Leadership wants an organisation **Overview** page: how the org did over a date range. The frontend sends a preset (last 12 months by default, last 3 months, last 1 month) or a custom range. The current contract can't produce it: `GET /programs` has no date filters, a program has no completion time, and tasks are listed only per program.

1. **One reporting endpoint**, `GET /reports/overview?from=YYYY-MM-DD&to=YYYY-MM-DD`, returning totals, deltas against the previous period of the same length, status and priority breakdowns, a created/completed trend, and per-team and per-program rows. All aggregation happens in SQL.
2. **Program completion times.** `programs` gains `completed_at` and `cancelled_at`, set when the status becomes `COMPLETED` / `CANCELLED` and cleared when it leaves. They define when a program "finished", and both are exposed on `Program`.
3. **Tests.** The project has no test runner yet. This spec adds `npm test` (Node's built-in `node:test` through `tsx`, no new packages) with unit tests for the period maths and DB tests for every definition.

## Flow

```
Client (any employee)                         FlowDesk API                                     PostgreSQL
  │ GET /reports/overview                       │ requireAuth                                     │
  │   ?from=2025-10-21&to=2026-10-20            │ overviewReportQuerySchema (from, to YYYY-MM-DD) │
  │────────────────────────────────────────────▶│ resolvePeriod(): from ≤ to, ≤ 1,096 days,       │
  │                                             │   granularity, previous period, buckets, asOf   │
  │                                             │ BEGIN READ ONLY, REPEATABLE READ                │
  │                                             │ 1. in-scope programs + per-program task counts  │
  │                                             │ 2. task event totals (period + previous)        │
  │                                             │ 3. in-scope tasks by status                     │
  │                                             │ 4. open tasks by priority                       │
  │                                             │ 5. created per bucket, 6. completed per bucket  │
  │                                             │ COMMIT                                          │
  │                                             │ roll up teams, programsByStatus, at-risk, sort  │
  │◀────────────────────────────────────────────│ 200 { data: OverviewReport }                    │
```

The six queries run in one read-only `REPEATABLE READ` transaction, so they all see the same snapshot and the numbers add up even while tasks are being edited. Each is a single `GROUP BY` or `FILTER` aggregate; nothing loops over rows in TypeScript except the per-program rows (one per in-scope program), which are rolled up into the team rows and status counts.

## Environment variables

None new.

## Packages

None new. `npm test` uses Node's built-in `node:test` and `node:assert`, run through `tsx` (already a dev dependency).

## Folder layout (new and changed)

```
src/
  db/
    index.ts                          CHANGED  withReadSnapshot() (read-only REPEATABLE READ transaction)
    schema/programs.ts                CHANGED  completed_at, cancelled_at + two CHECKs
    schema/tasks.ts                   CHANGED  indexes on created_at, completed_at
  modules/programs/
    program.service.ts                CHANGED  set/clear completedAt, cancelledAt on status changes
    program.dto.ts                    CHANGED  completedAt, cancelledAt
    program.docs.ts                   CHANGED  the two fields + description of status side effects
  modules/reports/                    NEW
    report.routes.ts                  GET /overview
    report.controller.ts              Zod parse → service → { data }
    report.validation.ts              overviewReportQuerySchema
    report.period.ts                  pure date maths: resolvePeriod, buckets, previous period
    report.repository.ts              the six aggregate queries
    report.service.ts                 getOverviewReport(): validate, run queries in a snapshot, roll up
    report.docs.ts                    OverviewReport schemas + GET /reports/overview
    report.period.test.ts             unit tests (no DB)
    report.service.test.ts            DB tests, every fixture rolled back
  app.ts                              CHANGED  { basePath: "/reports", router: reportRouter }
  docs/openapi.ts                     CHANGED  import report.docs, "Reports" tag
  docs/registry.ts                    CHANGED  DATE_RANGE_TOO_LONG in ErrorResponse.code
package.json                          CHANGED  "test": "tsx --test \"src/**/*.test.ts\""
.claude/CLAUDE.md                     CHANGED  09 in the spec list, Reports in the domain model, npm test
.claude/specs/04-program-tasks.md     CHANGED  programs table: completed_at, cancelled_at
```

Request flow as everywhere else: **route → requireAuth → controller (Zod) → service → repository → Drizzle**. The service validates the period and rolls up rows; every query is built in `report.repository.ts`. The repository isn't built on `createRepository()` because it doesn't own a table; it follows the same `createReportRepository(executor)` / `.withTx(tx)` shape.

## Schema

### `programs` (changed)

| Column | Type | Constraints |
| --- | --- | --- |
| `completed_at` | `timestamptz` | nullable. When the program last became `COMPLETED`; null unless `status = 'COMPLETED'` |
| `cancelled_at` | `timestamptz` | nullable. When the program last became `CANCELLED`; null unless `status = 'CANCELLED'` |

- `CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))` (`programs_completed_state_check`)
- `CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))` (`programs_cancelled_state_check`)
- **Backfill:** existing `COMPLETED` rows get `completed_at = updated_at`, existing `CANCELLED` rows get `cancelled_at = updated_at`. That's the best time available: it's the last write to the row, which is on or after the real status change. The `UPDATE`s run in the migration between `ADD COLUMN` and `ADD CONSTRAINT`, so the checks hold when they're added.
- A program's **finish time** is `coalesce(completed_at, cancelled_at)`. The checks make at most one of them non-null.

Lifecycle (any status can still move to any other, spec 04):

```
         status → COMPLETED                status → CANCELLED
open ────────────────────▶ COMPLETED      open ───────────────────▶ CANCELLED
         completed_at = now()                    cancelled_at = now()
leaving COMPLETED: completed_at = null    leaving CANCELLED: cancelled_at = null
COMPLETED → CANCELLED: completed_at = null, cancelled_at = now()   (and the reverse)
same status sent again: nothing changes
```

Set in `program.service.ts` on create (status `COMPLETED` or `CANCELLED` sets the matching column to now) and on PATCH (only when `status` is sent and differs from the stored one, under the row lock PATCH already takes).

### `tasks` (changed)

New b-tree indexes `tasks_created_at_idx (created_at)` and `tasks_completed_at_idx (completed_at)`. The report's event queries filter on those ranges org-wide, not per program. `due_date` already has `tasks_due_date_idx`, and `(program_id, status)` has `tasks_program_status_idx`, which the per-program joins use.

Migration: `npm run db:generate -- --name add_program_completion_and_report_indexes`, then hand-add the two backfill `UPDATE`s before the `ADD CONSTRAINT` lines.

## Report definitions

All dates are UTC calendar dates. Every query excludes soft-deleted programs, and soft-deleted tasks (and so the tasks of soft-deleted programs).

| Term | Definition |
| --- | --- |
| Period | `[from 00:00Z, to + 1 day 00:00Z)`: both dates inclusive |
| Previous period | Same number of days, ending the day before `from`: `previousPeriod.to = from − 1`, `previousPeriod.from = from − days` |
| `asOf` | Today's UTC date when the report is built. "Overdue" and "at risk" compare against it, not against `to` |
| In-scope program | Active, `created_at` before the end of the period, and not finished before the period started: finish time null or `≥ from 00:00Z` |
| Open task | `status <> 'DONE'` (includes `DEPENDENT`, `ON_HOLD`, `DISCUSSION`, `IN_PROGRESS`) |
| Overdue task | Open, `due_date` not null and `< asOf` |
| At-risk program | `end_date` not null and `< asOf`, and status not `COMPLETED`/`CANCELLED`. Programs without an `endDate` are never at risk |
| Task created in a window | `created_at` in the window |
| Task completed in a window | `status = 'DONE'` and `completed_at` in the window. `completed_at` is the **last** move to DONE, so a task reopened and finished again counts once, in the window of its last completion |
| Completed on time | Completed in the period, with a `due_date`, and `(completed_at AT TIME ZONE 'UTC')::date ≤ due_date`. Tasks without a due date are excluded from both the on-time count and its denominator `tasksCompletedWithDueDate` |
| In-scope task (for `tasksByStatus`) | Task of an in-scope program, created before the end of the period, and open or completed on/after `from` |

**Two task scopes, on purpose:**

- **Event counts** (`tasksCreated*`, `tasksCompleted*`, `tasksCompletedWithDueDate`, `tasksCompletedOnTime`, `trend`) count every live task in every active program, by timestamp. If they were limited to the current period's in-scope programs, a program that finished in the previous period would vanish from `tasksCreatedPrevious` and skew the delta.
- **Snapshot and breakdown counts** (`openTasks`, `overdueTasks`, `openTasksByPriority`, `tasksByStatus`, `teams`, `programs`) count only tasks of in-scope programs, so the per-program rows add up to them.

So `sum(programs[].tasksCompletedInPeriod)` and `sum(teams[].tasksCompleted)` can be lower than `totals.tasksCompleted`, but only when tasks were completed in the period on a program that had already finished before it. Everything else adds up exactly:

- `totals.programs = sum(programsByStatus)`, and it equals the length of `programs`
- `totals.programsAtRisk` equals the number of `programs[].atRisk`
- `totals.openTasks = sum(openTasksByPriority) = sum(programs[].openTasks) = sum(teams[].openTasks)`, and the same for `overdueTasks`
- `sum(trend[].created) = totals.tasksCreated`, and `sum(trend[].completed) = totals.tasksCompleted`

**Statuses are current statuses.** There's no status history: `programsByStatus` and `tasksByStatus` count each row's status *now*, and `openTasks`, `overdueTasks` and `openTasksByPriority` are "as of now" even when `to` is in the past. `programsCompleted` counts programs that are `COMPLETED` now with `completed_at` in the period, so a program completed in the period and reopened since doesn't count.

**A future `to` is allowed and not clamped.** The trend still has buckets up to `to` (they're zero for the future), and `previousPeriod` is computed from the requested range.

### Granularity and trend buckets

- `granularity` is `week` when the period is ≤ 92 days, otherwise `month`. The client can't choose it.
- Weeks are ISO weeks, Monday to Sunday (Postgres `date_trunc('week', …)`), in UTC. Months are calendar months.
- Buckets cover the period exactly, in order, with no gaps or overlaps: the first starts on `from`, the last ends on `to`, so either can be partial. Each bucket is `{ start, end, created, completed }`, with both dates inclusive.
- Every bucket is present even when its counts are zero. Three years at month granularity is at most 37 buckets; 92 days at week granularity is at most 15.

## Validation and errors (`GET /reports/overview`)

Checked in this order:

1. `from` and `to` are required and must be `YYYY-MM-DD` real dates (`z.iso.date()`) → else **400 `Validation failed`**, `details[].path` `"from"` / `"to"` (e.g. `"Invalid ISO date"`, or `"Invalid input: expected string, received undefined"` when missing). Sending one of them twice (`?from=a&from=b`) arrives as an array → 400 ("Invalid input: expected string, received array").
2. `from` after `to` → **400 `INVALID_DATE_RANGE`**, "from must be on or before to" (the same code as program and task dates).
3. More than 1,096 days from `from` to `to`, inclusive (three years plus a leap day) → **400 `DATE_RANGE_TOO_LONG`**, "The report range can be at most 1096 days".

Unknown query parameters are ignored, as on every other list route.

## API

### `GET /reports/overview` — organisation overview for a date range (new)
**Auth:** any active employee (`requireAuth`, no `requireRole`).

> Every other `GET` is open to all roles, and every number here is an aggregate of programs and tasks any employee can already list. Restricting the report would hide nothing. If leadership wants it private later, add `requireRole("ADMIN", "MANAGER")` and a 403 to the docs.

Query (`overviewReportQuerySchema`): `from`, `to` (see Validation).

Response `200 { data: OverviewReport }`:

```jsonc
{
  "data": {
    "period": { "from": "2026-07-22", "to": "2026-10-20", "days": 91, "granularity": "week" },
    "previousPeriod": { "from": "2026-04-22", "to": "2026-07-21", "days": 91 },
    "asOf": "2026-10-20",
    "totals": {
      "programs": 4, "programsCompleted": 1, "programsAtRisk": 1,
      "tasksCreated": 58, "tasksCreatedPrevious": 41,
      "tasksCompleted": 37, "tasksCompletedPrevious": 30,
      "tasksCompletedWithDueDate": 29, "tasksCompletedOnTime": 22,
      "openTasks": 44, "overdueTasks": 7
    },
    "programsByStatus": { "PLANNED": 1, "ACTIVE": 2, "ON_HOLD": 0, "COMPLETED": 1, "CANCELLED": 0 },
    "tasksByStatus": { "DISCUSSION": 9, "ON_HOLD": 4, "IN_PROGRESS": 21, "DONE": 37, "DEPENDENT": 10 },
    "openTasksByPriority": { "HIGHEST": 3, "HIGH": 11, "MEDIUM": 20, "LOW": 8, "LOWEST": 2 },
    "trend": [{ "start": "2026-07-22", "end": "2026-07-26", "created": 3, "completed": 1 }, …],
    "teams": [{ "teamId": "…", "name": "Research", "programs": 2, "tasksCompleted": 25, "openTasks": 30, "overdueTasks": 5 }, …],
    "programs": [{
      "id": "…", "key": "MKT", "name": "Marketing Research", "status": "ACTIVE",
      "ownerTeam": { "id": "…", "name": "Research" },
      "startDate": "2026-07-01", "endDate": "2026-10-15", "completedAt": null,
      "tasksTotal": 40, "tasksDone": 22, "tasksCompletedInPeriod": 18,
      "openTasks": 18, "overdueTasks": 4, "atRisk": true
    }, …]
  }
}
```

Field rules:
- `period.days` and `previousPeriod.days` are the inclusive day counts (always equal).
- `teams`: one row per owner team that owns at least one in-scope program, ordered by `name` (ignoring case), then `teamId`. Programs with no owner team (programs created before teams existed), or whose owner team is soft-deleted, are grouped in one row with `teamId: null, name: null`, listed last. Teams owning no in-scope program are left out.
- `programs`: every in-scope program, unpaginated (an organisation has tens to hundreds). Order: `atRisk` first, then `overdueTasks` descending, then `name` (ignoring case), then `id`. `ownerTeam` is null when there's no owner team or it's soft-deleted. `tasksTotal` counts all live tasks, `tasksDone` those `DONE` now, `tasksCompletedInPeriod` those completed in the period.
- An empty org or an empty range: all counts 0, every status/priority key present with 0, `teams` and `programs` empty, `trend` still has its buckets.

Responses:
- `200 { data: OverviewReport }`
- `400 Validation failed`: `from` / `to` missing, not `YYYY-MM-DD`, not a real date, or repeated
- `400 INVALID_DATE_RANGE`: `from` after `to`
- `400 DATE_RANGE_TOO_LONG`: more than 1,096 days
- `401 AUTH_REQUIRED` / `INVALID_AUTH_TOKEN`
- `500`

### `Program` (changed)

Gains `completedAt` and `cancelledAt` (`date-time` or null) on every program response: `POST`, `GET`, `PATCH /programs…`. `POST` and `PATCH` don't accept them; they follow `status`. Sending them in PATCH is a 400 (unknown key; the schema is strict). In POST they're stripped, like any unknown key.

## Error classes (`src/lib/errors.ts`)

No new classes. `BadRequestError` with `INVALID_DATE_RANGE` (existing code) and `DATE_RANGE_TOO_LONG` (new). Add `DATE_RANGE_TOO_LONG` to the `ErrorResponse.code` description in `src/docs/registry.ts`.

## API documentation

- `report.docs.ts` registers `OverviewReport`, `OverviewReportResponse`, and the parts that are worth naming: `ReportPeriod`, `OverviewTotals`, `TrendBucket`, `TeamReportRow`, `ProgramReportRow`. Every field has a description that states its scope (event vs snapshot, current status, as of `asOf`). The operation description holds the definitions table in short form, the two task scopes, the "current status" caveat, granularity and bucket rules, the future-`to` rule, ordering of `teams` and `programs`, and `authNote()`. Responses: 200 with the full example, 400 with examples for each failure (missing, bad format, `INVALID_DATE_RANGE`, `DATE_RANGE_TOO_LONG`), 401, 500.
- `program.docs.ts`: `completedAt` / `cancelledAt` on `Program` and the example, and a line in the POST and PATCH descriptions on how status sets them.
- `openapi.ts`: a "Reports" tag.
- `npm run docs:validate` must pass and list 38 routes (37 plus `GET /reports/overview`).

## Acceptance checklist

- [x] Migration generated with the backfill, applied, `npm run db:check` passes; existing `COMPLETED` / `CANCELLED` programs have their timestamp
- [x] PATCH a program to `COMPLETED` → `completedAt` set; to `ACTIVE` → cleared; `COMPLETED` → `CANCELLED` swaps them; the same status again keeps the timestamp; create with `COMPLETED` sets it
- [x] `from`/`to` missing or malformed → 400 on that path; `from > to` → 400 `INVALID_DATE_RANGE`; 1,097 days → 400 `DATE_RANGE_TOO_LONG`, 1,096 → 200
- [x] No token → 401
- [x] A program that finished before `from` is excluded; one that finished during the period, and an open one created before `to`, are included; one created after `to` is excluded
- [x] Soft-deleted programs and tasks are excluded everywhere (including the event counts)
- [x] On time vs late vs no due date; overdue only for open tasks with a due date before `asOf`
- [x] Previous-period created/completed counts use the previous window
- [x] Buckets: weekly for ≤ 92 days, monthly beyond; first/last partial; a task at the bucket edge lands in the right bucket; sums equal the totals
- [x] Empty org → zeros, full key sets, buckets present
- [x] Deleted / missing owner team → `ownerTeam: null` and the null team row
- [x] `npm test`, `npm run typecheck`, `npm run build`, `npm run docs:validate` pass

## Testing notes

- `npm test` runs `src/**/*.test.ts` with `tsx --test`. `report.period.test.ts` needs no database.
- `report.service.test.ts` uses the `DATABASE_URL` database. Each test runs in a transaction that's always rolled back: it first hides every existing program inside that transaction (`UPDATE programs SET is_active = false`), then inserts its own employee, teams, programs and tasks with explicit `created_at` / `completed_at`, and calls `getOverviewReport(query, now, tx)` with a fixed `now`. Nothing is left behind, but while a test runs (well under a second) it holds row locks on `programs`, so a write to a program from the dev server waits for it.

## Verified

On 2026-10-20, against the local DB:
- `npm test`: 20 tests pass (11 period unit tests, 9 DB tests covering every definition above). Breaking the "finished before `from`" rule in the repository makes the scope test fail, so the DB tests do detect regressions.
- Migration `0009` applied, and `db:check` passes. The local DB had no `COMPLETED`/`CANCELLED` programs, so the backfill updated nothing; the two CHECKs being added without error confirms every row satisfies them.
- Over HTTP, against an in-process server with an ADMIN token: no token → 401 `AUTH_REQUIRED`; missing `to`, `from=2026-02-30` and a repeated `from` → 400 on the right path; `from > to` → 400 `INVALID_DATE_RANGE`; 1,097 days → 400 `DATE_RANGE_TOO_LONG`; 1,096 days → 200 with 37 monthly buckets; the last 12 months → 200 with 13 buckets on the real data.
- Program timestamps over HTTP: create `COMPLETED` sets `completedAt`; `ACTIVE` clears it; `CANCELLED` sets `cancelledAt`; `CANCELLED` again keeps the same `cancelledAt`; `COMPLETED` swaps them; sending `completedAt` → 400. The smoke rows were hard-deleted afterwards.
- `npm run typecheck`, `npm run build` and `npm run docs:validate` (38 routes) pass.

## Implementation notes

- `npm run build` also compiles the `*.test.ts` files into `dist/`. They aren't run from there and don't affect `npm start`.
- `getOverviewReport(query, now, executor?)` takes the clock and an optional transaction so the DB tests can fix "today" and roll back. The controller calls it with neither.

## Out of scope / follow-ups

- Status history (an activity log), so status breakdowns can be "as of `to`" and a reopened program still counts as completed in the period
- Choosing granularity, filtering by team or program, CSV export
- Caching the report; it's computed on every request
- Restricting the report to ADMIN/MANAGER
- Per-employee throughput
