# 07 — Task types (pre-program, task, post-program, bug, issue)

**Status:** Done
**Branch:** `enhancements`
**Depends on:** [04-program-tasks](./04-program-tasks.md) (`tasks`, `createTaskSchema`, `updateTaskSchema`, `listTasksQuerySchema`, `toTaskDto`, task docs)

## Goal

A program's work isn't all the same kind. Some has to be done before the program starts, most is done while it runs, some comes after it ends, and some is a bug or an issue that turns up along the way. The assigned members do all of it.

1. **One `type` field on every task.** A task is exactly one of these:

   | Type | Meaning |
   | --- | --- |
   | `PRE` | Prerequisite work, to be done before the program starts |
   | `TASK` | The program's main work (the default) |
   | `POST` | Work done after the program ends |
   | `BUG` | Something broken that needs fixing |
   | `ISSUE` | A problem, risk or question that needs resolving |

2. **Still an ordinary task.** Every type works exactly like a task does today:
   - the same `MKT-n` key sequence
   - the same status (including the automatic `DEPENDENT`), assignee, reporter, dates, estimate and labels
   - dependencies and comments
3. **Freedom, no rules.** A program can have any mix, for example 3 `PRE`, 5 `TASK` and 2 `POST`. The type doesn't restrict status changes, dependencies or the program's own status. It's set on create (default `TASK`), can be changed on PATCH at any time, and can be filtered and sorted on.

> **One field, not two.** A "phase" field (pre / during / post) next to a "kind" field (task / bug / issue) would let a task be both a prerequisite and a bug. That was considered and rejected: one field keeps it simple, and a bug or an issue isn't tied to a phase. The consequence: a bug found in post-program work is just a `BUG`, and if its timing matters, a label (`post`) can say so.

## Flow

```
Client (any member)                          FlowDesk API                                   PostgreSQL
  │ POST /programs/:pid/tasks                  │ requireAuth                                   │
  │   { title, type: "PRE", assigneeId }       │ same rules as spec 04 (lock, number, …)       │
  │───────────────────────────────────────────▶│ INSERT tasks (type = 'PRE')                   │
  │◀───────────────────────────────────────────│ 201 { data: TaskDetail (type: "PRE") }        │
  │                                            │                                               │
  │ GET /programs/:pid/tasks                   │                                               │
  │   ?type=PRE&assigneeId=me                  │ WHERE type IN ('PRE') AND assignee_id = me    │
  │───────────────────────────────────────────▶│                                               │
  │◀───────────────────────────────────────────│ 200 { data: Task[], meta: { total: 3, … } }   │
  │                                            │                                               │
  │ PATCH /programs/:pid/tasks/MKT-4           │ BEGIN; lock program row (unchanged)           │
  │   { type: "BUG" }                          │ UPDATE tasks SET type = 'BUG'                 │
  │───────────────────────────────────────────▶│ (status, dependencies untouched)              │
  │◀───────────────────────────────────────────│ COMMIT → 200 { data: TaskDetail }             │
```

There are no new routes. The type rides on the existing task create, update, list and get routes.

## Environment variables

None new.

## Packages

None new. Everything uses `drizzle-orm`, `zod` and `@asteasolutions/zod-to-openapi`, which are already installed.

## Folder layout (new and changed)

```
src/
  db/schema/
    tasks.ts                         CHANGED  task_type enum, tasks.type column, tasks_program_type_idx
  modules/tasks/
    task.validation.ts               CHANGED  taskTypeSchema; type on create / update; type filter, sort=type
    task.repository.ts               CHANGED  type filter in listWhere, type in sortColumns
    task.service.ts                  CHANGED  pass type through on create
    task.dto.ts                      CHANGED  type on toTaskDto
    task.docs.ts                     CHANGED  type on Task, requests, examples, list query
drizzle/0007_add_task_type.sql       NEW  generated migration
.claude/CLAUDE.md                    CHANGED  task type in the domain model, 07 in the spec list
```

The request flow is unchanged: **route → requireAuth → controller (Zod) → service → repository → Drizzle**.

- `updateTask` already spreads the validated fields into the patch (`const { status, ...fields } = input`), so `type` reaches the update with no service change.
- `createTask` builds the row field by field, so it needs `type: input.type` added.

## Schema

### `tasks` (changed)

| Column | Type | Constraints |
| --- | --- | --- |
| `type` | `task_type` | not null, default `TASK` |

`task_type` enum: `PRE`, `TASK`, `POST`, `BUG`, `ISSUE`. Declaration order is the sort order, as with `task_priority`: `sort=type&order=asc` lists prerequisites first, then the main work, then post-program work, then bugs, then issues.

- Index `tasks_program_type_idx` on `(program_id, type)`, for "every `PRE` in this program".
- Postgres doesn't reserve the column name `type`. In Drizzle it's `type: taskType("type")`, and the enum constant is `taskType`, exported next to `taskStatus` / `taskPriority` with a `TaskType` type alias.
- Existing rows become `TASK` through the column default. `ADD COLUMN … NOT NULL DEFAULT 'TASK'` is safe on a non-empty table, unlike the nullable `owner_team_id` in spec 06.

Migration: `npm run db:generate -- --name add_task_type` → `drizzle/0007_add_task_type.sql`. It should contain only `CREATE TYPE task_type`, one `ADD COLUMN` and one `CREATE INDEX`, with no hand edits. Review it, run `npm run db:migrate`, then `npm run db:check`.

## Type rules

There's only validation, on purpose:

- `type` must be one of the five values. Anything else (including lowercase `pre` or `null`) → **400 `Validation failed`**. There's no case folding, so it matches how `status` and `priority` behave.
- Any type can be set on create and changed on PATCH, whatever the task's status, including `DONE` and `DEPENDENT`. Changing the type never changes `status`, `status_before_dependent`, `completed_at` or dependencies.
- Dependencies ignore type. A `TASK` can be blocked by a `PRE`, but also the reverse, and a `BUG` can block a `POST`. Spec 04's dependency rules (same program, no cycles, at most 50) apply unchanged.
- The program's status isn't affected. A program can be `ACTIVE` with open `PRE` work, or `COMPLETED` with open `POST` work, `BUG`s or `ISSUE`s.
- Task keys don't change with the type. Every type shares the program's one `task_counter`, so there's no `MKT-BUG-3`.

> No gating on purpose. "Can't start the program while prerequisites are open" sounds natural, but it would add the first program status transition rule. Teams want the freedom to start with some prerequisites still pending. If that changes, it's a follow-up.

## Permissions

Unchanged from spec 04. Any signed-in employee can create, update and list tasks of any type. Delete is still `ADMIN`, `MANAGER` or the task's reporter.

## API

All routes need `Authorization: Bearer <accessToken>` and can return the shared `401` and `500` responses, as before.

### Response shapes

`Task` (`toTaskDto`) gains one field, placed after `description` in the DTO and the docs:
```json
{ "id": "…", "key": "MKT-3", "number": 3, "title": "Get survey tool licence",
  "type": "PRE", "status": "IN_PROGRESS", "priority": "HIGH", "…": "…" }
```
`TaskDetail` gets it through `toTaskDto`. `TaskSummary` (in `dependsOn` / `blocks`, and the `TASK_BLOCKED` `details.blockers`) **doesn't change**, and stays `{ id, key, title, status }`.

### `POST /programs/:programId/tasks` — create a task (changed)

`createTaskSchema` gains `type: taskTypeSchema.default("TASK")`. It's optional, and when it's left out the task is a `TASK`. All of spec 04's rules and their order are unchanged, and the type has no rule of its own.

Responses: unchanged. A bad `type` → `400 Validation failed`.

### `PATCH /programs/:programId/tasks/:taskRef` — update a task (changed)

`updateTaskSchema` gains an optional `type: taskTypeSchema`, which isn't nullable (`null` → 400). It counts toward "at least one field is required", so `{ "type": "BUG" }` alone is a valid body. It runs inside the existing transaction (the program row is still locked by `lockAndFind`, as for every PATCH).

Responses: unchanged. A bad or null `type` → `400 Validation failed`.

### `GET /programs/:programId/tasks` — list tasks (changed)

`listTasksQuerySchema` changes:

| Param | Rule |
| --- | --- |
| `type` | NEW. Comma-separated `task_type` values (`PRE,POST`), any match. The same `csv.pipe(z.array(taskTypeSchema).min(1))` pattern as `priority` |
| `sort` | gains `type`. Order is `PRE < TASK < POST < BUG < ISSUE`, and `number` breaks ties (the existing `sortColumns` handling) |

The type filter combines with every other filter. `meta.total` on `?type=PRE` is the program's count of prerequisite tasks, so there's no separate count endpoint for now.

Responses: unchanged. An unknown type → `400 Validation failed`.

### `GET /programs/:programId/tasks/:taskRef` — get a task

There's no change beyond `type` in the response.

## Validation (`task.validation.ts`)

```ts
export const taskTypeSchema = z.enum(taskType.enumValues).meta({
  id: "TaskType",
  description:
    "PRE: prerequisite work before the program starts. TASK: the program's main work (default). " +
    "POST: work after the program ends. BUG: something broken to fix. ISSUE: a problem, risk or question to resolve. " +
    "The type is informational: it doesn't affect status, dependencies or the program's status.",
  example: "PRE",
});
```

Add it to `taskFields`. It's `.default("TASK")` on create, and `.optional()` on update and in the list filter.

## Error classes (`src/lib/errors.ts`)

None new. A bad type is a Zod validation failure (`400 Validation failed`). There are no new codes for `registry.ts`.

## API documentation

- `task.docs.ts`:
  - `type: taskTypeSchema` in `taskShape`, so the registered `TaskType` schema appears on `Task` and `TaskDetail`
  - `type: "PRE"` in `exampleTask`, which flows into every task example
  - the create request example shows `type`
  - the create description says it defaults to `TASK`
  - the list 400 description mentions "unknown type" next to status/priority
  - the `type` query param and `sort=type` come from `listTasksQuerySchema` automatically
- `registry.ts`: unchanged.
- `npm run docs:validate` must pass. The route count is unchanged (36).

## Acceptance checklist

- [x] Migration `0007_add_task_type` generated, reviewed (one `CREATE TYPE`, one `ADD COLUMN … DEFAULT 'TASK' NOT NULL`, one index), applied. `npm run db:check` passes
- [x] After the migration, every existing task returns `type: "TASK"`
- [x] Create without `type` → 201, `type: "TASK"`. Create with `type: "PRE"` / `"POST"` / `"BUG"` / `"ISSUE"` → 201 with that type
- [x] Create with `type: "pre"`, `"PREREQUISITE"` or `null` → 400 `Validation failed`
- [x] Tasks of different types in one program share one key sequence (`PRE` = `MKT-1`, `BUG` = `MKT-2`, `TASK` = `MKT-3`)
- [x] `PATCH { type: "BUG" }` alone → 200. `PATCH { type: null }` → 400
- [x] PATCH `type` on a `DEPENDENT` task → 200. The status stays `DEPENDENT`, and finishing its blocker still restores the previous status
- [x] PATCH `type` on a `DONE` task → 200, and `completedAt` is unchanged
- [x] A `TASK` blocked by a `PRE` (and the reverse) → both allowed, and the `DEPENDENT` automation works as in spec 04 *(the reverse was exercised as a `POST` blocked by an `ISSUE`; the dependency code never reads `type`)*
- [x] `?type=PRE` → only prerequisites, and `meta.total` is their count. `?type=BUG,ISSUE` → both. `?type=PRE&assigneeId=me` combines. `?type=FOO` → 400 *(combining was exercised as `?type=PRE&reporterId=me&status=DONE`)*
- [x] `?sort=type&order=asc` → `PRE`, `TASK`, `POST`, `BUG`, `ISSUE`, with ties ordered by number *(checked asc and desc on PRE, POST, BUG and two ISSUEs; TASK's place comes from the enum order)*
- [x] `PATCH /programs/:id { status: "ACTIVE" }` with open `PRE` tasks → 200 (no gating)
- [x] `npm run typecheck`, `npm run build`, `npm run docs:validate` pass

## Testing notes

- Get a token the way spec 03 does, then use Swagger UI at `/docs`.
- Check the migration default on a DB that already has tasks: `SELECT type, count(*) FROM tasks GROUP BY type` should show only `TASK`.

## Verified

On 2026-10-17, against the local DB:

- Migration `0007_add_task_type` was generated and reviewed: `CREATE TYPE task_type`, `ADD COLUMN "type" "task_type" DEFAULT 'TASK' NOT NULL` and `CREATE INDEX tasks_program_type_idx`, with no hand edits. It was applied, and `npm run db:check` passes.
- `npm run typecheck`, `npm run build` and `npm run docs:validate` pass. The docs check still lists 36 routes.
- HTTP smoke test on a test server (24/24 pass), with a test ADMIN and a token signed with the configured secret:
  - existing tasks all read `TASK` after the migration
  - create with each type, and the default `TASK`
  - all types share one key sequence
  - `pre`, `PREREQUISITE` and `null` get 400 on create; `null` gets 400 on PATCH
  - `{ type }` alone is a valid PATCH
  - a type change on a `DEPENDENT` task keeps `DEPENDENT`, and the previous status comes back when the blocker is done
  - a type change on a `DONE` task keeps `completedAt`
  - cross-type dependencies work
  - the `type` filter (one value, several values, combined with others, unknown → 400)
  - `sort=type` asc and desc, with `number` as the tie-breaker
  - a program goes `ACTIVE` with open `PRE` work
  - `TaskType` is in `/openapi.json`
- All test rows were removed afterwards.

## Implementation notes

- `updateTask` needed no change. `type` reaches the patch through the existing `...fields` spread.
- `type` sits right after `description` in the DTO, the docs shape and the validation fields. The request examples and `exampleTask` use `type: "PRE"`.

## Out of scope / follow-ups

- **Gating the program status** on open `PRE` work (no `ACTIVE`) or open `TASK` work (no `COMPLETED`)
- **Type-specific fields**, such as a severity or steps to reproduce on `BUG`, or an impact on `ISSUE`
- **Per-type counts on the program** (for example `taskCounts: { PRE: 3, TASK: 5, POST: 2, … }` on `GET /programs/:programId`). Use `meta.total` on a filtered list for now
- `type` in `TaskSummary` (dependency lists and `TASK_BLOCKED` details)
- Custom or per-program types, and a separate phase field next to the type (see the note under Goal)
- Epics, sub-tasks and other Jira issue-type features (already a spec 04 follow-up)
- Automated tests (there's still no test runner)
