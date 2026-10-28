# 10 — Boards (task containers, global task URLs, report scope)

**Status:** Done
**Branch:** `middleware`
**Depends on:** [04-program-tasks](./04-program-tasks.md) (tasks, keys, dependencies, `DEPENDENT`, labels), [05-comments](./05-comments.md) (threads, replies, mentions), [07-task-types](./07-task-types.md) (`TaskType`), [09-overview-report](./09-overview-report.md) (`GET /reports/overview`), [03-login](./03-login.md) (`requireAuth`, `requireRole`, `authNote`)

## Goal

The frontend wants a second home for tasks next to programs, and one URL per task. Source: the frontend team's proposal (formerly `10-boards-backend-prompt.md`). Where this spec differs from it is listed at the end.

1. **Boards.** A board is a lightweight container of tasks: a key, a name (the "topic") and an optional description. It has no status, dates, owner team or board-level comments. It never closes. It can only be soft-deleted, which hides the board itself: **its tasks stay live**, can still be fetched and edited by key or id, and still count in the overview report.
2. **Every task has exactly one parent**, a program or a board, set at creation and never changed. Board tasks behave exactly like program tasks: same fields, status rules (`DEPENDENT`, `TASK_BLOCKED`), dependencies (within the same board), delete rules, labels and comments (threads, replies, @mentions).
3. **One global task URL.** `/tasks/{taskRef}` (UUID or key, case-insensitive) serves every task, whatever its parent: get, update, delete, dependencies and comments. The `/programs/{programId}/tasks/...` routes keep working unchanged.
4. **Global task numbers.** Every new task, in any program or board, takes the next number from one sequence. `key = <parent key>-<number>`, so a program `PRO` and a board `PRO` can coexist and every key is still unique across FlowDesk.
5. **Created-date filter** (`createdFrom`, `createdTo`) on both task lists, for the board page's "created in the last 7 / 30 days".
6. **Report scope.** `GET /reports/overview?scope=all|programs|boards`, with a new `boards[]` breakdown.

## Flow

```
Client                                        FlowDesk API                                     PostgreSQL
  │ POST /boards { key: "pro", name }           │ requireAuth, requireRole(ADMIN, MANAGER)        │
  │────────────────────────────────────────────▶│ key taken by a board (incl. deleted)? → 409     │
  │◀──────── 201 { data: Board PRO } ───────────│ INSERT boards                                   │
  │                                             │                                                 │
  │ POST /boards/{id}/tasks { title, … }        │ BEGIN                                           │
  │────────────────────────────────────────────▶│ 1. SELECT boards … FOR UPDATE (active, else 404)│
  │                                             │ 2. nextval('task_number_seq') → 50              │
  │                                             │ 3. checks, INSERT task PRO-50 (board_id set)    │
  │                                             │ 4. dependency links, syncDependentStatus        │
  │◀──────── 201 { data: TaskDetail PRO-50 } ───│ COMMIT                                          │
  │                                             │                                                 │
  │ GET /tasks/pro-50                           │ task by key, active; program task → program     │
  │────────────────────────────────────────────▶│   must be active; board task → board may be     │
  │◀──────── 200 { data: TaskDetail } ──────────│   deleted                                       │
  │                                             │                                                 │
  │ PATCH /tasks/PRO-50 { status: "DONE" }      │ BEGIN; find task; lock its parent row           │
  │────────────────────────────────────────────▶│ (program FOR UPDATE, or board FOR UPDATE even   │
  │◀──────── 200 { data: TaskDetail } ──────────│ if deleted); re-read task; status rules; COMMIT │
```

Writes that can change the dependency graph or a task's DONE-ness still serialise on one row per parent. The row is the program for program tasks and the board for board tasks. A deleted board's row is still locked, because its tasks are still writable. The global number comes from a Postgres sequence, not a counter row, so creates in different parents don't wait on each other.

> **Why a sequence and not a counter row.** A single counter row would serialise every task create in the organisation. A sequence doesn't, but a create that rolls back leaves a gap in the numbers. Gaps are harmless: with a global counter, each parent's numbers are already sparse (PRO-1…PRO-49, then PRO-73). Numbers are still never reused.

## Environment variables

None new.

## Packages

None new. Drizzle's `pgSequence` (drizzle-orm 0.45, drizzle-kit 0.31, both installed) declares the sequence.

## Folder layout (new and changed)

```
src/
  db/schema/
    boards.ts                         NEW      boards table
    index.ts                          CHANGED  export boards
    tasks.ts                          CHANGED  board_id, nullable program_id, single-parent CHECK, task_number_seq,
                                               board indexes; task_dependencies.board_id
    comments.ts                       CHANGED  comments.board_id, comment_mentions.board_id, nullable program_id, CHECKs
    programs.ts                       CHANGED  task_counter dropped
  modules/boards/                     NEW
    board.routes.ts                   GET/POST /, GET/PATCH/DELETE /:boardId, GET /:boardId/labels
    board.controller.ts               Zod parse → service → { data }
    board.validation.ts               createBoardSchema, updateBoardSchema, listBoardsQuerySchema, boardIdParamSchema
    board.repository.ts               createRepository(boards) + findByKey, searchWhere, lockForUpdate
    board.service.ts                  createBoard, listBoards, getActiveBoard, updateBoard, deleteBoard
    board.dto.ts                      toBoardDto
    board.docs.ts                     Board schemas + the six /boards routes
  modules/tasks/
    task.parent.ts                    NEW      TaskParent type and helpers (programParent, boardParent, parentOf, sameParent, parentWhere)
    task.routes.ts                    CHANGED  + boardTaskRouter (/boards/:boardId/tasks), taskByRefRouter (/tasks)
    task.controller.ts                CHANGED  handlers for the new routers
    task.service.ts                   CHANGED  parent-aware create/list/labels; TaskLocator for single-task ops;
                                               lockParent(); DEPENDENCY_OTHER_PARENT
    task.repository.ts                CHANGED  joins programs/boards for `parent`, findByRef(parent, …),
                                               findReachableByRef, nextNumber, createdFrom/createdTo
    task.validation.ts                CHANGED  createdFrom/createdTo, taskRefOnlyParamSchema, taskRefDependencyParamSchema,
                                               TaskLocator + parseTaskLocator/parseTaskParent, TaskType text,
                                               parent fields rejected on PATCH
    task.dto.ts                       CHANGED  programId nullable, boardId, parent
    task.dependencyStatus.ts          CHANGED  comment only ("parent row locked")
    task.docs.ts                      CHANGED  Task/TaskParent schemas, board-task routes, /tasks/{taskRef} routes
  modules/comments/
    comment.routes.ts                 CHANGED  + taskRefCommentRouter (/tasks/:taskRef/comments)
    comment.controller.ts             CHANGED  handlers for it
    comment.service.ts                CHANGED  parent-aware targets; *ByTaskRef functions
    comment.repository.ts             CHANGED  CommentTarget with boardId; findReachable(scope, …)
    commentMention.repository.ts      CHANGED  replaceForComment(parent, …)
    comment.validation.ts             CHANGED  taskCommentIdParamSchema
    comment.dto.ts                    CHANGED  programId nullable, boardId
    comment.docs.ts                   CHANGED  five /tasks/{taskRef}/comments routes, boardId on Comment
  modules/programs/
    program.repository.ts             CHANGED  nextTaskNumber removed
    program.validation.ts             CHANGED  key rule exported as containerKeySchema (shared with boards)
    program.dto.ts / program.docs.ts  CHANGED  task_counter comments removed
    program.controller.ts             CHANGED  listLabels passes the program parent
  modules/reports/
    report.validation.ts              CHANGED  scope
    report.repository.ts              CHANGED  scope-aware task queries, boardRows, overdue count per priority
    report.service.ts                 CHANGED  scope, boards[], open/overdue totals from SQL
    report.docs.ts                    CHANGED  scope, BoardReportRow, per-scope field descriptions
    report.service.test.ts            CHANGED  board fixtures, scope tests
  app.ts                              CHANGED  four routeModules entries
  docs/openapi.ts                     CHANGED  import board.docs, "Boards" tag
  docs/registry.ts                    CHANGED  BOARD_KEY_EXISTS, DEPENDENCY_OTHER_PARENT (DEPENDENCY_OTHER_PROGRAM removed)
drizzle/0010_add_boards_and_global_task_numbers.sql   NEW (generated, then hand-edited)
.claude/CLAUDE.md                     CHANGED  Board in the domain model, parents, numbering, locking rule, spec 10
.claude/specs/04, 05, 07, 09          CHANGED  pointers to this spec where their rules changed
```

Request flow as everywhere else: **route → requireAuth (→ requireRole) → controller (Zod) → service → repository → Drizzle**. Board routes follow the program module file for file. Task and comment services gain a parent abstraction instead of a parallel copy of every function.

## Schema

### `boards` table (new)

| Column | Type | Constraints |
| --- | --- | --- |
| `id`, `created_at`, `updated_at`, `is_active` | `baseColumns()` | `is_active = false` means deleted |
| `key` | `varchar(10)` | not null, unique `boards_key_unique` (soft-deleted boards included). Uppercase, 2-10 letters or digits, starting with a letter. Immutable. May equal a program key |
| `name` | `varchar(150)` | not null |
| `description` | `text` | nullable, at most 10,000 characters (API rule) |

No other columns. The list is ordered by `created_at`, and boards number in the tens to hundreds, so there's no extra index.

### `tasks` (changed)

| Column | Change |
| --- | --- |
| `program_id` | now **nullable** |
| `board_id` | **new**, `uuid` nullable, FK `boards.id` |
| `number` | values now come from `task_number_seq` (see below) |

- `CHECK (num_nonnulls(program_id, board_id) = 1)` (`tasks_single_parent_check`): exactly one parent.
- `unique tasks_board_number_unique (board_id, number)`, mirroring the existing `tasks_program_number_unique`. Both are kept. A single global unique on `number` isn't possible, because tasks created before this spec repeat numbers across programs (MKT-1 and FIN-1).
- `index tasks_board_status_idx (board_id, status)` for board task lists, mirroring `tasks_program_status_idx`.
- `tasks_key_unique` already makes keys unique across FlowDesk. With global numbers, a new key can never collide: its number is above every existing number.

**Sequence `task_number_seq`** (`pgSequence` in `tasks.ts`). New tasks take `nextval('task_number_seq')`. The migration starts it at `max(tasks.number) + 1`, so existing keys don't change and the next task, in any parent, continues from the highest number.

### `programs` (changed)

`task_counter` is **dropped** with `programRepository.nextTaskNumber`, because nothing reads it any more. It was internal and never returned.

### `task_dependencies` (changed)

`program_id` becomes nullable, and `board_id` (FK `boards.id`, nullable) is added. `CHECK (num_nonnulls(program_id, board_id) = 1)` (`task_dependencies_single_parent_check`). A link carries its tasks' parent. Both tasks always have the same parent (service rule).

### `comments` (changed)

`program_id` becomes nullable, and `board_id` (FK `boards.id`, nullable) is added. New checks:
- `comments_single_parent_check`: `num_nonnulls(program_id, board_id) = 1`
- `comments_board_task_check`: `board_id IS NULL OR task_id IS NOT NULL`. Boards have no board-level comments, so a board comment is always on one of its tasks.

### `comment_mentions` (changed)

`program_id` becomes nullable, and `board_id` (FK `boards.id`, nullable) is added. `comment_mentions_single_parent_check`: `num_nonnulls(program_id, board_id) = 1`. Mention rows copy their comment's parent.

> Every row that belongs to a parent keeps a direct FK to it, as CLAUDE.md requires ("every program-owned table has a `programId`"). Board-owned rows get `boardId` the same way, so later per-parent queries don't need to go through `tasks`.

### Migration

`npm run db:generate -- --name add_boards_and_global_task_numbers`, then hand-add, right after the generated `CREATE SEQUENCE`:

```sql
SELECT setval('task_number_seq', coalesce((SELECT max("number") FROM "tasks"), 0) + 1, false);
```

The checks can be added without a backfill, because every existing row has `program_id` set and `board_id` null. `npm run db:migrate`, then `npm run db:check`.

## Domain rules

### Parents

- A task's parent is set at creation: `POST /programs/{programId}/tasks` or `POST /boards/{boardId}/tasks`. It never changes. PATCH rejects `programId` / `boardId` (400, "A task's parent can't be changed").
- The task key is `<parent key>-<number>`, using the program's key or the board's key.
- **Dependencies only within the same parent.** The blocker must have the same `program_id` and the same `board_id` as the task, else **400 `DEPENDENCY_OTHER_PARENT`**, "Task OPS-2 belongs to another program or board". This replaces `DEPENDENCY_OTHER_PROGRAM` on every route, program routes included. All other dependency rules and codes are unchanged.
- **Locking.** Any write that can change dependencies or DONE-ness locks the parent row first, inside the transaction:
  - program tasks: `programRepository.lockForUpdate` (an active program, else 404)
  - board tasks: `boardRepository.lockForUpdate(id, { includeInactive: true })`, because a deleted board's tasks stay writable
  - create: lock the **active** parent (deleted → 404), then `taskRepository.nextNumber()`
- `syncDependentStatus()` stays the only code that sets or clears `DEPENDENT`.

### Board lifecycle

```
POST /boards ─▶ active ──DELETE /boards/{id} (ADMIN)──▶ deleted (is_active = false)
                                                        no restore yet; the key stays taken
```

| After a board is deleted | Result |
| --- | --- |
| `GET/PATCH/DELETE /boards/{id}`, `GET /boards/{id}/labels` | 404 `Board not found` |
| `GET/POST /boards/{id}/tasks` | 404 `Board not found` |
| `GET /boards` | not listed |
| Its tasks through `/tasks/{taskRef}` (get, patch, status, delete, dependencies, comments) | **work as before** |
| Its tasks in `GET /reports/overview` | **still counted** (totals, breakdowns, trend), but the board has no `boards[]` row |
| A new board with the same key | 409 `BOARD_KEY_EXISTS` |
| The task's `parent` | still filled in, with `parent.isActive: false` |

Program soft-delete is **unchanged**. Every route under a deleted program returns 404, and its tasks are 404 on `/tasks/{taskRef}` as well.

### Reachable task (for `/tasks/{taskRef}`)

`taskRef` is a task UUID, or a key such as `PRO-50` (case-insensitive). The task is found when:
1. it exists and `is_active`, and
2. its program is active (program tasks). Board tasks have no board condition.

Anything else → **404 `Task not found`**. The message is the same for a deleted program's task, so a stale link doesn't reveal why.

The program-nested routes still look the task up **within that program** (`findByRef(parent, ref)`). A board task's key or UUID under `/programs/{programId}/tasks/...` is 404 `Task not found`.

### Comments on tasks via `/tasks/{taskRef}/comments`

Same rules and codes as spec 05:
- Resolve the reachable task (404 `Task not found`).
- List: that task's threads. Create: on that task.
- A reply's parent is looked up within the task's program or board, so the codes are the same as on the program routes: a parent on another task → 400 `PARENT_TARGET_MISMATCH`; a missing parent, or one in another program or board → 400 `PARENT_COMMENT_NOT_FOUND`; a reply as the parent → 400 `NESTED_REPLY`.
- Get / edit / delete by `commentId`: the comment must be active and on **this task**, else 404 `Comment not found`. Edit is the author only (403 `FORBIDDEN`). Delete is the author, MANAGER or ADMIN (403 `FORBIDDEN`).
- `/programs/{programId}/comments/{commentId}` still gets, edits and deletes **program-task** comments. Board-task comments are reachable only through `/tasks/{taskRef}/comments/{commentId}`.

## API

### `Board` (new)

```jsonc
{
  "id": "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f",
  "createdAt": "2026-10-28T09:00:00.000Z", "updatedAt": "2026-10-28T09:00:00.000Z", "isActive": true,
  "key": "PRO", "name": "Product feedback", "description": "Ideas and bugs from the field"
}
```

### `Task` / `TaskDetail` (changed)

- `programId`: `uuid | null`. **New** `boardId`: `uuid | null`. Exactly one of them is set.
- **New** `parent`: `{ type: "PROGRAM" | "BOARD", id, key, name, isActive }` (schema `TaskParent`). `isActive` is false only for a deleted board, which lets the frontend skip linking to a board page that would return 404.
- `number`: "Global sequence number shared by every task in FlowDesk (programs and boards). It increases with each new task and is never reused; there can be gaps. Tasks created before boards existed keep their per-program numbers."
- `key`: "`<program or board key>-<number>`, e.g. PRO-50. Unique across FlowDesk and never reused."

### `Comment` (changed)

`programId` becomes `uuid | null`, and **new** `boardId` is `uuid | null`. Exactly one is set: `boardId` for comments on board tasks.

### `TaskType` description (changed, enum unchanged)

"PRE: prerequisite work before the main work starts. TASK: the main work (default). POST: follow-up work after the main work is done. BUG: something broken to fix. ISSUE: a problem, risk or question to resolve. The type is informational: it doesn't affect status, dependencies or the parent's status. Sort order is PRE < TASK < POST < BUG < ISSUE."

### `GET /boards` — list boards (new)
**Auth:** any active employee.
Query (`listBoardsQuerySchema`): `q` (trimmed, 1-100; case-insensitive substring of name or key), `limit` (1-100, default 20), `offset` (≥ 0, default 0).
Active boards, newest first (`createdAt` desc).
Responses: `200 { data: Board[], meta }` · `400 Validation failed` (bad `q`/`limit`/`offset`) · `401` · `500`.

### `POST /boards` — create a board (new)
**Auth:** ADMIN or MANAGER (`requireRole`).
Body (`createBoardSchema`):
- `key`: trimmed, uppercased, then `/^[A-Z][A-Z0-9]{1,9}$/` ("Key must be 2-10 letters or digits, starting with a letter"). This is the same rule as programs (the shared `containerKeySchema`).
- `name`: trimmed, 1-150.
- `description`: ≤ 10,000, nullable, optional.

Unknown keys are stripped, as on `POST /programs`.

Rules: the key must not belong to another board, active or deleted (`findByKey(key, { includeInactive: true })`). Losing a race with a concurrent create (`PG_UNIQUE_VIOLATION`) gets the same answer. Either way → **409 `BOARD_KEY_EXISTS`**, "Board key PRO is already taken". Program keys aren't checked.
Responses: `201 { data: Board }` · `400 Validation failed` · `401` · `403 FORBIDDEN` · `409 BOARD_KEY_EXISTS` · `500`.

### `GET /boards/{boardId}` — get a board (new)
**Auth:** any active employee.
Responses: `200 { data: Board }` · `400` (`boardId` not a UUID) · `401` · `404 Board not found` (unknown or deleted) · `500`.

### `PATCH /boards/{boardId}` — update a board (new)
**Auth:** ADMIN or MANAGER.
Body (`updateBoardSchema`, strict): `name?`, `description?` (null clears it). At least one field is required ("At least one field is required"). Sending `key` → 400 "Board key cannot be changed", and any other unknown key → 400.
Responses: `200 { data: Board }` · `400` · `401` · `403` · `404` · `500`.

### `DELETE /boards/{boardId}` — soft-delete a board (new)
**Auth:** ADMIN.
Sets `is_active = false`. Its tasks are **not** deleted: see "Board lifecycle". The key stays taken.
Responses: `204` · `400` · `401` · `403` · `404` · `500`.

### `GET /boards/{boardId}/labels` — labels used on a board (new)
**Auth:** any active employee. Same as `GET /programs/{programId}/labels`: distinct labels on the board's active tasks with `taskCount`, ordered by `taskCount` desc, then `label`.
Responses: `200 { data: [{ label, taskCount }] }` · `400` · `401` · `404 Board not found` · `500`.

### `GET /boards/{boardId}/tasks` — list a board's tasks (new)
**Auth:** any active employee. The same query (`listTasksQuerySchema`), sorting, paging and `TaskListResponse` as `GET /programs/{programId}/tasks`, including `createdFrom` / `createdTo`.
Responses: `200 { data: Task[], meta }` · `400 Validation failed` · `401` · `404 Board not found` · `500`.

### `POST /boards/{boardId}/tasks` — create a board task (new)
**Auth:** any active employee. Body `CreateTaskRequest`. The rules are the program route's, in the same order: an active board (404) → `ASSIGNEE_NOT_FOUND` → `INVALID_DATE_RANGE` → each `dependsOn`: `DEPENDENCY_TASK_NOT_FOUND` / `DEPENDENCY_OTHER_PARENT` → `TASK_BLOCKED` for `status: DONE` with an open blocker.
Responses: `201 { data: TaskDetail }` · `400` · `401` · `404 Board not found` · `409 TASK_BLOCKED` · `500`.

### `createdFrom` / `createdTo` (new query params, both task lists)
`YYYY-MM-DD` (`z.iso.date()`), compared with the UTC date of `createdAt`, both ends inclusive. Implemented as `created_at >= createdFrom 00:00Z` and `created_at < createdTo + 1 day 00:00Z`, so `tasks_created_at_idx` can be used. `createdFrom` after `createdTo` → **400 `Validation failed`**, path `createdTo`, "createdTo must be on or after createdFrom". That matches how `dueFrom` / `dueTo` already behave.

### Single-task routes by `taskRef` (new)

Each one behaves exactly like its `/programs/{programId}/tasks/{taskRef}…` counterpart: same body, rules, roles, response codes and examples. The only differences are how the task is found (see "Reachable task") and that every 404 is `Task not found` (or `Dependency not found` / `Comment not found`, as below). `taskRef` is validated as a UUID or a key (`/^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/`), else 400.

| Route | Auth | Success | Errors |
| --- | --- | --- | --- |
| `GET /tasks/{taskRef}` | any | `200 TaskDetail` | 400, 401, 404 |
| `PATCH /tasks/{taskRef}` | any | `200 TaskDetail` | 400 (incl. parent fields, `ASSIGNEE_NOT_FOUND`, `INVALID_DATE_RANGE`), 401, 404, 409 `TASK_BLOCKED` |
| `DELETE /tasks/{taskRef}` | ADMIN, MANAGER or the reporter (service) | `204` | 400, 401, 403 `FORBIDDEN`, 404 |
| `POST /tasks/{taskRef}/dependencies` | any | `201 TaskDetail` | 400 (`DEPENDENCY_TASK_NOT_FOUND`, `DEPENDENCY_OTHER_PARENT`, `SELF_DEPENDENCY`, `DEPENDENCY_LIMIT_REACHED`), 401, 404, 409 (`DEPENDENCY_EXISTS`, `DEPENDENCY_CYCLE`, `TASK_DONE`) |
| `DELETE /tasks/{taskRef}/dependencies/{dependsOnTaskId}` | any | `200 TaskDetail` | 400, 401, 404 (task, or `Dependency not found`) |
| `GET /tasks/{taskRef}/comments` | any | `200 Comment[] + meta` | 400, 401, 404 |
| `POST /tasks/{taskRef}/comments` | any | `201 Comment` | 400 (validation, `PARENT_COMMENT_NOT_FOUND`, `PARENT_TARGET_MISMATCH`, `NESTED_REPLY`, `TOO_MANY_MENTIONS`, `MENTION_NOT_FOUND`), 401, 404 |
| `GET /tasks/{taskRef}/comments/{commentId}` | any | `200 Comment` | 400, 401, 404 (task or comment) |
| `PATCH /tasks/{taskRef}/comments/{commentId}` | author only (service) | `200 Comment` | 400 (validation, mention codes), 401, 403 `FORBIDDEN`, 404 |
| `DELETE /tasks/{taskRef}/comments/{commentId}` | author, MANAGER or ADMIN (service) | `204` | 400, 401, 403 `FORBIDDEN`, 404 |

Every row can also return `500`.

### `GET /reports/overview` (changed)

New query param **`scope`**: `all` (default), `programs` or `boards`. Anything else → 400 `Validation failed` on path `scope`.

**Which tasks are in scope:**

| Term | Definition |
| --- | --- |
| Live program task | `program_id` set, task active, program active (as today) |
| Live board task | `board_id` set, task active. **The board's state is ignored**, so a deleted board's tasks still count |
| Event counts (`tasksCreated*`, `tasksCompleted*`, `tasksCompletedWithDueDate`, `tasksCompletedOnTime`, `trend`) | live tasks in scope: `programs` → live program tasks, `boards` → live board tasks, `all` → both |
| Snapshot counts (`openTasks`, `overdueTasks`, `openTasksByPriority`) | program tasks of **in-scope programs** (spec 09's rule) plus live board tasks, limited by `scope` |
| `tasksByStatus` | the snapshot set, further limited per task to "created before the period ended, and open or completed on/after `from`" (spec 09), for both kinds of task |

Boards have no status or end date and never finish, so their tasks are never excluded by a board-level period rule.

**Program-only fields** (`totals.programs`, `totals.programsCompleted`, `totals.programsAtRisk`, `programsByStatus`, `teams`, `programs`) always cover programs only. They're identical under `all` and `programs`. Under `scope=boards` they're **zero / empty** (`programsByStatus` has every key at 0, and `teams` and `programs` are `[]`), so the response shape never changes. `teams[]` stays per owner team: board tasks never appear in it.

**New `boards[]`** (schema `BoardReportRow`): one row per **active** board with at least one live task, unpaginated:

```jsonc
{ "id": "…", "key": "PRO", "name": "Product feedback",
  "tasksTotal": 12, "tasksDone": 5, "tasksCompletedInPeriod": 4, "openTasks": 7, "overdueTasks": 2 }
```

The fields mean the same as on `programs[]` rows. Order: `overdueTasks` desc, then `name` (ignoring case), then `id`. Empty under `scope=programs`. A deleted board has no row, but its tasks are still in the totals.

**What adds up:**
- `totals.openTasks = sum(openTasksByPriority)`, in every scope.
- `totals.openTasks = sum(programs[].openTasks) + sum(boards[].openTasks) + open tasks on deleted boards`. The same holds for `overdueTasks`. The last term is the only reason the rows can add up to less than the totals.
- `sum(teams[].openTasks) = sum(programs[].openTasks)`.
- `trend` still sums to `tasksCreated` / `tasksCompleted`.
- `totals.openTasks` and `overdueTasks` are now counted in SQL (summed from the `openTasksByPriority` query, which also counts overdue tasks per priority), not summed from `programs[]`, because deleted boards' tasks have no row.

Responses: as spec 09, with the `scope` 400.

## Implementation outline

- **`task.parent.ts`**: `type TaskParent = { programId: string; boardId: null } | { programId: null; boardId: string }`. Helpers:
  - `programParent(id)` / `boardParent(id)`
  - `parentOf(task)`, which reads the parent columns off a task or comment row
  - `parentWhere(table, parent)`, which builds `eq(program_id) / eq(board_id)` for `tasks`, `task_dependencies` and `comments`
- **`task.repository.ts`**:
  - `selectViews` left-joins `programs` and `boards` and returns `parent`.
  - `findByRef(parent, ref)` is the nested lookup. `findReachableByRef(ref)` is the global one: active task, and `board_id is not null or programs.is_active`.
  - `listViews(parent, filters)`, `labelStats(parent)`.
  - `nextNumber()` runs `select nextval('task_number_seq')::int`.
- **`task.service.ts`**:
  - `type TaskLocator = { programId: string; taskRef: string } | { taskRef: string }`, declared in `task.validation.ts` next to `parseTaskLocator(params)`. The same controller handlers serve both mounts, and the presence of `:programId` picks the lookup.
  - `getActiveTask(locator)` does the lookup and the 404.
  - `lockAndFind(tx, locator)` finds the task, locks the parent (`lockParent`), then re-reads the task by id after the lock.
  - `getTask`, `updateTask`, `deleteTask`, `addDependency` and `removeDependency` take a locator.
  - `createTask(parent, …)`, `listTasks(parent, …)` and `listLabels(parent)` check the active parent first (`getActiveProgram` / `getActiveBoard`).
- **`comment.repository.ts`**:
  - `CommentTarget = TaskParent & { taskId: string | null }`.
  - `findReachable(scope, commentId, lock?)` with `scope = { programId } | { boardId } | { taskId }`. The comment must be active, and its task, if any, must be active.
- **`comment.service.ts`**: the existing program-route functions build the target from `programId`. New `listTaskCommentsByRef`, `createTaskCommentByRef`, `getTaskComment`, `updateTaskComment` and `deleteTaskComment` resolve `getActiveTask({ taskRef })`. Edit and delete share `findForWrite(tx, scope, commentId)` with the program routes.
- **`app.ts`** `routeModules`, most specific first:

```ts
{ basePath: "/tasks/:taskRef/comments", router: taskRefCommentRouter },
{ basePath: "/tasks", router: taskByRefRouter },
{ basePath: "/boards/:boardId/tasks", router: boardTaskRouter },
{ basePath: "/boards", router: boardRouter },
// …existing /programs entries unchanged
```

- **Reports**:
  - `report.repository.ts` left-joins `programs` on `tasks.program_id`. `eventTasks(scope)` and `snapshotTasks(scope, period)` (both built on `liveTasksIn`) are the per-scope conditions above, and every task query takes `scope`.
  - `boardRows(period, asOf)` inner-joins active boards to live tasks.
  - `openTasksByPriority(period, asOf, scope)` also returns an `overdue` count per priority. Their sums are `totals.openTasks` / `overdueTasks`.
  - The service skips `programRows` under `boards` and `boardRows` under `programs`.

## Error classes (`src/lib/errors.ts`)

No new classes.
- `ConflictError`, `BOARD_KEY_EXISTS` (new).
- `BadRequestError`, `DEPENDENCY_OTHER_PARENT` (new; replaces `DEPENDENCY_OTHER_PROGRAM`).
- `NotFoundError` "Board not found" (no code, like "Program not found").

In `src/docs/registry.ts`, add `BOARD_KEY_EXISTS` and `DEPENDENCY_OTHER_PARENT` to `ErrorResponse.code` and remove `DEPENDENCY_OTHER_PROGRAM`.

## API documentation

- `board.docs.ts`:
  - Registers `Board`, `BoardResponse`, `BoardListResponse` and `BoardLabelsResponse`, plus the six `/boards` operations with auth/roles (`authNote`), every status, error examples (validation, `BOARD_KEY_EXISTS`, key change, empty body), and request and response examples.
  - Exports `boardNotFoundResponse`.
  - The DELETE description spells out that the tasks stay live and count in the report.
- `task.docs.ts`:
  - `TaskParent`, `boardId`, nullable `programId`, and the new `number`/`key` descriptions on `Task`/`TaskDetail`.
  - The two `/boards/{boardId}/tasks` operations.
  - The five `/tasks/{taskRef}` operations, registered through a helper shared with the program routes so the descriptions don't drift.
  - `DEPENDENCY_OTHER_PARENT` in every example and description.
  - `createdFrom`/`createdTo` (from the Zod schema).
- `comment.docs.ts`: `boardId` and nullable `programId` on `Comment`/`CommentReply`, and the five `/tasks/{taskRef}/comments` operations.
- `report.docs.ts`:
  - `scope` (from the Zod schema), `BoardReportRow` and `boards[]`.
  - Per-field descriptions that say what each number covers per scope, and that program-only fields are 0/empty under `boards`.
  - Updated "two task scopes" and "what adds up" text.
- `openapi.ts`: import `board.docs`; a "Boards" tag ("Lightweight task containers that never close; their tasks behave like program tasks"); update the "Tasks" tag ("Jira-style tasks in a program or a board, including dependencies").
- `npm run docs:validate` must pass and list **56 routes** (38 + 6 board + 2 board-task + 5 task-by-ref + 5 task-comment-by-ref).

## Differences from the frontend proposal

1. **Deleting a board hides only the board.** Its tasks and their comments stay reachable and writable through `/tasks/{taskRef}`, and still count in the overview report. The proposal had them answer 404. `GET /tasks/{taskRef}` therefore 404s for a deleted **program**'s task, but not for a deleted board's.
2. **Added:**
   - a `parent` summary (`type`, `id`, `key`, `name`, `isActive`) on `Task`/`TaskDetail`
   - `GET /boards/{boardId}/labels`
   - `GET /tasks/{taskRef}/comments/{commentId}`
   - `q` search on `GET /boards`
3. **`DEPENDENCY_OTHER_PARENT` replaces `DEPENDENCY_OTHER_PROGRAM` everywhere**, including on the program routes. Clients matching the old code must switch.
4. **Report:**
   - `boards[]` rows use `id` (like `programs[]`), not `boardId`.
   - Only active boards with at least one live task get a row.
   - Under `scope=boards`, program-only fields are present as zero/empty, not omitted.
5. `createdFrom > createdTo` is a `Validation failed` 400 on path `createdTo` (no `code`), the same as `dueFrom`/`dueTo`.
6. Global numbers come from a sequence, so a failed create can leave a gap. Numbers are still never reused.
7. PATCH with `programId` or `boardId` is a 400 with "A task's parent can't be changed". The proposal didn't specify the message.

## Acceptance checklist

- [x] Migration generated and hand-edited, applied, `npm run db:check` passes. The sequence's next value is max(number) + 1, and existing task keys are unchanged
- [x] `POST /boards` as MEMBER → 403. Bad key → 400. A duplicate key (including a soft-deleted board's) → 409 `BOARD_KEY_EXISTS`. A key equal to a program's key → 201
- [x] `GET /boards` lists active boards newest first, with `q` on name/key. `GET /boards/{id}` for an unknown or deleted board → 404
- [x] `PATCH /boards/{id}` with `key` → 400 "Board key cannot be changed". Empty body → 400. MEMBER → 403
- [x] `DELETE /boards/{id}` as a non-ADMIN → 403 (checked with a MEMBER; the same `requireRole("ADMIN")` covers MANAGER); as ADMIN → 204. Then `GET /boards/{id}`, its tasks list, its labels and creating a task in it → 404
- [x] After a board is deleted, `GET`/`PATCH`/`DELETE /tasks/{key}`, adding/removing dependencies and comment create/list/get/edit/delete on its tasks still work. `parent.isActive` is false
- [x] Program `PRO` and board `PRO`: their next tasks take consecutive global numbers (e.g. PRO-50, PRO-51), and each task's key resolves to the right task via `/tasks/{key}` (case-insensitive) and via its UUID
- [x] A board task under `/programs/{id}/tasks/{ref}` → 404. A soft-deleted program's task on `/tasks/{ref}` → 404
- [x] Board task statuses: a blocker makes the task `DEPENDENT`; changing the status of a `DEPENDENT` task → 409 `TASK_BLOCKED`; finishing the blocker restores the status
- [x] A cross-parent dependency (board task → program task, and program A → program B) → 400 `DEPENDENCY_OTHER_PARENT`. Cycle, self and duplicate codes are unchanged (the limit check is the same code path as before and wasn't re-run)
- [x] `PATCH /tasks/{ref}` with `boardId` or `programId` → 400
- [x] `DELETE /tasks/{ref}` as a MEMBER who isn't the reporter → 403; as the reporter → 204
- [x] Comment via `/tasks/{ref}/comments` with a mention → `comment_mentions` row with `board_id`. A reply to a comment on another task of the same board → 400 `PARENT_TARGET_MISMATCH`. A comment id from another task → 404. Editing someone else's comment → 403
- [x] `createdFrom`/`createdTo` filter both lists (inclusive, UTC). `createdFrom > createdTo` → 400 on `createdTo`
- [x] Report: `scope` defaults to `all`; an invalid scope → 400. `programs` excludes board tasks and gives `boards: []`. `boards` gives zero/empty program fields. A deleted board's tasks count in totals with no row. `boards[]` order is overdue desc, then name. The "what adds up" identities hold
- [x] Responses never include `taskCounter` or `statusBeforeDependent`
- [x] `npm test`, `npm run typecheck`, `npm run build`, `npm run docs:validate` (56 routes) pass

## Testing notes

- `report.service.test.ts`: the fixture also hides existing board tasks and boards inside its transaction (`UPDATE tasks SET is_active = false WHERE board_id IS NOT NULL`, `UPDATE boards SET is_active = false`), and gains `board(values?)` and `task(parent, values?)`. New tests cover each `scope`, `boards[]` rows and order, a deleted board's tasks, and the identities above.
- Task, board and comment behaviour is checked over HTTP, against an in-process server with an ADMIN token and a MEMBER token, as in spec 09. Rows created by the smoke run are hard-deleted afterwards. The sequence values it used are not given back, which is harmless.

## Verified

On 2026-10-28, against the local DB:
- Migration `0010` applied and `db:check` passes. Before it, the highest task number was 4. Afterwards `task_number_seq` had `last_value 5, is_called false`, so the next task is number 5, and the five existing keys (DCP-1, FFG-1…FFG-4) were unchanged.
- `npm test`: 24 tests pass, the 20 existing ones plus 4 new scope tests (`all`/`programs`/`boards`, and board row order). Making `scope=programs` include board tasks in the repository makes the `programs` test fail, so the tests do catch scope regressions.
- `npm run typecheck`, `npm run build` and `npm run docs:validate` (spec valid, **56 routes** documented) pass.
- HTTP smoke test against an in-process server with ADMIN and MEMBER tokens: **90 checks, 0 failures**. They cover every checklist line above, including a program and a board with the same key taking consecutive numbers, `/tasks/{key}` for both, everything on a deleted board's tasks, and the report's deleted-board counting. All smoke rows were hard-deleted afterwards. The task numbers they used (5-12) aren't given back, which is the expected gap.

## Implementation notes

- **Open/overdue totals.** Instead of a separate `openTaskTotals` query, `openTasksByPriority` returns an `overdue` count per priority, and the service sums both. It's one query fewer and gives the same numbers.
- **One handler for both mounts.** `TaskLocator` and `parseTaskLocator`/`parseTaskParent` live in `task.validation.ts`. Each controller handler serves both mounts (program-nested and `/tasks`, or `/programs/:id/tasks` and `/boards/:id/tasks`), and the presence of `:programId` / `:boardId` in the params picks the lookup.
- **Locking by ref.** `lockAndFind` by ref reads the task, locks its parent, then reads the task again by id. The parent is only known from the task, and the second read sees state committed under the lock. A program deleted in between gives `Task not found`.
- **When the number is taken.** `createTask` takes the number after all validation, just before the insert, so rejected requests don't use up numbers. Rollbacks after that point can still leave gaps.
- **Docs registration.** The program-nested and `/tasks/{taskRef}` operations are registered by one helper in `task.docs.ts`, as are the program and board create/list operations, so their descriptions can't drift apart.

## Out of scope / follow-ups

- Restoring a deleted board (or program)
- Moving a task between parents
- Board-level comments, board owners/teams, board permissions
- `GET /tasks` across all parents (a global task search)
- Including deleted boards as rows in the report
