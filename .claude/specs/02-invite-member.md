# 02 — Invite a new member (email invite + accept)

**Status:** Done
**Branch:** `invite-new-member`
**Depends on:** [01-db-setup](./01-db-setup.md) (`employees` table, repository, error handler, OpenAPI setup)

## Goal

Let an existing user invite someone to the organisation by email instead of creating the employee row directly:

1. **Invite API**: takes an email and a role, checks that the email belongs to the organisation's domain, records an invite, and emails an invitation link.
2. **Email service**: a reusable, separate module that sends an email given a **template**, the template's data, and a **sender email**. Invites are its first user.
3. **Accept API**: takes the token from the invite link. If the invite was accepted **within 3 days** of being sent, it creates the `employees` row and returns success. Otherwise it returns an "invite expired" error.

The **role** is chosen when the invite is created. It is carried in the **invite token payload** and used to create the employee on accept.

## Flow

```
Inviter                    FlowDesk API                         Invitee
  │  POST /invites            │                                    │
  │  { email, name, role }    │                                    │
  │──────────────────────────▶│ 1. validate body (Zod)             │
  │                           │ 2. email domain == ORG_EMAIL_DOMAIN│
  │                           │ 3. no employee with that email     │
  │                           │ 4. supersede old PENDING invite    │
  │                           │ 5. insert invite (expires +3 days) │
  │                           │ 6. sign token {inviteId,email,role}│
  │                           │ 7. emailService.send(template)  ──▶│ email with
  │◀──────────────────────────│ 201 { data: invite }               │ ${APP_BASE_URL}/invites/accept?token=…
                              │                                    │
                              │  POST /invites/accept              │
                              │  { token }                         │
                              │◀───────────────────────────────────│
                              │ 1. verify token signature          │
                              │ 2. load invite by inviteId         │
                              │ 3. status must be PENDING          │
                              │ 4. now <= expiresAt ? else 410     │
                              │ 5. tx: insert employee (email+role │
                              │    from token, name from invite)   │
                              │    + mark invite ACCEPTED          │
                              │ 201 "Successfully added" ─────────▶│
```

The link in the email points to the **frontend** (`APP_BASE_URL`). The frontend reads `token` from the query string and calls `POST /invites/accept` with it. The inviter sets the name at invite time, so the invitee doesn't enter anything. The API never takes the token as a GET side effect, so link previews and email scanners can't accept an invite by accident.

## Environment variables

Add to `.env.example`. Validate them with Zod at startup (`src/config/env.ts`) so a missing value fails fast, not on the first request.

| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `ORG_EMAIL_DOMAIN` | yes | `saajha.org.com` | The only domain allowed for invites. Compared case-insensitively, with no leading `@`. |
| `INVITE_TOKEN_SECRET` | yes | 32+ random bytes | HMAC secret used to sign invite tokens (HS256). |
| `INVITE_EXPIRY_HOURS` | no (default `72`) | `72` | Invite validity window. The requirement is 3 days. |
| `APP_BASE_URL` | yes | `http://localhost:5173` | Frontend origin used to build the invite link. |
| `MAIL_FROM` | yes | `FlowDesk <no-reply@saajha.org>` | Default sender, used when the caller doesn't pass `from`. |
| `EMAIL_TRANSPORT` | no (default `console`) | `smtp` \| `console` | `console` logs the rendered email (and link) instead of sending it. Use it for local dev. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | when `EMAIL_TRANSPORT=smtp` | | SMTP connection |

## Packages

| Package | Kind | Purpose |
| --- | --- | --- |
| `jsonwebtoken` (9.x) + `@types/jsonwebtoken` | dep / dev dep | Sign and verify the invite token (CommonJS-friendly) |
| `nodemailer` + `@types/nodemailer` | dep / dev dep | SMTP transport for the email service |

## Folder layout (new and changed)

```
src/
  config/env.ts                       NEW  Zod-validated env (ORG_EMAIL_DOMAIN, INVITE_*, MAIL_*, SMTP_*)
  db/schema/
    employeeInvites.ts                NEW  invite_status enum + employee_invites table
    index.ts                          CHANGED  export employeeInvites
  lib/
    errors.ts                         CHANGED  optional `code` on AppError; add BadRequestError, GoneError, BadGatewayError
    email/                            NEW  email service (no knowledge of invites)
      email.service.ts                sendEmail({ to, from?, template, data })
      transports.ts                   smtp (nodemailer) | console
      templates/
        index.ts                      template registry: name → render fn, typed data per template
        inviteMember.ts               subject + html + text for the invite email
  modules/invites/                    NEW
    invite.routes.ts
    invite.controller.ts
    invite.service.ts                 business rules (domain check, expiry, accept transaction)
    invite.repository.ts              createRepository(employeeInvites) + findPendingByEmail
    invite.token.ts                   signInviteToken / verifyInviteToken
    invite.validation.ts              Zod schemas (also drive the OpenAPI docs)
    invite.docs.ts                    OpenAPI paths
  docs/openapi.ts                     CHANGED  import invite.docs.ts
  docs/registry.ts                    CHANGED  `code` on the shared ErrorResponse schema
  app.ts                              CHANGED  mount invite router
drizzle/0001_create_employee_invites.sql   NEW  generated migration
```

The request flow is the same as spec 01: **route → controller (Zod) → service → repository → Drizzle**. The invite service calls the email service. The email service never imports anything from `modules/`.

## `employee_invites` table

An organisation-level table like `employees`, so it has no `programId`.

| Column | Type | Constraints |
| --- | --- | --- |
| base columns | | `id`, `created_at`, `updated_at`, `is_active` (see spec 01) |
| `email_id` | `varchar(255)` | `NOT NULL`, stored lowercased |
| `name` | `varchar(150)` | `NOT NULL`. Set by the inviter; becomes `employees.name` on accept. Added in `0002_add_invite_name`, which backfills older rows from the email's local part. |
| `role` | `employee_role` (existing enum) | `NOT NULL` |
| `status` | `invite_status` enum (`PENDING`, `ACCEPTED`, `EXPIRED`, `REVOKED`) | `NOT NULL DEFAULT 'PENDING'` |
| `expires_at` | `timestamptz` | `NOT NULL`, `created_at + INVITE_EXPIRY_HOURS` |
| `accepted_at` | `timestamptz` | nullable |
| `employee_id` | `uuid` | nullable, FK → `employees.id`. Set on accept. |

Indexes:
- `employee_invites_pending_email_unique`: a **partial unique index** on `email_id WHERE status = 'PENDING'`, so an email has at most one live invite.
- `employee_invites_email_id_idx` on `email_id`, for lookups.

Status lifecycle:

```
PENDING ──accept within window──▶ ACCEPTED
   │
   ├──accept after expires_at────▶ EXPIRED   (set when the accept attempt is rejected)
   └──re-invite same email───────▶ REVOKED   (superseded by the new invite)
```

`expires_at` is the source of truth for expiry. A `PENDING` row past `expires_at` counts as expired even if nothing has updated its status yet.

## Invite token

- Format: a JWT signed with HS256 using `INVITE_TOKEN_SECRET`.
- Payload:
  ```json
  { "inviteId": "<uuid>", "email": "jane.doe@saajha.org", "role": "MEMBER", "iat": 1760500000, "exp": 1760759200 }
  ```
  `exp` = `iat` + `INVITE_EXPIRY_HOURS`, the same instant as `expires_at`.
- `verifyInviteToken` checks the signature with `ignoreExpiration: true`. The service then compares `now` with the invite's `expires_at` itself. That way an expired link gets the specific **410 Invite expired** response and not a generic JWT error.
- The **role used to create the employee comes from the token payload**. Because the token is signed, the payload can't be tampered with. As a consistency check, the service also confirms that the payload's `email` and `role` match the stored invite row. On a mismatch it returns **400 Invalid invite token**.
- The **name** is not in the payload. It's read from the invite row, so the token stays short and links issued before `name` was added still work.
- The token is never returned by the API or stored in the DB. It only travels in the email. The DB row (looked up by `inviteId`) makes the token single-use and revocable.

## Email service (`src/lib/email/`)

A generic module: it knows about templates and transports, not about invites.

```ts
// templates/index.ts
export interface RenderedEmail { subject: string; html: string; text: string }

export const templates = {
  inviteMember: renderInviteMember, // (data: InviteMemberData) => RenderedEmail
} as const;

export type TemplateName = keyof typeof templates;
export type TemplateData<T extends TemplateName> = Parameters<(typeof templates)[T]>[0];

// email.service.ts
export async function sendEmail<T extends TemplateName>(opts: {
  to: string | string[];
  from?: string;            // sender email; defaults to env.MAIL_FROM
  template: T;
  data: TemplateData<T>;    // type-checked against the chosen template
}): Promise<{ messageId: string }>;
```

Rules:
- Templates are plain TypeScript functions, so there's no template engine dependency. Every interpolated value is HTML-escaped in `html`. Every template also produces a `text` version.
- The transport is chosen once from `EMAIL_TRANSPORT`. `console` prints `to`, `from`, `subject` and `text` (which contains the link) to stdout, so the flow can be tested without SMTP.
- Transport errors are thrown as-is. Callers decide what a failure means.

`inviteMember` template data: `{ inviteeName, inviteeEmail, role, acceptUrl, expiresAt, orgName? }`. Subject: `You're invited to join FlowDesk`. The body greets the invitee by name ("Hi Jane Doe,") and states the role, the link, and the exact expiry time ("This link expires on 18 Oct 2026, 10:00 UTC").

## API

> **Auth:** none yet. Like `/employees` (see spec 01, out of scope), anyone can call these endpoints, and the Swagger docs must say so. Once auth exists, `POST /invites` should be limited to `ADMIN`/`MANAGER`, and the inviter should be recorded (`invited_by`).

Error bodies use the shared shape from spec 01, plus a new optional, machine-readable `code`:
```json
{ "error": "Human readable message", "code": "INVITE_EXPIRED", "details": [] }
```

### `POST /invites` — invite a new member

Request:
```json
{ "email": "jane.doe@saajha.org", "name": "Jane Doe", "role": "MEMBER" }
```

Validation (Zod, `createInviteSchema`):
- `email`: required, trimmed, lowercased, valid email, max 255, and **the domain must equal `ORG_EMAIL_DOMAIN`**. The comparison is exact: `jane@sub.saajha.org` and `jane@saajha.org.evil.io` are rejected.
- `name`: required, trimmed, 1–150 chars (same rule as `employees.name`). Stored on the invite and used for the employee on accept.
- `role`: required, `ADMIN` | `MANAGER` | `MEMBER` (the existing `EmployeeRole` schema).

Business rules (service):
1. If an employee with this email already exists, including deactivated employees, return **409**.
2. If a `PENDING` invite exists for this email, mark it `REVOKED`. Re-inviting acts as a "resend", and the old link stops working.
3. Insert the invite with `expires_at = now + INVITE_EXPIRY_HOURS`. Steps 2 and 3 run in one transaction. The partial unique index catches a concurrent duplicate invite, which returns **409**.
4. Sign the token and send the `inviteMember` email to the invitee from `MAIL_FROM`.
5. If sending fails, mark the invite `REVOKED` and return **502**, so there's no live invite nobody received.

Responses:
- `201` → `{ "data": { "id", "emailId", "name", "role", "status": "PENDING", "expiresAt", "createdAt" } }` (no token)
- `400` `Validation failed`: bad body. For a domain mismatch:
  ```json
  { "error": "Validation failed",
    "details": [{ "path": "email", "message": "Invalid email: must be an @saajha.org address" }] }
  ```
- `409` `EMPLOYEE_EXISTS`: `Employee with email jane.doe@saajha.org already exists`
- `409` `INVITE_PENDING`: lost a race with a concurrent invite for the same email
- `502` `EMAIL_DELIVERY_FAILED`: `Could not send invite email`

### `POST /invites/accept` — accept an invite

Request:
```json
{ "token": "<jwt from the invite link>" }
```

Validation (Zod, `acceptInviteSchema`):
- `token`: required, non-empty string. Any other keys (e.g. a `name`) are ignored.

Business rules (service), in this order:
1. Verify the token signature. If it's malformed or the signature is bad, return **400 `INVALID_INVITE_TOKEN`**.
2. Load the invite by `inviteId`. If it isn't found, or its `email`/`role` don't match the payload, return **400 `INVALID_INVITE_TOKEN`**.
3. `status = REVOKED` → **400 `INVITE_REVOKED`** ("This invite was replaced by a newer one").
4. `status = ACCEPTED` → **409 `INVITE_ALREADY_ACCEPTED`**.
5. **Expiry check:** if `now > expires_at`, which means more than 3 days after the invite was sent, set `status = EXPIRED` and return **410 `INVITE_EXPIRED`**. `status = EXPIRED` already → the same 410.
6. Otherwise, in **one transaction**:
   - `UPDATE employee_invites SET status='ACCEPTED', accepted_at=now() WHERE id=? AND status='PENDING' RETURNING *`. If no row comes back, another request accepted it first, so return **409 `INVITE_ALREADY_ACCEPTED`**.
   - Insert the employee `{ emailId: payload.email, name: invite.name, role: payload.role }`. On a unique violation (the employee was created some other way) → **409 `EMPLOYEE_EXISTS`**, and the transaction rolls back.
   - Set `employee_id` on the invite.

Responses:
- `201` →
  ```json
  { "message": "Successfully added",
    "data": { "id", "createdAt", "updatedAt", "isActive", "emailId", "name", "role" } }
  ```
- `400` `Validation failed` / `INVALID_INVITE_TOKEN` / `INVITE_REVOKED`
- `409` `INVITE_ALREADY_ACCEPTED` / `EMPLOYEE_EXISTS`
- `410` `INVITE_EXPIRED`: `Invite link has expired. Ask for a new invite.`

> **Why 410 and not 408:** the requirement asks for a "time out" response. `408 Request Timeout` means the HTTP request itself took too long, and clients and proxies may retry it automatically. `410 Gone` is the standard status for a link that used to be valid and no longer is. The `INVITE_EXPIRED` code and the message carry the "timed out" meaning. (If you'd rather use 408, it's a one-line change, but this spec assumes 410.)

## Error classes (`src/lib/errors.ts`)

- `AppError` gets an optional `code?: string` property. The error handler includes it in the body when it's set. The shared `ErrorResponse` schema in `src/docs/registry.ts` gets an optional `code` property, which is backward compatible.
- New: `BadRequestError` (400), `GoneError` (410), `BadGatewayError` (502). `ConflictError` gets an optional `code`.

## API documentation

- `src/modules/invites/invite.docs.ts` registers both routes from the Zod schemas, using the shared error responses from `registry.ts`. It documents "no authentication" explicitly, the `ORG_EMAIL_DOMAIN` rule in the `email` description, the token payload, the 3-day window, every error `code` above, and example requests and responses for each status.
- `npm run docs:validate` must pass.

## Acceptance checklist

- [x] Migration `0001_create_employee_invites` generated, reviewed, applied
- [x] `POST /invites` with an org email → 201, and the email is logged (console transport) with a working link
- [x] `POST /invites` with `jane@gmail.com` / `jane@sub.saajha.org` → 400 invalid email
- [x] `POST /invites` for an existing employee → 409
- [x] Re-invite the same email → the old token returns 400 `INVITE_REVOKED`, and the new one works
- [x] Accept within the window → 201 "Successfully added", the employee has the invited role, the invite is `ACCEPTED`
- [x] Accept the same token again → 409
- [x] Accept after `expires_at` (test by setting `expires_at` in the past) → 410, invite `EXPIRED`, no employee created
- [x] Tampered or garbage token → 400
- [x] SMTP failure → 502, invite `REVOKED`
- [x] `npm run typecheck`, `npm run build`, `npm run docs:validate` pass

## Verified

- `npm run typecheck`, `npm run build` and `npm run docs:validate` pass. The docs check lists 6 routes, including `POST /invites` and `POST /invites/accept`.
- Migration `0001_create_employee_invites` applied to the local DB.
- Manual curl smoke test (console transport, `ORG_EMAIL_DOMAIN=saajha.org`), covering every checklist item above:
  - `@saajha.org.evil.io` and an invalid `role` → 400
  - mixed-case or padded email normalised on invite
  - invite expired by backdating `expires_at` → 410 on both attempts, invite `EXPIRED`, no employee row; a fresh re-invite then accepted → 201
  - SMTP failure tested against `127.0.0.1:1` (ECONNREFUSED)
- Test rows were removed afterwards.
- After moving `name` to `POST /invites` (2026-10-17), on a test server with `ORG_EMAIL_DOMAIN=saajha.org`:
  - typecheck, build, `docs:validate` and `db:check` pass, and migration 0002 is applied
  - a missing or blank `name` on invite → 400 on `name`
  - the invite response and the email greeting include the name
  - accept with only `{ token }` → 201, with the employee's name taken from the invite and the role from the token
  - an extra `name` in the accept body is ignored
  - a missing `token` → 400; the revoked and expired paths still return 400 and 410

## Implementation notes

- `ConflictError` signature is now `(message, code?, details?)`.
- The error body omits `details` when there are none, so a coded error looks like `{ "error": "...", "code": "..." }`.
- `RenderedEmail` lives in `src/lib/email/templates/types.ts` (re-exported from `templates/index.ts`) to avoid a circular import between the registry and the templates.
- `src/config/env.ts` treats empty values (`KEY=`) as unset.

## Out of scope / follow-ups

- Authentication and authorization on `POST /invites` (`ADMIN`/`MANAGER` only), and recording `invited_by`
- `GET /invites` (list or filter by status), `DELETE /invites/:id` (revoke), and `GET /invites/preview?token=` so the frontend can show the email and role before accepting
- Rate limiting invites per email or per inviter
- A scheduled job that marks stale `PENDING` invites `EXPIRED` (not required, since accept checks `expires_at`)
- Multiple allowed org domains (`ORG_EMAIL_DOMAIN` is a single domain for now)
- Automated tests (still no test runner)
