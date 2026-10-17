# FlowDesk

FlowDesk is the backend service for a mini Jira-style project management tool.

## Tech stack

- **Language:** TypeScript (strict mode, see `tsconfig.json`)
- **Runtime / framework:** Node.js + Express 5
- **Database:** PostgreSQL
- **ORM:** Drizzle ORM. All schema definitions, queries, and migrations go through Drizzle. Avoid raw SQL through `pg` unless Drizzle can't express the query.
- **Config:** environment variables loaded with `dotenv` (`DATABASE_URL`, `PORT`; see `.env.example`)

> Data layer: `src/db/index.ts` exposes `db = drizzle(pool)`. Tables live in `src/db/schema/` (exported from `schema/index.ts`) and spread `...baseColumns()` (`id`, `created_at`, `updated_at`, `is_active`). Services go through repositories built with `createRepository()` from `src/db/repository.ts`. See `.claude/specs/01-db-setup.md`.

> Specs: each feature has a design spec in `.claude/specs/NN-<slug>.md`: 01 DB setup, 02 member invites, 03 Google login, 04 programs and tasks, 05 comments, 06 teams. Read the relevant spec before changing a feature, and update it when the behaviour changes.

## Commands

| Command         | Purpose                            |
| --------------- | ---------------------------------- |
| `npm run dev`   | Run `src/server.ts` with auto-reload (tsx) |
| `npm run build` | Compile TypeScript to `dist/`      |
| `npm start`     | Run the compiled server            |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:generate -- --name <change>` | Generate a SQL migration from schema changes |
| `npm run db:migrate` | Apply pending migrations (`db:migrate:prod` runs from `dist/`) |
| `npm run db:check` | Check the migration history is consistent |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run docs:validate` | Validate the OpenAPI spec and check every route is documented |
| `npm run auth:bootstrap-admin` | Create the first ADMIN (reads `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_NAME`) |

## Domain model

**Program** is the core entity. Everything else belongs to a program.

### Program (`programs`, `src/modules/programs/`)
- Has a short uppercase **key** (`MKT`), which prefixes its task keys. The key can't be changed, and it stays taken after the program is soft-deleted.
- Has a **status** (`PLANNED`, `ACTIVE`, `ON_HOLD`, `COMPLETED`, `CANCELLED`), with no transition rules yet.
- Owns many **tasks**.
- Will later own other kinds of work (see below).
- Soft-deleting a program makes every route under it return 404.

### Task (`tasks`, `src/modules/tasks/`)
- Belongs to exactly one program.
- Has a Jira-style key, `<program key>-<n>` (`MKT-42`). Numbers come from `programs.task_counter`, run per program and are never reused. Routes accept the task UUID or its key.
- Can be **assigned** to an employee (the assignee). The **reporter** is whoever created it.
- Has a title, description, priority, start date, due date, estimate (in minutes) and labels.
- Has a status: `DISCUSSION`, `ON_HOLD`, `IN_PROGRESS`, `DONE` or `DEPENDENT`.
- Can depend on other tasks in the same program (`task_dependencies`, "is blocked by"). Loops aren't allowed, and a task can have at most 50 blockers.
- `DEPENDENT` is **automatic**:
  - A task with an unfinished blocker becomes `DEPENDENT`.
  - It gets its previous status back when the last blocker is done or removed.
  - Clients can't set it, and they can't change a `DEPENDENT` task's status (409 `TASK_BLOCKED`).
- See `.claude/specs/04-program-tasks.md` for the full rules.

### Comment (`comments`, `comment_mentions`, `src/modules/comments/`)
- Is on a program (`task_id` NULL) or on one of its tasks. Program and task comments are listed separately; get/edit/delete use `/programs/:programId/comments/:commentId` for both.
- One level of replies (`parent_id`). A reply must be on the same target as its parent, and replies can't have replies.
- @mentions are `@[Name](mention:<employee uuid>)` tokens in the Markdown body, stored in `comment_mentions` (at most 20, each an active employee). Edits diff the rows, so a kept mention's `created_at` survives.
- Edit: author only. Delete (soft): author, MANAGER or ADMIN. A deleted top-level comment with active replies is listed as a tombstone.
- Comments are discussion only. The API never writes them on its own (an activity log is a separate future feature).
- See `.claude/specs/05-comments.md` for the full rules.

### Team (`teams`, `src/modules/teams/`)
- An organisation-level group of employees (no `programId`). Names are unique among active teams, ignoring case; a deleted team's name can be reused.
- An employee is in **at most one** team (`employees.team_id`). `PUT /teams/:teamId/members/:employeeId` moves them out of any other team.
- Every program has one **owner team** (`programs.owner_team_id`): required on create, changeable on PATCH, never cleared. It's NULL only on programs created before teams existed.
- The owner team is data only for now. It doesn't restrict access.
- Deleting a team (ADMIN) is refused with 409 `TEAM_OWNS_PROGRAMS` while it owns an active program. Otherwise its members are released.
- Anything that attaches a program or member to a team locks the team row `FOR SHARE` (`teamRepository.lockForShare`) in its transaction, and team delete takes `lockForUpdate`.
- See `.claude/specs/06-teams.md` for the full rules.

### Planned program scope (future)
Each program will also hold several kinds of research-related content:
- **Reports**
- **Insights**
- **Docs**
- **Findings** (research results)

Design the schema and APIs so these can be added later as program-owned entities, each with a `programId` foreign key, without restructuring `Program` or `Task`.

## Conventions

- Every program-owned table has a `programId` foreign key to `programs.id`.
- Scope API routes under programs where it makes sense, e.g. `/programs/:programId/tasks`.
  - A program-scoped module uses `Router({ mergeParams: true })` and is mounted in `routeModules` in `src/app.ts` at `/programs/:programId/<things>`. Mount routers only through `routeModules`, because `docs:validate` reads it.
  - Resolve the program first with `getActiveProgram()` (`program.service.ts`), so unknown and soft-deleted programs return 404.
- Keep the Drizzle schema in a dedicated location (e.g. `src/db/schema/`) and manage schema changes through Drizzle migrations.
- Request flow: **route → `requireAuth` (→ `requireRole`) → controller (Zod parse) → service → repository → Drizzle**.
  - Services don't build queries.
  - Multi-step writes use `withTransaction()` and pass the transaction to repositories with `.withTx(tx)`.
- **Auth:**
  - Every route except `POST /auth/google`, `POST /invites/accept`, `/health-check` and the docs routes needs `Authorization: Bearer <token>`, checked by `requireAuth` in `src/middleware/auth.ts`.
  - Roles are `ADMIN`, `MANAGER` and `MEMBER`, checked with `requireRole(...)`. Rules that depend on the row (for example, a task's reporter may delete it) go in the service and throw `ForbiddenError(…, "FORBIDDEN")`.
- **Errors:** services throw the classes in `src/lib/errors.ts` with a machine-readable `code`. Add every new code to the `ErrorResponse.code` description in `src/docs/registry.ts`.
- **Responses:**
  - Successful responses use `{ data }`, plus `meta` on paginated lists.
  - Map rows through a `to<Entity>Dto()` function so internal columns are never returned (`google_sub`, `task_counter`, `status_before_dependent`).
- **Task graph writes:**
  - Any write that can change task dependencies, or whether a task is `DONE`, must lock the program row first (`programRepository.lockForUpdate`, or `nextTaskNumber` on create) inside the transaction.
  - Only `syncDependentStatus()` in `src/modules/tasks/task.dependencyStatus.ts` sets or clears `DEPENDENT`.

## API Documentation Rules

- Every API endpoint must have complete Swagger/OpenAPI documentation.
- Whenever you create, modify, or remove an API, update its Swagger documentation accordingly.
- Document all of the following for each endpoint:
  - HTTP method and route.
  - Summary and description.
  - Authentication and authorization requirements.
  - Required roles and permissions.
  - Path parameters, query parameters, and request headers.
  - Request body schema with required and optional fields.
  - Successful response schemas and HTTP status codes.
  - Error responses with status codes and response body schemas.
  - Validation rules and possible validation errors.
  - Example requests and responses.
- Use reusable OpenAPI schemas and shared response definitions wherever possible.
- Document authentication requirements, including Google OAuth, wherever applicable.
- Ensure the Swagger documentation matches the actual implementation. Never document behavior that is not implemented.
- Do not consider an API complete until its implementation and Swagger documentation are both updated.
- Before finishing any API-related task, verify that the Swagger documentation is valid and that all affected endpoints are documented.
- Follow the existing Swagger/OpenAPI configuration and project conventions. Do not introduce a second documentation system unnecessarily.

### How API docs work in this project

- The OpenAPI 3.0 document is generated from Zod schemas with `@asteasolutions/zod-to-openapi`. The request schemas the controllers use for validation are the same ones documented, so validation rules stay in sync.
- Shared pieces (error/validation response schemas, shared responses, pagination meta) live in `src/docs/registry.ts`. Reference them; don't redefine them per module.
- Each module documents its routes in `<module>.docs.ts` (e.g. `src/modules/employees/employee.docs.ts`), and `src/docs/openapi.ts` imports that file.
- Swagger UI is served at `/docs` and the raw spec at `/openapi.json`.
- Run `npm run docs:validate` before finishing any API task. It validates the spec and fails if an Express route has no documentation, or a documented route doesn't exist.
