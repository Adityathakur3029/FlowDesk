# 04 — Programs and tasks (Jira-style tasks with dependencies)

**Status:** Done
**Branch:** `tasks`
**Depends on:** [01-db-setup](./01-db-setup.md) (`baseColumns()`, `createRepository()`, error handler, OpenAPI setup), [03-login](./03-login.md) (`requireAuth`, `requireRole`, `req.auth`, `bearerSecurity`, `authNote`, shared 401/403 responses)

> **Changed by [10-boards](./10-boards.md):**
> - A task's parent is a program **or a board**.
> - Task numbers come from one global sequence (`task_number_seq`), so they're no longer per program. `programs.task_counter` and `nextTaskNumber` are gone, and creating a task locks the parent row with `lockForUpdate`.
> - `DEPENDENCY_OTHER_PROGRAM` is now `DEPENDENCY_OTHER_PARENT`.
> - Every single-task route is also served at `/tasks/{taskRef}`, and the task lists take `createdFrom`/`createdTo`.
>
> The rest of this spec still holds.

## Goal

Give FlowDesk its core work-tracking entities.

1. **Programs (minimal).** `programs` is the core entity from CLAUDE.md, and nothing exists yet. This spec adds a small version: a short **key** (`MKT`), name, description and status, with create/list/get/update/delete. A later spec can extend it (owner, members, dates) without restructuring.
2. **Tasks, like Jira issues.** Every task belongs to one program and has:
   - a human key: `<PROGRAM KEY>-<n>` (`MKT-42`), numbered per program
   - a **title** (the heading) and a description
   - a status: `DISCUSSION`, `ON_HOLD`, `IN_PROGRESS`, `DONE` or `DEPENDENT`
   - a priority, an assignee and a reporter
   - a start date, a due date and an estimated time
   - labels
3. **Dependencies ("is blocked by").** A task can depend on other tasks in the same program. `DEPENDENT` is **fully automatic**:
   - A task with an unfinished blocker becomes `DEPENDENT`.
   - When its last blocker is done, it goes back to the status it had before.
   - `isDependent` is computed from the links. It isn't stored.

## Flow

```
Client                                   FlowDesk API                                   PostgreSQL
  │ POST /programs { key:"MKT", name }     │                                              │
  │───────────────────────────────────────▶│ requireAuth → requireRole(ADMIN, MANAGER)    │
  │◀───────────────────────────────────────│ 201 { data: Program }                        │
  │                                        │                                              │
  │ POST /programs/:pid/tasks              │ BEGIN                                        │
  │   { title, assigneeId, dependsOn:[…] } │ 1. UPDATE programs SET task_counter += 1     │
  │───────────────────────────────────────▶│    RETURNING key, task_counter  (row lock)   │
  │                                        │ 2. validate assignee, blockers (same program)│
  │                                        │ 3. INSERT task (key = MKT-<counter>)         │
  │                                        │ 4. INSERT task_dependencies                  │
  │                                        │ 5. syncDependentStatus(task)                 │
  │◀───────────────────────────────────────│ COMMIT → 201 { data: TaskDetail }            │
  │                                        │                                              │
  │ PATCH /programs/:pid/tasks/MKT-3       │ BEGIN; lock program row                      │
  │   { status: "DONE" }                   │ 1. rules (TASK_BLOCKED, …)                   │
  │───────────────────────────────────────▶│ 2. update task, completed_at = now()         │
  │                                        │ 3. for each task that depends on MKT-3:      │
  │                                        │      syncDependentStatus(dependent)          │
  │◀───────────────────────────────────────│ COMMIT → 200 { data: TaskDetail }            │
```

Every write that can change the dependency graph or a task's DONE-ness locks the program row (`SELECT … FOR UPDATE`) first, inside one transaction. That means task creation, a status change, adding or removing a dependency, and deleting a task. Because of the lock, two concurrent requests can't create a cycle between them, can't both see a stale blocker status, and can't hand out the same task number. Task creation gets the lock for free from the counter `UPDATE`. Writes to different programs don't block each other.

## Environment variables

None new.

## Packages

None new. Everything uses `drizzle-orm`, `zod` and `@asteasolutions/zod-to-openapi`, which are already installed.

## Folder layout (new and changed)

```
src/
  db/schema/
    programs.ts                    NEW  programs table, program_status enum
    tasks.ts                       NEW  tasks, task_dependencies, task_status / task_priority enums
    index.ts                       CHANGED  export programs, tasks
  modules/programs/                NEW
    program.routes.ts              /programs CRUD + GET /:programId/labels
    program.controller.ts
    program.service.ts
    program.repository.ts          createRepository(programs) + findByKey, nextTaskNumber, lockForUpdate
    program.validation.ts          Zod schemas (also drive the docs)
    program.dto.ts                 toProgramDto (hides task_counter)
    program.docs.ts
  modules/tasks/                   NEW
    task.routes.ts                 Router({ mergeParams: true }), mounted at /programs/:programId/tasks
    task.controller.ts
    task.service.ts                business rules, transactions
    task.dependencyStatus.ts       syncDependentStatus(tx, taskId) — the only code that sets/clears DEPENDENT
    task.repository.ts             createRepository(tasks) + joined list/detail queries, label stats
    taskDependency.repository.ts   createRepository(taskDependencies) + blockers/dependents, cycle check
    task.validation.ts
    task.dto.ts                    toTaskDto / toTaskDetailDto
    task.docs.ts
  docs/registry.ts                 CHANGED  new error codes, EmployeeSummary schema
  docs/openapi.ts                  CHANGED  import program.docs, task.docs; Programs / Tasks tags
  app.ts                           CHANGED  routeModules: /programs, /programs/:programId/tasks
drizzle/0004_create_programs_and_tasks.sql   NEW  generated migration
```

The request flow is the same as in specs 01 to 03: **route → requireAuth (→ requireRole) → controller (Zod) → service → repository → Drizzle**. Services never import `db` or build queries. They call repositories, and use `withTransaction` plus `.withTx(tx)` for multi-step writes. The task service resolves the program first, through `programService.getActiveProgram(programId)`, so an unknown **or soft-deleted** program returns 404 on every task route.

Mount order in `routeModules`: put `/programs/:programId/tasks` before `/programs`. Both work either way, because the paths don't overlap, but the order keeps the docs validator's output tidy.

## Schema

### `programs`

| Column | Type | Constraints |
| --- | --- | --- |
| `...baseColumns()` | | `id`, `created_at`, `updated_at`, `is_active` |
| `key` | `varchar(10)` | not null, `UNIQUE` (`programs_key_unique`), uppercase, **immutable** |
| `name` | `varchar(150)` | not null |
| `description` | `text` | nullable |
| `status` | `program_status` | not null, default `PLANNED` |
| `start_date` | `date` (mode `string`) | nullable, `YYYY-MM-DD`. Planned start |
| `end_date` | `date` (mode `string`) | nullable, `YYYY-MM-DD`. Planned end |
| `completed_at` | `timestamptz` | nullable. Set while `status = 'COMPLETED'` (spec 09) |
| `cancelled_at` | `timestamptz` | nullable. Set while `status = 'CANCELLED'` (spec 09) |
| `task_counter` | `integer` | not null, default `0`. The last task number handed out. Internal, never returned. |

- `CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)` (`programs_date_range_check`, migration `0008_add_program_dates`). This backs up the service rule. Program dates don't constrain task dates.

`program_status` enum: `PLANNED`, `ACTIVE`, `ON_HOLD`, `COMPLETED`, `CANCELLED`. There are no transition rules yet: any status can move to any other.

> The key is immutable because it's baked into every task key (`MKT-42`), and people paste those keys into chats and docs. Jira can rename a key only because it keeps a history of the old ones. Building that is out of scope.

Keys of soft-deleted programs stay taken (the unique index covers every row), the same way employee emails do.

### `tasks`

| Column | Type | Constraints |
| --- | --- | --- |
| `...baseColumns()` | | |
| `program_id` | `uuid` | not null, FK → `programs.id` |
| `number` | `integer` | not null. Per-program sequence, never reused |
| `key` | `varchar(24)` | not null, `UNIQUE` (`tasks_key_unique`). `<program.key>-<number>`, stored so lookup by key is one index hit |
| `title` | `varchar(255)` | not null |
| `description` | `text` | nullable (plain text or Markdown; the API stores it as-is) |
| `status` | `task_status` | not null, default `DISCUSSION` |
| `status_before_dependent` | `task_status` | nullable. Set only while `status = 'DEPENDENT'`. Internal, never returned |
| `priority` | `task_priority` | not null, default `MEDIUM` |
| `assignee_id` | `uuid` | nullable, FK → `employees.id` |
| `reporter_id` | `uuid` | not null, FK → `employees.id` (the creator, taken from `req.auth`) |
| `start_date` | `date` (mode `string`) | nullable, `YYYY-MM-DD` |
| `due_date` | `date` (mode `string`) | nullable, `YYYY-MM-DD` |
| `estimate_minutes` | `integer` | nullable. The original estimate, in minutes |
| `labels` | `text[]` | not null, default `'{}'` |
| `completed_at` | `timestamptz` | nullable. Set when the task moves to `DONE`, cleared when it leaves `DONE` |

Enums:
- `task_status`: `DISCUSSION`, `ON_HOLD`, `IN_PROGRESS`, `DONE`, `DEPENDENT`. The request used hyphens (`ON-HOLD`). Underscores keep the values consistent with the existing enums (`employee_role`, `invite_status`) and usable as identifiers in client code.
- `task_priority`: `LOWEST`, `LOW`, `MEDIUM`, `HIGH`, `HIGHEST`. Declaration order matters, because Postgres sorts enums by it, so `sort=priority&order=desc` puts `HIGHEST` first.

Constraints and indexes:
- `UNIQUE (program_id, number)` (`tasks_program_number_unique`)
- `CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date)` (`tasks_date_range_check`). This backs up the service rule.
- `CHECK (estimate_minutes IS NULL OR estimate_minutes > 0)`
- `CHECK ((status = 'DEPENDENT') = (status_before_dependent IS NOT NULL))` (`tasks_dependent_state_check`)
- indexes: `(program_id, status)`, `assignee_id`, `due_date`, and a GIN index on `labels`

### `task_dependencies`

A row means "`task_id` is blocked by `depends_on_task_id`". It's program-owned, so it has `program_id` (CLAUDE.md convention), which also makes the same-program rule cheap to check.

| Column | Type | Constraints |
| --- | --- | --- |
| `...baseColumns()` | | `is_active` is always `true` (see note) |
| `program_id` | `uuid` | not null, FK → `programs.id` |
| `task_id` | `uuid` | not null, FK → `tasks.id` (the dependent task) |
| `depends_on_task_id` | `uuid` | not null, FK → `tasks.id` (the blocker) |

- `UNIQUE (task_id, depends_on_task_id)` (`task_dependencies_pair_unique`)
- `CHECK (task_id <> depends_on_task_id)` (`task_dependencies_no_self_check`)
- index on `depends_on_task_id`, used to find a task's dependents

> Links are **hard-deleted** (`hardDeleteById`). They carry no history worth keeping, and a soft-deleted link would block re-adding the same pair under the unique index. The table still spreads `baseColumns()` so it works with `createRepository()`.

Migration: `npm run db:generate -- --name create_programs_and_tasks` → `drizzle/0004_create_programs_and_tasks.sql`. Review it, then run `npm run db:migrate`.

## Task keys

- Task creation runs `UPDATE programs SET task_counter = task_counter + 1 WHERE id = :programId AND is_active RETURNING key, task_counter` inside the creation transaction. The returned counter becomes the task's `number`, and `key = "<key>-<number>"`.
- If the insert fails later, the transaction rolls back and the counter goes back with it. Numbers of soft-deleted tasks are never reused, so `MKT-7` always means the same task.
- Task routes take `:taskRef`: either the task **UUID** or its **key**, matched case-insensitively (`mkt-7` → `MKT-7`). A key whose prefix isn't this program's key gets 404 `Task not found`. So does a UUID of a task in another program.

## Dependency and status rules

### Definitions

- A **blocker** of task T is an active task B with a `task_dependencies` row (`task_id = T`, `depends_on_task_id = B`).
- An **open blocker** is a blocker whose status isn't `DONE`.
- `isDependent` (returned by the API) is `true` when T has **at least one blocker**, open or not. It answers "is this task linked to others it depends on?". An open blocker is exactly what `status = DEPENDENT` reflects.

### `syncDependentStatus(tx, taskId)`

This is the only code that sets or clears `DEPENDENT`. Run it inside the caller's transaction, after the program row is locked.

1. If the task is `DONE`, do nothing. Finished work stays finished (see "reopening a blocker" below).
2. Count the open blockers.
3. If there are open blockers and the status isn't `DEPENDENT`: set `status_before_dependent = status` and `status = DEPENDENT`.
4. If there are none and the status is `DEPENDENT`: set `status = status_before_dependent` and `status_before_dependent = NULL`.
5. Otherwise, do nothing.

It's called:

| Event | Run it on |
| --- | --- |
| Task created with `dependsOn` | the new task |
| Dependency added or removed | the dependent task (`task_id`) |
| Task status changed **into or out of `DONE`** | every task that depends on it |
| Task soft-deleted | every task that depended on it (after its links are deleted) |

The cascade is exactly **one level deep**. `syncDependentStatus` never moves a task into or out of `DONE`, so it can't change whether that task blocks anything, and there's nothing further to propagate.

### Manual status changes (`PATCH … { status }`)

The order is:

1. `status` must be `DISCUSSION`, `ON_HOLD`, `IN_PROGRESS` or `DONE`. `DEPENDENT` fails Zod validation, giving **400 `Validation failed`** with the message "DEPENDENT is set automatically from the task's dependencies".
2. If the task is currently `DEPENDENT`, the request fails with **409 `TASK_BLOCKED`** ("Task is blocked by unfinished dependencies"). `details` holds `{ blockers: [{ id, key, title, status }] }` with the open blockers. To unblock the task, finish or remove its blockers.
3. If the task is `DONE`, has open blockers and is being reopened (to a non-DONE status), it's saved as `DEPENDENT` with `status_before_dependent` set to the requested status. This happens when a blocker was reopened after the task finished.
4. Moving into `DONE` sets `completed_at = now()`. Moving out of `DONE` clears it.
5. If DONE-ness changed, run `syncDependentStatus` on every dependent.

> **Consequence:** reopening a blocker (`DONE → IN_PROGRESS`) puts its non-DONE dependents back into `DEPENDENT`. Dependents that are already `DONE` stay `DONE`.

### Adding a dependency

The order is:

1. The blocker (`dependsOnTaskId`) is an active task. If not → **400 `DEPENDENCY_TASK_NOT_FOUND`**.
2. It's in the same program. If not → **400 `DEPENDENCY_OTHER_PROGRAM`**.
3. It isn't the task itself. If it is → **400 `SELF_DEPENDENCY`**.
4. The pair doesn't exist yet. If it does → **409 `DEPENDENCY_EXISTS`**.
5. The task has fewer than **50** blockers. If not → **400 `DEPENDENCY_LIMIT_REACHED`**.
6. The link doesn't create a cycle. That means the task must not be reachable from the blocker by following `depends_on` links. If it is → **409 `DEPENDENCY_CYCLE`** ("Adding this dependency would create a cycle"). The check is a recursive CTE written with Drizzle's `sql` template and run through `executor.execute`, because Drizzle's query builder has no recursive CTE. Raw SQL is allowed for this under CLAUDE.md.
7. If the task is `DONE` and the blocker isn't → **409 `TASK_DONE`** ("Reopen the task before adding an unfinished dependency").
8. Insert the link, then run `syncDependentStatus(task)`.

The same rules apply to every id in `dependsOn` on create, where steps 4 and 5 become "no duplicates in the array" (validated by Zod) and "at most 50 entries". A new task can't be part of a cycle.

### Field rules (create and update)

| Rule | Failure |
| --- | --- |
| `assigneeId` (when set) is an **active** employee | **400 `ASSIGNEE_NOT_FOUND`** |
| `dueDate >= startDate`, checked on the **merged** values on PATCH (for example, setting only `dueDate` before the existing `startDate`) | **400 `INVALID_DATE_RANGE`** |
| A task is created as `DONE` while a blocker in `dependsOn` is open | **409 `TASK_BLOCKED`** |

Past dates are allowed, so old work can be backfilled. If an assignee is deactivated later, the task keeps them, and the response still shows them.

## Permissions

There's no per-program membership yet (a follow-up from spec 03), so every signed-in employee can see every program.

| Route | Roles |
| --- | --- |
| `POST /programs`, `PATCH /programs/:programId` | `ADMIN`, `MANAGER` |
| `DELETE /programs/:programId` | `ADMIN` |
| `GET /programs`, `GET /programs/:programId`, `GET /programs/:programId/labels` | any |
| Task create, read, update, add/remove dependency | any |
| `DELETE /programs/:programId/tasks/:taskRef` | `ADMIN`, `MANAGER`, or the task's **reporter**. Anyone else gets **403 `FORBIDDEN`** |

The reporter check is a service rule (it needs the row), so it isn't `requireRole` middleware. It throws the same `ForbiddenError(…, "FORBIDDEN")` so the docs can reuse the shared 403 response.

## API

All routes need `Authorization: Bearer <accessToken>`, and all can return the shared `401` (`AUTH_REQUIRED` / `INVALID_AUTH_TOKEN`) and `500` responses. Successful bodies use `{ data }`, plus `meta` on lists. Error bodies are `{ error, code?, details? }`.

### Response shapes

`Program` (`toProgramDto`):
```json
{ "id": "…", "createdAt": "…", "updatedAt": "…", "isActive": true,
  "key": "MKT", "name": "Marketing Research", "description": null, "status": "ACTIVE" }
```

`Task` (`toTaskDto`, used for list items):
```json
{
  "id": "…", "createdAt": "…", "updatedAt": "…", "isActive": true,
  "programId": "…", "key": "MKT-7", "number": 7,
  "title": "Draft survey questions", "description": "…",
  "status": "DEPENDENT", "priority": "HIGH",
  "assignee": { "id": "…", "name": "Jane Doe", "emailId": "jane.doe@saajha.org" },
  "reporter": { "id": "…", "name": "Ravi Kumar", "emailId": "ravi.kumar@saajha.org" },
  "startDate": "2026-10-20", "dueDate": "2026-10-31", "estimateMinutes": 480,
  "labels": ["survey", "q4"], "completedAt": null, "isDependent": true
}
```
`assignee` is `null` when the task is unassigned. `EmployeeSummary` (`{ id, name, emailId }`) is a new shared schema in `registry.ts`. `status_before_dependent` and `program.task_counter` are never returned.

`TaskDetail` (`toTaskDetailDto`, used for single-task responses) is `Task` plus:
```json
{
  "dependsOn": [{ "id": "…", "key": "MKT-3", "title": "Finalise sample", "status": "IN_PROGRESS" }],
  "blocks":    [{ "id": "…", "key": "MKT-9", "title": "Run survey", "status": "DEPENDENT" }]
}
```
These are `TaskSummary` objects for active tasks only, ordered by `number`.

### Programs

#### `POST /programs` — create a program
**Roles:** `ADMIN`, `MANAGER`.

Validation (`createProgramSchema`):
- `key`: required. Trimmed and uppercased, then it must match `^[A-Z][A-Z0-9]{1,9}$` (2 to 10 characters, starting with a letter).
- `name`: required, trimmed, 1 to 150 characters.
- `description`: optional, up to 10,000 characters, or `null`.
- `status`: optional, `program_status`, default `PLANNED`.
- `startDate` / `endDate`: optional, `YYYY-MM-DD` (`z.iso.date()`) or `null`. `endDate >= startDate` when both are set, otherwise 400 `INVALID_DATE_RANGE` ("endDate must be on or after startDate"). Past dates are allowed.

Responses: `201 { data: Program }`. `400` validation / `INVALID_DATE_RANGE`. `403 FORBIDDEN`. `409 PROGRAM_KEY_EXISTS` ("Program key MKT is already taken"), including keys of soft-deleted programs. A unique-violation race maps to the same code.

#### `GET /programs` — list programs
**Roles:** any.

Query (`listProgramsQuerySchema`):
- `status`: optional `program_status`
- `q`: optional, 1 to 100 characters, case-insensitive substring match on `name` or `key`
- `limit` / `offset`: same as `/employees`

Results are sorted by `createdAt desc`. Responses: `200 { data: Program[], meta: PaginationMeta }`. `400` validation.

#### `GET /programs/:programId` — get a program
**Roles:** any.

`programId` is a UUID. Responses: `200 { data: Program }`. `400` bad UUID. `404` `Program not found`, which includes soft-deleted programs.

#### `PATCH /programs/:programId` — update a program
**Roles:** `ADMIN`, `MANAGER`.

Body (`updateProgramSchema`): any of `name`, `description` (nullable), `status`, `startDate` and `endDate` (nullable). At least one field is required, otherwise 400 `Validation failed`. `key` isn't accepted. The schema is `.strict()`, so sending `key` returns 400 with the message "Program key cannot be changed".

The date range is checked on the **merged** values (for example, sending only an `endDate` before the stored `startDate` → 400 `INVALID_DATE_RANGE`). The update locks the program row (`lockForUpdate`) first, so two concurrent single-date edits can't each pass the check and then trip the DB constraint together.

Responses: `200 { data: Program }`. `400` validation / `INVALID_DATE_RANGE`. `403 FORBIDDEN`. `404`.

#### `DELETE /programs/:programId` — soft-delete a program
**Roles:** `ADMIN`.

Sets `is_active = false`. The program's tasks are left as they are, but every route under the program now returns 404. There's no restore endpoint yet.

Responses: `204`. `403 FORBIDDEN`. `404`.

#### `GET /programs/:programId/labels` — labels used in a program
**Roles:** any.

Returns the distinct labels across the program's active tasks, with a usage count, for label autocomplete. The query uses `unnest(labels)` through the `sql` template.

Responses: `200 { data: [{ "label": "survey", "taskCount": 4 }] }`, ordered by `taskCount desc, label asc`. `404`.

### Tasks (`/programs/:programId/tasks`)

`:taskRef` (`taskRefParamSchema`) is a UUID or a task key matching `^[A-Za-z][A-Za-z0-9]{1,9}-\d+$`. Anything else → 400 `Validation failed`. Every task route first resolves the program (404 `Program not found`), then the task (404 `Task not found`).

Shared field validation (`taskFieldsSchema`):
- `title`: trimmed, 1 to 255 characters
- `description`: up to 20,000 characters, or `null`
- `status`: `DISCUSSION` / `ON_HOLD` / `IN_PROGRESS` / `DONE`
- `priority`: `task_priority`
- `assigneeId`: UUID or `null`
- `startDate` / `dueDate`: `YYYY-MM-DD` (`z.iso.date()`) or `null`
- `estimateMinutes`: integer from 1 to 525,600 (one year), or `null`
- `labels`: up to 20 items. Each item is trimmed and lowercased, then must match `^[a-z0-9][a-z0-9._-]{0,49}$` (no spaces, as in Jira). Duplicates are removed after normalising.

#### `POST /programs/:programId/tasks` — create a task
**Roles:** any.

Body (`createTaskSchema`): `title` is required. Everything else is optional: `description`, `status` (default `DISCUSSION`), `priority` (default `MEDIUM`), `assigneeId`, `startDate`, `dueDate`, `estimateMinutes`, `labels` (default `[]`) and `dependsOn` (UUIDs, unique, at most 50). `reporterId` comes from `req.auth.employeeId`. If the body sends it, it's ignored.

Business rules, in this order, in one transaction:
1. Lock the program and take a number (see Task keys).
2. Assignee check → `ASSIGNEE_NOT_FOUND`.
3. Date range check → `INVALID_DATE_RANGE`.
4. Each `dependsOn` id → `DEPENDENCY_TASK_NOT_FOUND` / `DEPENDENCY_OTHER_PROGRAM`.
5. `status: DONE` with an open blocker → `TASK_BLOCKED`.
6. Insert the task and its links, then run `syncDependentStatus`.

Responses: `201 { data: TaskDetail }`. `400` validation / `ASSIGNEE_NOT_FOUND` / `INVALID_DATE_RANGE` / `DEPENDENCY_TASK_NOT_FOUND` / `DEPENDENCY_OTHER_PROGRAM`. `404` program. `409 TASK_BLOCKED`.

#### `GET /programs/:programId/tasks` — list and filter tasks
**Roles:** any.

Query (`listTasksQuerySchema`):

| Param | Rule |
| --- | --- |
| `status` | comma-separated `task_status` values (`IN_PROGRESS,DEPENDENT`), any match |
| `priority` | comma-separated `task_priority` values, any match |
| `assigneeId` | UUID, or the literal `me` (`req.auth.employeeId`) |
| `unassigned` | stringbool. `true` → `assignee_id IS NULL`. Combined with `assigneeId` → 400 `Validation failed` |
| `reporterId` | UUID or `me` |
| `label` | comma-separated, normalised like `labels`. Matches tasks with **any** of them (`labels && ARRAY[…]`) |
| `dueFrom` / `dueTo` | `YYYY-MM-DD`, inclusive. If both are given, `dueFrom <= dueTo` |
| `isDependent` | stringbool, filters on the computed flag |
| `q` | 1 to 100 characters. Case-insensitive substring of `title`, or an exact key match |
| `sort` | `number` / `createdAt` / `updatedAt` / `dueDate` / `priority`, default `number` |
| `order` | `asc` / `desc`, default `desc` |
| `limit` / `offset` | same as `/employees` |

Null `dueDate` values sort last in both directions. `number` is always the tie-breaker. Soft-deleted tasks are never listed (there's no `includeInactive`).

Responses: `200 { data: Task[], meta: PaginationMeta }`. `400` validation. `404` program.

#### `GET /programs/:programId/tasks/:taskRef` — get a task
**Roles:** any.

Responses: `200 { data: TaskDetail }`. `400`. `404`.

#### `PATCH /programs/:programId/tasks/:taskRef` — update a task
**Roles:** any.

Body (`updateTaskSchema`): any subset of `title`, `description`, `status`, `priority`, `assigneeId`, `startDate`, `dueDate`, `estimateMinutes` and `labels`. At least one field is required. Nullable fields accept `null` to clear them. `labels` **replaces** the whole array. Dependencies change only through the dependency routes, so `dependsOn` is rejected (`.strict()`).

Business rules, in this order: assignee → date range (merged values) → status rules (see "Manual status changes"). Everything runs in one transaction with the program row locked.

Responses: `200 { data: TaskDetail }`. `400` validation / `ASSIGNEE_NOT_FOUND` / `INVALID_DATE_RANGE`. `404`. `409 TASK_BLOCKED`.

#### `DELETE /programs/:programId/tasks/:taskRef` — soft-delete a task
**Roles:** `ADMIN`, `MANAGER`, or the reporter.

In one transaction:
1. Lock the program.
2. Set `is_active = false`.
3. Hard-delete every `task_dependencies` row where the task is on either side.
4. Run `syncDependentStatus` on its former dependents. A dependent whose only open blocker this was leaves `DEPENDENT`.

The task's number isn't reused.

Responses: `204`. `403 FORBIDDEN`. `404`.

#### `POST /programs/:programId/tasks/:taskRef/dependencies` — add a blocker
**Roles:** any.

Body (`addDependencySchema`): `{ "dependsOnTaskId": "<uuid>" }`. The rules are under "Adding a dependency".

Responses: `201 { data: TaskDetail }` (the dependent task, with its possibly new status). `400` `DEPENDENCY_TASK_NOT_FOUND` / `DEPENDENCY_OTHER_PROGRAM` / `SELF_DEPENDENCY` / `DEPENDENCY_LIMIT_REACHED`. `404`. `409` `DEPENDENCY_EXISTS` / `DEPENDENCY_CYCLE` / `TASK_DONE`.

#### `DELETE /programs/:programId/tasks/:taskRef/dependencies/:dependsOnTaskId` — remove a blocker
**Roles:** any.

`dependsOnTaskId` is a UUID. The service deletes the link and runs `syncDependentStatus(task)`.

Responses: `200 { data: TaskDetail }`. The response is 200, not 204, because the task's status may have just changed and the client needs it. `400`. `404` `Task not found` / `Dependency not found`.

## Error classes (`src/lib/errors.ts`)

No new classes. The existing ones cover everything:
- `BadRequestError`: `ASSIGNEE_NOT_FOUND`, `INVALID_DATE_RANGE`, `DEPENDENCY_TASK_NOT_FOUND`, `DEPENDENCY_OTHER_PROGRAM`, `SELF_DEPENDENCY`, `DEPENDENCY_LIMIT_REACHED`
- `ConflictError` (its `details` carries the blockers for `TASK_BLOCKED`): `PROGRAM_KEY_EXISTS`, `TASK_BLOCKED`, `TASK_DONE`, `DEPENDENCY_EXISTS`, `DEPENDENCY_CYCLE`
- `NotFoundError`: `Program not found`, `Task not found`, `Dependency not found` (no codes, the same as `Employee not found`)
- `ForbiddenError(…, "FORBIDDEN")`: the reporter check on task delete

Add the 11 new codes to the `ErrorResponse.code` description in `src/docs/registry.ts`. Add `details` to `errorResponseSchema` as an optional field, described as "Extra context on some errors, e.g. the open blockers on TASK_BLOCKED". The error handler already sends it, but the schema doesn't document it yet.

## API documentation

- `registry.ts`:
  - new error codes
  - optional `details` on `ErrorResponse`
  - `EmployeeSummary` schema
  - a shared `NotFound` (404) response with examples for the program and task cases, if more than one module ends up needing it
- `program.docs.ts`: documents all 6 program routes, including `/labels`. Registers the `Program`, `ProgramResponse`, `ProgramListResponse`, `CreateProgramRequest` and `UpdateProgramRequest` schemas from the Zod schemas. Each operation uses `bearerSecurity` and `authNote(...)` with the roles from the Permissions table, and states that the key is immutable and stays reserved after soft delete.
- `task.docs.ts`:
  - documents all 7 task routes and registers `Task`, `TaskDetail`, `TaskSummary`, `TaskStatus`, `TaskPriority` and the request schemas
  - the `TaskStatus` description explains the automatic `DEPENDENT` rules (who sets it, `TASK_BLOCKED`, reopening). The `isDependent` description says it's computed
  - `:taskRef` is documented as "UUID or task key (case-insensitive)"
  - the delete operation's description states the reporter rule, since `authNote()` only covers roles
  - every error code above has an example under the right status
- `openapi.ts`: import both docs files. Add the tags `Programs` ("Programs, the core entity that owns tasks and future research content") and `Tasks` ("Jira-style tasks within a program, including dependencies").
- `npm run docs:validate` must pass and list all 13 new routes.

## Acceptance checklist

- [x] Migration `0004_create_programs_and_tasks` generated, reviewed, applied. `npm run db:check` passes
- [x] `POST /programs` as a MANAGER with `key: "mkt"` → 201, key `MKT`. As a MEMBER → 403. Same key again (even after the first is soft-deleted) → 409 `PROGRAM_KEY_EXISTS`
- [x] `PATCH /programs/:id` with `key` → 400. `DELETE` as a MANAGER → 403, as an ADMIN → 204, then `GET` → 404 and task routes → 404
- [x] Three tasks created in `MKT` get `MKT-1`, `MKT-2`, `MKT-3`. Deleting `MKT-3` and creating another gives `MKT-4`. Two programs number independently
- [x] Ten concurrent creates in one program get ten distinct, gap-free numbers
- [x] `GET …/tasks/mkt-2` and `GET …/tasks/<uuid>` return the same task. `OPS-2` under the `MKT` program → 404
- [x] Create with `assigneeId` of an inactive or unknown employee → 400 `ASSIGNEE_NOT_FOUND`. `dueDate` before `startDate` → 400 `INVALID_DATE_RANGE`, including on PATCH of a single date
- [x] `labels: [" Survey", "survey", "Q4"]` is stored as `["survey", "q4"]`. A label with a space → 400. `GET /programs/:id/labels` returns counts
- [x] `status: "DEPENDENT"` in create or PATCH → 400
- [x] Create B with `dependsOn: [A]` while A is `IN_PROGRESS` → B is `DEPENDENT`, `isDependent: true`, A's detail lists B under `blocks`
- [x] PATCH B `status: IN_PROGRESS` while A is open → 409 `TASK_BLOCKED` with A in `details.blockers`
- [x] A → `DONE`: B goes back to its previous status (for example `ON_HOLD` if it was `ON_HOLD` before), and A gets `completedAt`. A back to `IN_PROGRESS` → B is `DEPENDENT` again, and `completedAt` on A is cleared
- [x] B `DONE`, then A reopened → B stays `DONE`. Reopening B → B becomes `DEPENDENT`, and the requested status is remembered
- [x] Adding a dependency on self → 400 `SELF_DEPENDENCY`. On another program's task → 400 `DEPENDENCY_OTHER_PROGRAM`. Twice → 409 `DEPENDENCY_EXISTS`. A→B then B→A, or A→B→C then C→A → 409 `DEPENDENCY_CYCLE`. The 51st → 400 `DEPENDENCY_LIMIT_REACHED`. An open blocker on a DONE task → 409 `TASK_DONE`
- [x] Removing B's only open blocker → 200, and B's status is restored. Removing a link that doesn't exist → 404
- [x] Deleting blocker A (as its reporter, a MEMBER) → 204, and B leaves `DEPENDENT`. Deleting as a MEMBER who isn't the reporter → 403 `FORBIDDEN`
- [x] List filters: `status=DEPENDENT,ON_HOLD`, `assigneeId=me`, `unassigned=true`, `label=q4`, `dueFrom`/`dueTo`, `q=MKT-2`, `isDependent=true`, `sort=priority&order=desc` (HIGHEST first), pagination meta. `assigneeId` combined with `unassigned` → 400
- [x] Responses never include `taskCounter` or `statusBeforeDependent`
- [ ] Every route returns 401 without a token *(exercised on `GET /programs/:programId` only; every route has `requireAuth` in its router)*
- [x] `npm run typecheck`, `npm run build`, `npm run docs:validate` pass
- [x] Program dates: `startDate`/`endDate` returned on every Program (null when unset). Create with `endDate` before `startDate` → 400 `INVALID_DATE_RANGE`; PATCH of a single date that breaks the stored range → 400 `INVALID_DATE_RANGE`; a malformed date → 400 `Invalid ISO date`; `null` clears either *(checked at the service/validation layer)*

## Testing notes

- Get a token the way spec 03 does (`npm run auth:bootstrap-admin` plus a real or test-signed token), then use Swagger UI at `/docs`.
- For the concurrency check, fire ten `POST …/tasks` requests with `Promise.all` from a small `tsx` script, then check `SELECT number FROM tasks WHERE program_id = … ORDER BY number`.
- To test dependency transitions, create A, B and C, link them with the dependency routes, and flip A's status. Check B and C in the detail responses.

## Verified

On 2026-10-17, against the local DB:

- Migration `0004_create_programs_and_tasks` was generated, reviewed and applied, and `npm run db:check` passes.
- `npm run typecheck`, `npm run build` and `npm run docs:validate` pass. The docs check lists 21 routes, 13 of them new.
- HTTP smoke test on a test server (88/88 pass). It used test employees (ADMIN, MANAGER, two MEMBERs, one inactive) and access tokens signed with the configured secret.
  - **Programs:**
    - role checks on create, patch and delete
    - the key is uppercased; a duplicate key, and the key of a soft-deleted program, return 409
    - a patch that changes `key` returns 400
    - list `q` search works
    - after a soft delete, the program, its task list, task create and labels all return 404
  - **Task fields:**
    - keys are `KEY-1…n`, numbered independently per program and never reused after a delete
    - lookup works by key (case-insensitive) or UUID, and a key or UUID from another program returns 404
    - labels are normalised and deduplicated
    - the assignee and date-range rules apply, including the merged-date check on PATCH
    - `DEPENDENT` and `dependsOn` are rejected on PATCH
  - **Status automation:**
    - blocked on create; restored to the previous status (`ON_HOLD`) when the blocker is done
    - back to `DEPENDENT` when the blocker is reopened; a DONE dependent stays `DONE`
    - reopening a DONE task with an open blocker makes it `DEPENDENT`, and the requested status (`IN_PROGRESS`) comes back once the blocker is done
    - `completedAt` is set and cleared
    - `TASK_BLOCKED` comes with `details.blockers`
  - **Dependency rules:** every error code (unknown, other program, self, exists, 2-cycle and 3-cycle, 50 limit, `TASK_DONE`). Removing a link restores the status.
  - **Delete:** a non-reporter MEMBER gets 403, while the reporter and a MANAGER can delete. A dependent leaves `DEPENDENT` when its blocker is deleted.
  - **List:**
    - every filter: status, priority, `me`, unassigned, `reporterId=me`, label, due range, `q` key and title, literal `%`, `isDependent` true/false
    - the validation errors on bad filter combinations
    - `priority` desc puts `HIGHEST` first, and tasks without a `dueDate` sort last both ways
    - pagination meta
  - **Labels endpoint:** returns the counts.
  - **Concurrency:** 10 concurrent creates in one program got numbers 2 to 11, distinct and gap-free.
- All test rows were removed afterwards.

## Implementation notes

- **Shared helpers:**
  - `likeContains()` (it escapes LIKE wildcards) lives in `program.repository.ts`, and the task repository reuses it.
  - `isUuid()` lives in `task.validation.ts`, and `findByRef` uses it to choose between an id lookup and a key lookup.
- **`loadDetail` runs its three queries one after another.** A transaction holds a single pg client, and running them in parallel triggered pg's "client is already executing a query" deprecation warning.
- **`isDependent` is an `EXISTS` on `task_dependencies`.** It doesn't join `tasks`, because links are deleted together with their task.
- **Docs:**
  - There's no shared `NotFound` response in `registry.ts`. Only the task docs needed the multi-example 404, so it's defined there. `programNotFoundResponse` is exported from `program.docs.ts`.
  - The labels response schema is registered as `ProgramLabelsResponse`.
- **400 body shape.** A 400 from Zod uses the `ValidationErrorResponse` shape, and a 400 with a business `code` uses `ErrorResponse`. Task docs show both shapes under one 400 (`oneOf`/`anyOf` of the two schemas, with named examples).

## Out of scope / follow-ups

- **Program richness:**
  - owner, members and per-program roles/permissions
  - program dates
  - status transition rules
  - restoring soft-deleted programs or tasks
  - renaming a program key (key history)
- **Jira features not built:**
  - issue types (story, bug, epic), sub-tasks and parent/child links
  - other link types (relates to, duplicates)
  - comments, attachments, watchers
  - an activity/history log
  - worklogs and time spent/remaining
  - sprints and boards (and board ordering/rank)
  - workflow transitions per program
- Jira-style estimate strings (`2h 30m`). The API takes minutes only
- A global `GET /tasks/:key` lookup and a cross-program "my tasks" view (`GET /tasks?assigneeId=me`)
- Bulk updates. Optimistic concurrency (ETag / `If-Match`)
- Notifications on assignment or when a task becomes unblocked
- The program-owned research entities (reports, insights, docs, findings). Like tasks, they'll get a `program_id` FK, and nothing here needs to change
- Automated tests (there's still no test runner)
