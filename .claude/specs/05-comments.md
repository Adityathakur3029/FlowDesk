# 05 — Comments (program and task discussions with @mentions)

**Status:** Done
**Branch:** `comments`
**Depends on:** [01-db-setup](./01-db-setup.md) (`baseColumns()`, `createRepository()`, OpenAPI setup), [03-login](./03-login.md) (`requireAuth`, `req.auth`, `bearerSecurity`, `authNote`, shared 401/403 responses), [04-program-tasks](./04-program-tasks.md) (`programs`, `tasks`, `getActiveProgram()`, `taskRepository.findByRef`, `taskRefParamSchema`, `EmployeeSummary`)

## Goal

Let people discuss work where it happens.

1. **Task comments.** Every task gets a comment thread, Jira-style. This is what gives the `DISCUSSION` status somewhere to happen.
2. **Program comments.** A program gets its own discussion: decisions, announcements, scope changes, anything that isn't about one task. Program-level comments and task comments are separate lists, so a program's discussion isn't flooded by task chatter.
3. **One level of replies.** A top-level comment can have replies. Replies can't have replies.
4. **@mentions are stored now.** A comment can mention employees. The API parses the mentions out of the body and stores them, and returns them with the comment. Notifications are a follow-up, and this data is what they will read.

Comments are **not** an activity log. Events such as "status changed to DONE" or "MKT-3 added as blocker" go in a separate history feature later (see Out of scope). The API never writes comments on its own.

## Flow

```
Client                                         FlowDesk API                                PostgreSQL
  │ POST /programs/:pid/tasks/MKT-7/comments     │ requireAuth                                 │
  │   { body: "Draft ready, @[Jane Doe](mention:…)│ 1. program active?        else 404          │
  │     please review" }                          │ 2. task MKT-7 active?     else 404          │
  │──────────────────────────────────────────────▶│ 3. parse mentions from body                 │
  │                                               │ 4. mentioned employees active? else 400     │
  │                                               │ BEGIN                                       │
  │                                               │ 5. INSERT comments                          │
  │                                               │ 6. INSERT comment_mentions (one per person) │
  │◀──────────────────────────────────────────────│ COMMIT → 201 { data: Comment }              │
  │                                               │                                             │
  │ GET /programs/:pid/tasks/MKT-7/comments       │ top-level comments, oldest first,           │
  │──────────────────────────────────────────────▶│ each with its replies and mentions          │
  │◀──────────────────────────────────────────────│ 200 { data: Comment[], meta }               │
  │                                               │                                             │
  │ PATCH /programs/:pid/comments/:cid { body }   │ author only; re-parse mentions,             │
  │──────────────────────────────────────────────▶│ diff comment_mentions in one transaction    │
  │◀──────────────────────────────────────────────│ 200 { data: Comment } (editedAt set)        │
```

Creating and listing go through the comment's **target**, which is the program or a task. Get, edit and delete use `/programs/:programId/comments/:commentId` for both kinds, so a client (and later a notification link) needs only the comment id.

## Environment variables

None new.

## Packages

None new.

## Folder layout (new and changed)

```
src/
  db/schema/
    comments.ts                    NEW  comments, comment_mentions
    index.ts                       CHANGED  export comments
  modules/comments/                NEW
    comment.routes.ts              programCommentRouter (/programs/:programId/comments)
                                   taskCommentRouter    (/programs/:programId/tasks/:taskRef/comments)
    comment.controller.ts
    comment.service.ts             target resolution, thread rules, permissions, mention sync
    comment.mentions.ts            parseMentionIds(body): string[] (pure, no DB)
    comment.repository.ts          createRepository(comments) + thread/list queries
    commentMention.repository.ts   createRepository(commentMentions) + mentionsFor, replaceForComment
    comment.validation.ts          Zod schemas (also drive the docs)
    comment.dto.ts                 toCommentDto / toCommentReplyDto (tombstones, replies, mentions)
    comment.docs.ts
  modules/tasks/
    task.service.ts                CHANGED  export getActiveTask(programId, taskRef): Task (404s)
  modules/employees/
    employee.repository.ts         CHANGED  findActiveIds(ids): Set<string> (mention checks)
  docs/registry.ts                 CHANGED  new error codes
  docs/openapi.ts                  CHANGED  import comment.docs; Comments tag
  app.ts                           CHANGED  mount both comment routers in routeModules
drizzle/0005_create_comments.sql   NEW  generated migration
```

The request flow is the same as in spec 04: **route → requireAuth → controller (Zod) → service → repository → Drizzle**. Both routers use `Router({ mergeParams: true })`.

In `routeModules`, list them **before** `/programs/:programId/tasks` and `/programs`, most specific first:

```ts
{ basePath: "/programs/:programId/tasks/:taskRef/comments", router: taskCommentRouter },
{ basePath: "/programs/:programId/comments", router: programCommentRouter },
{ basePath: "/programs/:programId/tasks", router: taskRouter },
{ basePath: "/programs", router: programRouter },
```

None of these paths actually collide, because `taskRouter` has no route matching `/:taskRef/comments`. The order is for readability and safety.

`getActiveTask` is a small new export from `task.service.ts`. It runs `getActiveProgram(programId)` and then `taskRepository.findByRef`, and throws `NotFoundError("Program not found")` / `NotFoundError("Task not found")`. The comment service uses it so the "deleted program or task is 404" rule stays in one place.

## Schema

### `comments`

| Column | Type | Constraints |
| --- | --- | --- |
| `...baseColumns()` | | `is_active = false` means the comment was deleted (soft delete) |
| `program_id` | `uuid` | not null, FK → `programs.id`. Always set, including on task comments |
| `task_id` | `uuid` | nullable, FK → `tasks.id`. `NULL` means a program-level comment |
| `parent_id` | `uuid` | nullable, FK → `comments.id` (self-reference, `(): AnyPgColumn => comments.id`). `NULL` means a top-level comment |
| `author_id` | `uuid` | not null, FK → `employees.id`. Set from `req.auth` |
| `body` | `text` | not null. Markdown, stored as sent after trimming |
| `edited_at` | `timestamptz` | nullable. Set on every successful edit |

Constraints and indexes:
- `CHECK (num_nonnulls(task_id) <= 1)` (`comments_single_target_check`). With one child column this can't fail yet. It's there so the target rule has a name and a place to grow: when reports arrive it becomes `num_nonnulls(task_id, report_id) <= 1`, meaning "the program, or exactly one child entity".
- `CHECK (parent_id IS NULL OR parent_id <> id)` (`comments_no_self_parent_check`)
- index `(program_id, created_at)` (`comments_program_created_idx`), for program-level lists
- index `(task_id, created_at)` (`comments_task_created_idx`), for task lists
- index `parent_id` (`comments_parent_id_idx`), for loading replies

> **Why one table with nullable FKs, and not `entity_type` + `entity_id`:** every reference stays a real foreign key, so Postgres guarantees a comment can't point at a missing task. Adding comments to reports, insights, docs or findings later is one nullable column, one FK and a wider CHECK. `Program`, `Task` and the API shape don't change.

### `comment_mentions`

One row per (comment, mentioned employee). It's program-owned, so it gets `program_id`.

| Column | Type | Constraints |
| --- | --- | --- |
| `...baseColumns()` | | `is_active` is always `true`. Rows are hard-deleted, the same as `task_dependencies` |
| `program_id` | `uuid` | not null, FK → `programs.id` |
| `comment_id` | `uuid` | not null, FK → `comments.id` |
| `employee_id` | `uuid` | not null, FK → `employees.id` |

- `UNIQUE (comment_id, employee_id)` (`comment_mentions_pair_unique`)
- index `(employee_id, created_at)` (`comment_mentions_employee_idx`), for the future "mentions of me" and notifications

> `created_at` on a mention row records when that person was first mentioned in that comment. Edits keep the rows of people who are still mentioned, so a future notifier can tell new mentions from old ones without rereading bodies.

Migration: `npm run db:generate -- --name create_comments` → `drizzle/0005_create_comments.sql`. Review it, then run `npm run db:migrate`.

## Mentions

### Syntax

A mention is a Markdown link with the `mention:` scheme:

```
@[Jane Doe](mention:baac08e5-eaef-46f0-ac9e-f8b7266c71e0)
```

- The frontend inserts this token when the user picks someone from an @-autocomplete (backed by `GET /employees`). The UUID identifies the person. The label is only display text, and the server doesn't check it against the employee's name.
- `parseMentionIds(body)` matches `/@\[[^\]\n]{1,150}\]\(mention:([0-9a-fA-F-]{36})\)/g`. It lowercases the ids, removes duplicates and keeps first-appearance order. Matches inside Markdown code blocks still count. Detecting code fences is out of scope.
- A plain `@jane` with no token is just text. It isn't a mention.

> **Why ids and not `@name` or `@email`:** names aren't unique and emails can change. With the id in the token, a mention still points to the right person after a rename, and the text degrades gracefully in any Markdown renderer (it shows as a "Jane Doe" link).

### Rules (create and edit)

The order is:

1. More than **20** distinct mentioned ids → **400 `TOO_MANY_MENTIONS`** ("A comment can mention at most 20 people").
2. Every mentioned id must be an **active** employee → **400 `MENTION_NOT_FOUND`** ("Mentioned employee <id> not found or inactive"). On **edit**, ids that were already mentioned in this comment are exempt, so editing an old comment still works after someone in it was deactivated.
3. The service saves the comment and its `comment_mentions` rows in one transaction:
   - **On create:** insert one row per id.
   - **On edit:** delete the rows for ids no longer in the body and insert rows for new ids. Rows for unchanged ids stay as they are (so their `created_at` survives).

Self-mentions are allowed and stored. A future notifier can skip them.

## Thread and target rules

### Targets

- A **program comment** has `task_id = NULL`. It's created and listed through `/programs/:programId/comments`.
- A **task comment** has `task_id` set. It's created and listed through `/programs/:programId/tasks/:taskRef/comments`. `:taskRef` is a UUID or a key, exactly as in spec 04.
- `GET /programs/:programId/comments` returns **only** program-level comments. Task comments are never mixed in.
- **Every comment route** resolves the program first, so an unknown or soft-deleted program → 404 `Program not found`.
- **Task comment routes** then resolve the task, so an unknown or soft-deleted task → 404 `Task not found`.
- **Routes by `:commentId`** look the comment up within `:programId`. If it's missing, deleted, or **belongs to a soft-deleted task** → 404 `Comment not found`.

> **Consequence:** a soft-deleted task's comments are kept but can't be reached. Comments of a soft-deleted program are handled the same way. Restoring either is out of scope, as in spec 04.

Comments are allowed on tasks in any status (including `DONE`) and on programs in any status (including `COMPLETED` and `CANCELLED`).

### Replies (`parentId` on create)

The order is:

1. The parent must be an **active** comment in this program → otherwise **400 `PARENT_COMMENT_NOT_FOUND`**.
2. The parent must have the **same target**: the same `task_id`, or both `NULL` → otherwise **400 `PARENT_TARGET_MISMATCH`** ("A reply must be on the same task or program as its parent").
3. The parent must be top-level (`parent_id IS NULL`) → otherwise **400 `NESTED_REPLY`** ("Replies can't have replies; reply to the top-level comment"). The client should reply to the thread's root.

> **Why reject and not flatten:** quietly re-parenting a reply to the root would change what the client asked for. A clear 400 is easier to handle than an unexpected thread.

### Deleted comments (tombstones)

- `DELETE` is a soft delete (`is_active = false`). The comment's `comment_mentions` rows are hard-deleted in the same transaction, so a later notifier never sees mentions in deleted comments.
- A deleted **reply** disappears from every list.
- A deleted **top-level comment** disappears too, unless it still has at least one active reply. Then it's listed as a **tombstone**, so the replies keep their context:
  - `isActive: false`, `body: null`, `author: null`, `mentions: []`
  - `id`, `createdAt`, `parentId` and `replies` are still filled in
  - `editedAt` is `null`
- A tombstone can't be edited, deleted again, or replied to. `GET` by id, `PATCH` and `DELETE` return 404 `Comment not found`, and a new reply returns 400 `PARENT_COMMENT_NOT_FOUND`.
- Replies to a deleted comment stay. Each reply's author can still edit or delete it.

## Permissions

Every route needs a signed-in employee (any role). There's no per-program membership yet (a follow-up from specs 03 and 04).

| Action | Who | Otherwise |
| --- | --- | --- |
| List, get, create, reply | any signed-in employee | – |
| Edit (`PATCH`) | the **author** only. ADMINs and MANAGERs can't edit other people's words | **403 `FORBIDDEN`** |
| Delete | the **author**, a `MANAGER` or an `ADMIN` | **403 `FORBIDDEN`** |

These are row-based checks, so they run in the service and throw `ForbiddenError("You do not have permission to perform this action", "FORBIDDEN")`, the same way task delete does in spec 04. The order is: find the comment (404 first), then check permission (403). A deactivated author can't sign in, so in practice only a MANAGER or an ADMIN can remove their comments.

## API

All routes need `Authorization: Bearer <accessToken>`, and all can return the shared `401` (`AUTH_REQUIRED` / `INVALID_AUTH_TOKEN`) and `500` responses. Error bodies are `{ error, code?, details? }`.

### `Comment` shape (`toCommentDto`)

```json
{
  "id": "…", "createdAt": "…", "updatedAt": "…", "isActive": true,
  "programId": "…", "taskId": "…", "parentId": null,
  "author": { "id": "…", "name": "Ravi Kumar", "emailId": "ravi.kumar@saajha.org" },
  "body": "Draft ready, @[Jane Doe](mention:baac08e5-…) please review",
  "editedAt": null,
  "mentions": [{ "id": "baac08e5-…", "name": "Jane Doe", "emailId": "jane.doe@saajha.org" }],
  "replies": [ /* Comment objects without `replies`, oldest first */ ]
}
```

- `taskId` is `null` on program comments.
- `mentions` is ordered by name. It shows the employee's **current** name, which may differ from the label in the body.
- `replies` appears **only on top-level comments**. It holds every active reply, oldest first. Replies don't have a `replies` field.
- A deactivated author or mentioned employee is still shown (`EmployeeSummary` from `registry.ts`, reused).
- On a tombstone, see "Deleted comments" above.

### Shared validation (`comment.validation.ts`)

- `body`: string, trimmed, 1 to 10,000 characters. Mentions are parsed from it (see Mentions).
- `parentId`: optional UUID (create only).
- `commentIdParamSchema`: `programIdParamSchema.extend({ commentId: z.uuid() })`.
- `taskCommentParamSchema`: `taskRefParamSchema` from `task.validation.ts`, reused as-is.
- `listCommentsQuerySchema`:
  - `order`: `asc` / `desc`, default **`asc`** (oldest first, like reading a conversation). It applies to top-level comments only. Replies are always oldest first.
  - `limit` / `offset`: same as `/employees`. They page **top-level comments** (threads), and each thread comes back with all of its replies.

### `GET /programs/:programId/comments` — list program-level comments
**Roles:** any.

The list holds top-level program comments (`task_id IS NULL AND parent_id IS NULL`): active ones, plus tombstones that still have active replies. Each comes with its replies and mentions. `meta.total` counts the same set.

Responses: `200 { data: Comment[], meta: PaginationMeta }`. `400` validation. `404 Program not found`.

### `POST /programs/:programId/comments` — comment on a program
**Roles:** any.

Body (`createCommentSchema`): `{ "body": "…", "parentId"?: "<uuid>" }`. The author comes from `req.auth.employeeId`.

Business rules, in this order: program active (404) → reply rules, if there's a `parentId` → mention rules → insert the comment and its mentions in one transaction.

Responses: `201 { data: Comment }`. A top-level comment comes back with `replies: []`. `400` validation / `PARENT_COMMENT_NOT_FOUND` / `PARENT_TARGET_MISMATCH` / `NESTED_REPLY` / `TOO_MANY_MENTIONS` / `MENTION_NOT_FOUND`. `404 Program not found`.

### `GET /programs/:programId/tasks/:taskRef/comments` — list a task's comments
**Roles:** any.

The same as the program list, but for `task_id = <task>`.

Responses: `200 { data: Comment[], meta }`. `400`. `404 Program not found` / `Task not found`.

### `POST /programs/:programId/tasks/:taskRef/comments` — comment on a task
**Roles:** any.

The same body and rules as the program create, with the task resolved after the program.

Responses: `201 { data: Comment }`. `400` (the same codes as the program create). `404 Program not found` / `Task not found`.

### `GET /programs/:programId/comments/:commentId` — get one comment
**Roles:** any.

This works for program and task comments. A top-level comment comes with its replies. This is the target for deep links and, later, notification links.

Responses: `200 { data: Comment }`. `400` bad UUID. `404 Program not found` / `Comment not found` (missing, deleted, a tombstone, or its task was deleted).

### `PATCH /programs/:programId/comments/:commentId` — edit a comment
**Roles:** the author only.

Body (`updateCommentSchema`, `.strict()`): `{ "body": "…" }`. Only the body can change. Sending `parentId` or anything else → 400 `Validation failed`.

Business rules, in this order:
1. Find the comment (404).
2. Check the caller is the author (403 `FORBIDDEN`).
3. Apply the mention rules, with previously mentioned ids exempt.
4. In one transaction, update `body`, set `edited_at = now()`, and diff `comment_mentions`.

An edit that sends the same body still sets `editedAt`. The service doesn't compare bodies.

Responses: `200 { data: Comment }`. `400` validation / `TOO_MANY_MENTIONS` / `MENTION_NOT_FOUND`. `403 FORBIDDEN`. `404`.

### `DELETE /programs/:programId/comments/:commentId` — delete a comment
**Roles:** the author, `MANAGER` or `ADMIN`.

In one transaction: find the comment (404), check permission (403), soft-delete it, and hard-delete its mention rows. Replies are kept (see Deleted comments).

Responses: `204`. `403 FORBIDDEN`. `404`.

## Error classes (`src/lib/errors.ts`)

No new classes:
- `BadRequestError`: `PARENT_COMMENT_NOT_FOUND`, `PARENT_TARGET_MISMATCH`, `NESTED_REPLY`, `TOO_MANY_MENTIONS`, `MENTION_NOT_FOUND`
- `NotFoundError("Comment not found")`, plus the existing `Program not found` / `Task not found`
- `ForbiddenError(…, "FORBIDDEN")` for the edit and delete permission checks

Add the 5 new codes to the `ErrorResponse.code` description in `src/docs/registry.ts`.

## API documentation

- `comment.docs.ts`:
  - documents all 7 routes and registers `Comment`, `CommentReply` (a comment without `replies`), `CommentResponse`, `CommentListResponse`, `CreateCommentRequest` and `UpdateCommentRequest` from the Zod schemas
  - reuses `EmployeeSummary`, `PaginationMeta`, `bearerSecurity`, the shared 401 response and `programNotFoundResponse` from `program.docs.ts`
  - the 403s on PATCH and DELETE have their own descriptions ("not the author", "a MEMBER who isn't the author") with the same `FORBIDDEN` body, because the shared `Forbidden` response describes a role check
  - the list responses have a `tombstone` example next to the normal `thread` one
  - the `Comment` schema description covers:
    - tombstones (`isActive: false`, `body: null`, `author: null`)
    - that `replies` appears only on top-level comments
    - that `mentions` shows current names
  - the `body` field description gives the mention syntax with an example, the 20-mention limit, and that the frontend must render Markdown **sanitised** (the API stores it as-is)
  - the PATCH and DELETE descriptions state the author/role rule, because `authNote()` only covers roles (use the explicit wording from the task delete docs in spec 04)
  - every error code above has an example under the right status
- `openapi.ts`: import `comment.docs`, and add the tag `Comments` ("Discussion threads on programs and tasks, with @mentions").
- `npm run docs:validate` must pass and list all 7 new routes (28 in total).

## Acceptance checklist

- [x] Migration `0005_create_comments` generated, reviewed, applied. `npm run db:check` passes
- [x] `POST /programs/:pid/comments` → 201, `taskId: null`, `replies: []`, and the author is the caller. `POST …/tasks/MKT-7/comments` (also via the task UUID, and with lowercase `mkt-7`) → 201 with `taskId` set
- [x] The program list shows only program comments. The task list shows only that task's comments
- [x] A reply (`parentId` = top-level) → 201, and it appears in the parent's `replies`, oldest first. A reply to a reply → 400 `NESTED_REPLY`. A reply whose parent is on another task, or is program-level while the reply is on a task → 400 `PARENT_TARGET_MISMATCH`. A reply to an unknown or deleted parent → 400 `PARENT_COMMENT_NOT_FOUND`
- [x] A body mentioning two active employees (one of them twice) → `mentions` has 2 entries and `comment_mentions` has 2 rows. Mentioning an inactive or unknown id → 400 `MENTION_NOT_FOUND`. 21 distinct mentions → 400 `TOO_MANY_MENTIONS`. A plain `@jane` → no mention
- [x] An edit by the author → 200, `editedAt` set, and mention rows diffed: a removed person's row is deleted, a kept person's row keeps its `created_at`, and a new person gets a row. An edit by someone else (even an ADMIN) → 403 `FORBIDDEN`. Sending `parentId` in a PATCH → 400
- [x] Editing a comment that mentions someone who has since been deactivated still works if that mention is kept
- [x] Delete by the author → 204. Delete by another MEMBER → 403. Delete by a MANAGER or ADMIN → 204. After a delete, the mention rows are gone and GET/PATCH/DELETE → 404
- [x] Deleting a top-level comment with replies → listed as a tombstone (`isActive: false`, `body: null`, `author: null`) with its replies. Once those replies are deleted too, it's gone from the list, and `meta.total` matches
- [x] Soft-deleting the task → its comment routes and its comments by id → 404. Soft-deleting the program → every comment route → 404
- [x] Pagination pages threads: `limit=1` returns one top-level comment with all of its replies. `order=desc` puts the newest thread first
- [x] An empty or whitespace-only body → 400. 10,001 characters → 400
- [x] Every route returns 401 without a token
- [x] `npm run typecheck`, `npm run build`, `npm run docs:validate` pass

## Verified

Every checklist item was exercised over HTTP by a throwaway `tsx` script (88 checks). Besides the items above, it covered: a 36-character mention token that isn't a UUID (400 `MENTION_NOT_FOUND`), uppercase mention ids, self-mentions, a body of exactly 10,000 characters, comments on a `DONE` task and a `COMPLETED` program, and a deactivated reply author still being shown. The test rows were deleted afterwards.

Implementation notes:
- A mention token whose 36 characters aren't a UUID can't match an employee. It fails with `MENTION_NOT_FOUND` and is never sent to Postgres.
- `PATCH` and `DELETE` lock the comment row (`FOR UPDATE`), and creating a reply locks its parent (`FOR SHARE`). A reply that races a delete of its parent either commits first (the parent then becomes a tombstone) or gets `PARENT_COMMENT_NOT_FOUND`.

## Testing notes

- As in spec 04, a small `tsx` script that imports `app`, inserts test employees and signs tokens with `signAccessToken` can exercise everything over HTTP. Delete the rows afterwards.
- To check the mention diff, read `comment_mentions` directly before and after an edit and compare `created_at` values.

## Out of scope / follow-ups

- **Notifications** for mentions (and for replies or comments on tasks you're assigned to or reported). This will read `comment_mentions` (`created_at` tells new mentions from old) and needs a notifications table and/or email through the existing `sendEmail`
- A "mentions of me" endpoint (`GET /me/mentions`), which the `(employee_id, created_at)` index is ready for
- `commentCount` on task lists (deliberately left out, by decision)
- An activity/history log of system events (status changes, assignment, dependency changes). It's a separate feature, never written as comments
- Edit history (only `editedAt` is kept), reactions/emoji, attachments, pinned comments
- Comments on reports, insights, docs and findings. Add a nullable FK column and widen `comments_single_target_check`
- Paginating replies inside a thread. Threads return all their replies for now
- Ignoring mentions inside Markdown code blocks
- Rate limiting and spam controls
- Per-program membership (who can see and comment on which program)
- Restoring deleted comments
- Automated tests (there's still no test runner)
