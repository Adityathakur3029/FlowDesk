# FlowDesk

FlowDesk is the backend service for a mini Jira-style project management tool.

## Tech stack

- **Language:** TypeScript (strict mode, see `tsconfig.json`)
- **Runtime / framework:** Node.js + Express 5
- **Database:** PostgreSQL
- **ORM:** Drizzle ORM. All schema definitions, queries, and migrations go through Drizzle. Avoid raw SQL through `pg` unless Drizzle can't express the query.
- **Config:** environment variables loaded with `dotenv` (`DATABASE_URL`, `PORT`; see `.env.example`)

> Note: Drizzle is not installed yet. `src/db.ts` currently exposes a plain `pg` `Pool`. When adding Drizzle, wrap that pool with `drizzle(pool)` and use it for all data access.

## Commands

| Command         | Purpose                            |
| --------------- | ---------------------------------- |
| `npm run dev`   | Run `src/server.ts` with auto-reload (tsx) |
| `npm run build` | Compile TypeScript to `dist/`      |
| `npm start`     | Run the compiled server            |

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
