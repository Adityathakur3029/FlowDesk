---
name: write-spec
description: Turn a feature idea, requirement notes or pasted flow into a numbered FlowDesk spec in `.claude/specs/NN-<slug>.md` (Goal, Flow, Env, Packages, Folder layout, Schema, API, Errors, Docs, Acceptance checklist, Out of scope), grounded in the current code. Use this whenever the user asks to write, draft, create, plan or update a spec or design doc for a FlowDesk feature, says "based on this update the spec", pastes requirements and wants them written up, or names a file under `.claude/specs/`, even if they don't say the word "spec".
---

# Write a FlowDesk spec

A spec here is the design contract that gets implemented next. It has to be specific enough that whoever builds it (usually Claude, in a later session) doesn't need to make design decisions, and accurate about the current code so the plan actually fits. **Write the spec only. Don't change any code.**

## 1. Gather context

Read before you write, because the spec has to match the existing code:
- `.claude/CLAUDE.md`: the conventions (Drizzle, `baseColumns()`, `createRepository()`, `programId` on program-owned tables, the API documentation rules).
- Every file in `.claude/specs/`, especially the most recent one. It's the style reference and tells you what already exists and what was left out of scope.
- The code the feature touches: the schema in `src/db/schema/`, `src/config/env.ts`, `src/lib/errors.ts`, `src/docs/registry.ts`, `src/app.ts` (`routeModules`), the relevant `src/modules/*`, and `package.json` (what's already installed).

Reuse what exists. If there's already an error class, env var, repository helper or package that does the job, name it in the spec. Don't invent a new one.

## 2. Pick the file

- If the user named a file (for example `03-login.md`), write to it. If it already has content, update it in place and keep anything that's still right.
- Otherwise use the next number after the highest existing spec: `NN-<kebab-slug>.md`, for example `04-program-tasks.md`.

## 3. Ask only the questions that change the design

If the request leaves real design decisions open, ask them **in one round**, at most about 3, each with a recommended option and its trade-off. Good examples: a session JWT vs a cookie vs a session table, binding an external ID or matching by email only, or how far the scope goes (does it also protect existing routes?).

Don't ask about things the codebase or the conventions already answer, and don't ask for approval of the outline. Pick sensible defaults for everything else and say what you picked in the spec.

## 4. Write the spec

Follow this structure. Leave out a section only when it genuinely doesn't apply (for example "Schema change" when no table changes).

```markdown
# NN — <Title> (<short qualifier>)

**Status:** Planned
**Branch:** `<branch>`
**Depends on:** [NN-name](./NN-name.md) (<what it relies on>), …

## Goal
What the feature does and why, in the user's terms. Numbered list if there are several parts.

## Flow
ASCII sequence diagram (actor │ FlowDesk API │ other party) with numbered steps,
followed by a short paragraph on anything non-obvious (who calls what, why it's POST and not GET, …).

## Environment variables
| Variable | Required | Example | Purpose |   (validated in src/config/env.ts)

## Packages
| Package | Kind | Purpose |   (mark ones already installed)

## Folder layout (new and changed)
Tree with NEW / CHANGED markers and a few words per file. Restate the request flow
(route → controller (Zod) → service → repository → Drizzle) and any layering rule.

## Schema / `<table>` table
| Column | Type | Constraints |, indexes, status lifecycle diagram if there's a state machine,
the migration name (`npm run db:generate -- --name <change>`).

## <Domain rules / tokens / middleware> (as needed)
The business rules, in the order they're applied, each with its exact failure response.

## API
### `METHOD /path` — summary
**Auth:** … · Request JSON · Validation (Zod schema name, per-field rules) ·
Business rules (numbered, ordered) · Responses (status + `CODE` + message).

## Error classes (`src/lib/errors.ts`)
New classes and new `code` values to add to the ErrorResponse description.

## API documentation
What goes in `<module>.docs.ts` and `src/docs/registry.ts` (security schemes, shared responses,
examples), and that `npm run docs:validate` must pass.

## Acceptance checklist
- [ ] One testable line per behaviour: input → expected status/code/DB state.
- [ ] `npm run typecheck`, `npm run build`, `npm run docs:validate` pass

## Testing notes (optional)
How to exercise it locally (console transport, backdating a column, getting a real token, …).

## Out of scope / follow-ups
```

How to write it well:
- **Be exact.** Give status codes, error `code` strings, column types and constraints, env defaults and the order in which rules are checked. "Handle errors appropriately" isn't something anyone can implement.
- **Every error has a status, a `code` and a message**, and appears both in the rules and in the endpoint's response list.
- **Explain the non-obvious choices in one or two sentences**, in a `>` note where it helps (for example why 410 and not 408, or why the role comes from the DB and not the token). That keeps the next person from "fixing" a deliberate decision.
- **Call out consequences the user may not expect**, such as "an employee created without an invite can't log in", together with how the spec handles them (a bootstrap script, for example).
- **Follow the CLAUDE.md API documentation rules.** Every new or changed endpoint needs a docs entry, including its auth requirements and roles. When auth on an existing route changes, update that route's docs too.
- **Keep scope honest.** Anything mentioned but not built goes in "Out of scope / follow-ups".
- Match the tone of the existing specs: plain sentences, tables for structured facts, no filler.

## 5. Check it, then report

Re-read the spec against the code you looked at. Check that the file paths exist (or are marked NEW), that column and enum names match the schema, that the route list matches `app.ts`, and that the error classes follow the existing pattern.

Then reply briefly:
- where the spec is
- a few bullets on the design
- the decisions the user should look at (defaults you picked, surprising consequences, security trade-offs)

Don't paste the whole spec into the chat.

## Updating a spec after implementation

If the user asks to mark a spec done, set **Status** to `Done` and tick the checklist items that were actually verified. Add a `## Verified` section with what was run and observed, and an `## Implementation notes` section for anything that differs from the plan. Only tick things that were really checked.