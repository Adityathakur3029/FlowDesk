# FlowDesk

FlowDesk is the backend service for a mini Jira-style project management tool.

## Tech stack

- **Language:** TypeScript (strict mode, see `tsconfig.json`)
- **Runtime / framework:** Node.js + Express 5
- **Database:** PostgreSQL
- **ORM:** Drizzle ORM. All schema definitions, queries, and migrations go through Drizzle. Avoid raw SQL through `pg` unless Drizzle can't express the query.
- **Config:** environment variables loaded with `dotenv` (`DATABASE_URL`, `PORT`; see `.env.example`)

> Data layer: `src/db/index.ts` exposes `db = drizzle(pool)`. Tables live in `src/db/schema/` (exported from `schema/index.ts`) and spread `...baseColumns()` (`id`, `created_at`, `updated_at`, `is_active`). Services go through repositories built with `createRepository()` from `src/db/repository.ts`. See `.claude/specs/01-db-setup.md`.

## Commands

| Command         | Purpose                            |
| --------------- | ---------------------------------- |
| `npm run dev`   | Run `src/server.ts` with auto-reload (tsx) |
| `npm run build` | Compile TypeScript to `dist/`      |
| `npm start`     | Run the compiled server            |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:generate -- --name <change>` | Generate a SQL migration from schema changes |
| `npm run db:migrate` | Apply pending migrations (`db:migrate:prod` runs from `dist/`) |
| `npm run db:studio` | Open Drizzle Studio |

## Domain model

**Program** is the core entity. Everything else belongs to a program.

### Program
- Has a **status**, which tracks its lifecycle.
- Owns many **tasks**.
- Will later own other kinds of work (see below).

### Task
- Belongs to exactly one program.
- Can be **assigned** to a user (the assignee).
- Has its own status.

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
- Keep the Drizzle schema in a dedicated location (e.g. `src/db/schema/`) and manage schema changes through Drizzle migrations.

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
