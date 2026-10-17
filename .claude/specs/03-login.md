# 03 — Login with Google (authentication + authorization)

**Status:** Planned
**Branch:** `login`
**Depends on:** [01-db-setup](./01-db-setup.md) (`employees` table, repository, error handler, OpenAPI setup), [02-invite-member](./02-invite-member.md) (`employee_invites`, `ACCEPTED` status, `src/config/env.ts`, `AppError.code`)

## Goal

Let organisation members sign in with their Google account. A login passes two separate checks:

1. **Authentication: who are you?** Google verifies the user's identity. The backend verifies Google's **ID token**, makes sure it is valid and was issued for FlowDesk, and extracts the **verified email** and the **Google user ID** (`sub`).
2. **Authorization: are you allowed?** The backend checks the database. The user must have an **accepted invitation** and an **active account**.

**Access granted:** if both checks pass, the backend issues a **JWT access token**. Otherwise it denies access.

This spec also adds the `requireAuth` / `requireRole` middleware and uses it to protect the existing `/employees` and `/invites` routes.

## Flow

```
Browser / Frontend          Google                      FlowDesk API
  │  Sign in with Google      │                              │
  │──────────────────────────▶│                              │
  │◀──────────────────────────│ credential (ID token, JWT)   │
  │                                                          │
  │  POST /auth/google { idToken }                           │
  │─────────────────────────────────────────────────────────▶│
  │                                                          │ ── 1. AUTHENTICATION ──────────────────
  │                                                          │ a. verifyIdToken(idToken,
  │                                                          │      audience = GOOGLE_CLIENT_ID)
  │                                                          │    (signature via Google certs, iss, aud, exp)
  │                                                          │ b. email_verified === true
  │                                                          │ c. email domain == ORG_EMAIL_DOMAIN
  │                                                          │    (and `hd`, if present, matches too)
  │                                                          │ d. extract { sub, email (lowercased) }
  │                                                          │ ── 2. AUTHORIZATION (DB) ──────────────
  │                                                          │ a. employee by email_id      else 403
  │                                                          │ b. ACCEPTED invite for that
  │                                                          │    employee                  else 403
  │                                                          │ c. employee.is_active        else 403
  │                                                          │ d. google_sub: null → store sub
  │                                                          │    set and ≠ sub             → 403
  │                                                          │ ── ACCESS GRANTED ─────────────────────
  │                                                          │ sign access JWT { sub: employeeId, … }
  │◀─────────────────────────────────────────────────────────│ 200 { data: { accessToken, … } }
  │                                                          │
  │  GET /employees   Authorization: Bearer <accessToken>    │
  │─────────────────────────────────────────────────────────▶│ requireAuth → requireRole → controller
```

The frontend gets the ID token from **Google Identity Services** ("Sign in with Google", the `credential` field of the callback) using the same `GOOGLE_CLIENT_ID`. The backend never sees a Google password or an OAuth authorization code. It only verifies the ID token.

## Environment variables

Add these to `.env.example` and to the Zod schema in `src/config/env.ts`, so the app fails at startup when one is missing.

| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | `1234-abc.apps.googleusercontent.com` | The OAuth 2.0 Web client ID. The ID token's `aud` must equal it. |
| `AUTH_JWT_SECRET` | yes, min 32 chars | 32+ random bytes | HMAC secret for the access JWT (HS256). Must be different from `INVITE_TOKEN_SECRET`. |
| `AUTH_JWT_EXPIRES_IN` | no (default `8h`) | `8h` | Access token lifetime, in `jsonwebtoken` `expiresIn` format |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_NAME` | only for `npm run auth:bootstrap-admin` | `admin@saajha.org` / `Admin` | First-admin bootstrap (see below). Read by the script, not by the server. |

`ORG_EMAIL_DOMAIN` (from spec 02) is reused for the login domain check.

## Packages

| Package | Kind | Purpose |
| --- | --- | --- |
| `google-auth-library` | dep | `OAuth2Client.verifyIdToken`. It fetches and caches Google's signing certs and checks the signature, `iss`, `aud` and `exp`. |
| `jsonwebtoken` | dep (already installed) | Sign and verify the FlowDesk access token |

## Folder layout (new and changed)

```
src/
  config/env.ts                       CHANGED  GOOGLE_CLIENT_ID, AUTH_JWT_SECRET, AUTH_JWT_EXPIRES_IN
  db/schema/employees.ts              CHANGED  google_sub column
  lib/errors.ts                       CHANGED  UnauthorizedError (401), ForbiddenError (403)
  middleware/auth.ts                  NEW  requireAuth, requireRole(...roles)
  types/express.d.ts                  NEW  augments Request with `auth?: AuthContext`
  modules/auth/                       NEW
    auth.routes.ts
    auth.controller.ts
    auth.service.ts                   login rules (authentication + authorization)
    google.verifier.ts                verifyGoogleIdToken(idToken) → { sub, email, emailVerified, hd? }
    auth.token.ts                     signAccessToken / verifyAccessToken
    auth.validation.ts                Zod schemas (also drive the OpenAPI docs)
    auth.docs.ts                      OpenAPI paths
  modules/employees/
    employee.repository.ts            CHANGED  setGoogleSub(id, sub)
    employee.routes.ts                CHANGED  requireAuth / requireRole
    employee.docs.ts                  CHANGED  security + roles
  modules/invites/
    invite.repository.ts              CHANGED  hasAcceptedInvite(employeeId)
    invite.routes.ts                  CHANGED  requireAuth / requireRole on POST /
    invite.docs.ts                    CHANGED  security + roles
  scripts/bootstrapAdmin.ts           NEW  creates the first ADMIN + an ACCEPTED invite
  docs/registry.ts                    CHANGED  bearerAuth scheme, Unauthorized/Forbidden responses, new codes
  docs/openapi.ts                     CHANGED  import auth.docs.ts
  app.ts                              CHANGED  mount /auth in routeModules
drizzle/0003_add_employee_google_sub.sql   NEW  generated migration
package.json                          CHANGED  "auth:bootstrap-admin" script
```

The request flow is the same as in spec 01: **route → (auth middleware) → controller (Zod) → service → repository → Drizzle**. The auth service uses the employee and invite repositories and never calls Drizzle directly. `google.verifier.ts` is the only file that imports `google-auth-library`, so it's easy to stub in tests later.

## Schema change: `employees.google_sub`

| Column | Type | Constraints |
| --- | --- | --- |
| `google_sub` | `varchar(255)` | nullable, `UNIQUE` (`employees_google_sub_unique`) |

- The column stays `NULL` until the employee's first successful login, which **binds** it to the Google account's `sub`.
- From then on, a login must present the same `sub`. If the Google account behind an email changes (the account is deleted and re-created, or someone else signs in under the same address), the login is rejected. An admin can reset the column to `NULL`.
- `sub` is Google's stable user ID. Emails can be reassigned, `sub` values can't.

Migration: `npm run db:generate -- --name add_employee_google_sub` → `drizzle/0003_add_employee_google_sub.sql`.

## Login rules (`POST /auth/google`)

### Step 1: Authentication (Google)

`verifyGoogleIdToken(idToken)` calls `OAuth2Client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID })`.

| Check | Failure |
| --- | --- |
| The token is well-formed, the signature is valid, `iss` is `accounts.google.com` / `https://accounts.google.com`, `aud` equals `GOOGLE_CLIENT_ID`, it hasn't expired | **401 `INVALID_GOOGLE_TOKEN`** |
| `email_verified === true` | **401 `GOOGLE_EMAIL_NOT_VERIFIED`** |
| The lowercased email's domain equals `ORG_EMAIL_DOMAIN` (exact match, as in spec 02), and `hd`, when present, equals it too | **401 `EMAIL_DOMAIN_NOT_ALLOWED`** |
| Google's cert endpoint can't be reached | **502 `GOOGLE_UNAVAILABLE`** |

Output: `{ sub, email }`, where `email` is lowercased. Nothing else from the Google token is trusted or stored. The Google ID token itself is never stored or logged.

### Step 2: Authorization (database)

Applied in this order:

1. Look up the employee by `email_id`, **including inactive employees**. Not found → **403 `NOT_INVITED`** ("You have not been invited to FlowDesk").
2. `inviteRepository.hasAcceptedInvite(employee.id)`: there must be an `employee_invites` row with `status = 'ACCEPTED'` and `employee_id = employee.id`. If there isn't one → **403 `NOT_INVITED`**.
3. `employee.is_active = false` → **403 `ACCOUNT_INACTIVE`** ("Your account has been deactivated").
4. Google account binding:
   - `google_sub IS NULL` → `UPDATE employees SET google_sub = :sub WHERE id = :id AND google_sub IS NULL`. If that hits a unique violation (this Google account is already linked to another employee) → **403 `GOOGLE_ACCOUNT_MISMATCH`**. If it updates no row because a concurrent first login set the column, re-read it and apply the next rule.
   - `google_sub` is set and `≠ sub` → **403 `GOOGLE_ACCOUNT_MISMATCH`**.

> **Consequence:** an employee created directly through `POST /employees`, without an invite, **can't log in**. That's intended, because the rule is "accepted invitation **and** active account". Use the invite flow, or the bootstrap script for the first admin.

### Access granted

Sign the access token and return:

```json
{
  "data": {
    "accessToken": "<jwt>",
    "tokenType": "Bearer",
    "expiresIn": 28800,
    "employee": { "id", "createdAt", "updatedAt", "isActive", "emailId", "name", "role" }
  }
}
```

`expiresIn` is in seconds. `googleSub` is never returned.

## Access token (`auth.token.ts`)

- Format: a JWT signed with HS256 using `AUTH_JWT_SECRET`, with `expiresIn` set from `AUTH_JWT_EXPIRES_IN`.
- Payload:
  ```json
  { "sub": "<employee uuid>", "email": "jane.doe@saajha.org", "role": "MEMBER", "iat": 1760500000, "exp": 1760528800 }
  ```
- `verifyAccessToken` verifies the signature and expiry, and pins `algorithms: ["HS256"]`.
- Stateless: there's no session table. Logout happens on the client (it discards the token). Server-side revocation is out of scope. Deactivation still takes effect immediately, because `requireAuth` re-checks the DB (see below).

## Middleware (`src/middleware/auth.ts`)

```ts
export interface AuthContext { employeeId: string; email: string; role: EmployeeRole }

export const requireAuth: RequestHandler;                       // sets req.auth
export function requireRole(...roles: EmployeeRole[]): RequestHandler; // use after requireAuth
```

`requireAuth`:
1. Reads `Authorization: Bearer <token>`. A missing or malformed header → **401 `AUTH_REQUIRED`**.
2. Runs `verifyAccessToken`. A bad signature or an expired token → **401 `INVALID_AUTH_TOKEN`**.
3. Reloads the employee by `sub`. If it's missing or `is_active = false` → **401 `INVALID_AUTH_TOKEN`**.
4. Sets `req.auth` from the **DB row**. The DB role is used, not the token's, so role changes and deactivation apply on the next request.

`requireRole(...roles)`: if `req.auth.role` isn't in `roles` → **403 `FORBIDDEN`** ("You do not have permission to perform this action").

Both pass errors to `next()` so the existing `errorHandler` formats them.

## API

Error bodies use the shared shape from spec 02: `{ "error": "...", "code": "..." }`.

### `POST /auth/google`: log in with a Google ID token

**Auth:** none (this is how a user gets a token).

Request:
```json
{ "idToken": "<Google ID token from Google Identity Services>" }
```

Validation (Zod, `googleLoginSchema`):
- `idToken`: required, trimmed, non-empty string.

Responses:
- `200`: the body shown under **Access granted**
- `400` `Validation failed`: missing or empty `idToken`
- `401` `INVALID_GOOGLE_TOKEN` / `GOOGLE_EMAIL_NOT_VERIFIED` / `EMAIL_DOMAIN_NOT_ALLOWED`
- `403` `NOT_INVITED` / `ACCOUNT_INACTIVE` / `GOOGLE_ACCOUNT_MISMATCH`
- `502` `GOOGLE_UNAVAILABLE`

### `GET /auth/me`: current user

**Auth:** Bearer token, any role.

Responses:
- `200` → `{ "data": { "id", "createdAt", "updatedAt", "isActive", "emailId", "name", "role" } }`
- `401` `AUTH_REQUIRED` / `INVALID_AUTH_TOKEN`

### Route protection (access matrix)

| Route | Auth | Roles |
| --- | --- | --- |
| `POST /auth/google` | none | – |
| `GET /auth/me` | Bearer | any |
| `GET /employees`, `GET /employees/:id` | Bearer | any |
| `POST /employees` | Bearer | `ADMIN` |
| `POST /invites` | Bearer | `ADMIN`, `MANAGER` |
| `POST /invites/accept` | none (the invitee has no account yet) | – |
| `/health-check`, `/docs`, `/openapi.json` | none | – |

## First-admin bootstrap

Once the routes are protected, nobody can create the first invite. `npm run auth:bootstrap-admin` (`tsx src/scripts/bootstrapAdmin.ts`) reads `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_NAME`. The email must be in `ORG_EMAIL_DOMAIN`. In **one transaction**, the script:

- creates the employee with role `ADMIN`, or reuses an existing employee with that email and promotes it to `ADMIN`
- inserts an `employee_invites` row with `status = 'ACCEPTED'`, `accepted_at = now()`, `expires_at = now()` and `employee_id` set

The script is idempotent. Running it again for an admin who already has an accepted invite does nothing.

## Error classes (`src/lib/errors.ts`)

New, following the `GoneError` pattern:
- `UnauthorizedError(message, code?)` → 401
- `ForbiddenError(message, code?)` → 403

Add the new codes to the `ErrorResponse.code` description in `src/docs/registry.ts`: `AUTH_REQUIRED`, `INVALID_AUTH_TOKEN`, `FORBIDDEN`, `INVALID_GOOGLE_TOKEN`, `GOOGLE_EMAIL_NOT_VERIFIED`, `EMAIL_DOMAIN_NOT_ALLOWED`, `NOT_INVITED`, `ACCOUNT_INACTIVE`, `GOOGLE_ACCOUNT_MISMATCH`, `GOOGLE_UNAVAILABLE`.

## API documentation

- `registry.ts`:
  - register a `bearerAuth` security scheme (`type: http`, `scheme: bearer`, `bearerFormat: JWT`) whose description says the token comes from `POST /auth/google`
  - add shared `Unauthorized` (401) and `Forbidden` (403) responses, with examples
- `auth.docs.ts`:
  - documents both routes from the Zod schemas
  - describes the Google OAuth flow: the frontend gets the ID token from Google Identity Services using `GOOGLE_CLIENT_ID`, the token's `aud` must match, `email_verified` is required, the `ORG_EMAIL_DOMAIN` rule applies, and the first login binds `google_sub`
  - documents both authorization checks (accepted invite, active account), every error `code`, and examples for each status
- `employee.docs.ts` / `invite.docs.ts`:
  - replace the "no authentication" wording with `security: [{ bearerAuth: [] }]`, the required roles from the access matrix, and the shared 401/403 responses
  - `POST /invites/accept` stays documented as public
- `npm run docs:validate` must pass.

## Acceptance checklist

- [ ] Migration `0003_add_employee_google_sub` generated, reviewed, applied
- [ ] A valid Google ID token for an employee who accepted an invite and is active → 200 with an access token, and `google_sub` stored
- [ ] Log in again with the same Google account → 200. Log in with a different Google account for the same email (different `sub`) → 403 `GOOGLE_ACCOUNT_MISMATCH`
- [ ] A garbage, expired or wrong-audience ID token → 401 `INVALID_GOOGLE_TOKEN`
- [ ] `email_verified = false` → 401 `GOOGLE_EMAIL_NOT_VERIFIED`. A Google account outside `ORG_EMAIL_DOMAIN` → 401 `EMAIL_DOMAIN_NOT_ALLOWED`
- [ ] An email with no employee, or an employee with no accepted invite (created through `POST /employees`) → 403 `NOT_INVITED`
- [ ] A deactivated employee → 403 `ACCOUNT_INACTIVE` on login, and a token issued earlier → 401 on `GET /auth/me`
- [ ] `GET /employees` with no token → 401 `AUTH_REQUIRED`. A tampered token → 401 `INVALID_AUTH_TOKEN`
- [ ] `POST /employees` as a `MANAGER` or `MEMBER` → 403 `FORBIDDEN`, and as an `ADMIN` → 201
- [ ] `POST /invites` as a `MEMBER` → 403, and as a `MANAGER` → 201
- [ ] `POST /invites/accept` still works without a token
- [ ] `npm run auth:bootstrap-admin` creates an admin who can log in, and running it again is a no-op
- [ ] `npm run typecheck`, `npm run build`, `npm run docs:validate` pass

## Testing notes

- There's no frontend yet. To get a real ID token for the configured client, use a minimal static page with the Google Identity Services button (served from an origin listed in the OAuth client's "Authorized JavaScript origins") that logs `response.credential`. The OAuth 2.0 Playground also works if it's configured to use your own client ID. Paste the token into `POST /auth/google` from Swagger UI.
- To test the authorization failure paths without extra Google accounts, change the DB: delete or revoke the invite, set `is_active = false`, or set `google_sub` to another value.

## Out of scope / follow-ups

- Refresh tokens, server-side revocation and a logout endpoint
- httpOnly cookie transport and CSRF handling
- Recording `invited_by` on `POST /invites` (now possible through `req.auth`)
- Deactivating or reactivating employees through the API, and an admin endpoint to unlink `google_sub`
- Other identity providers
- Rate limiting login attempts
- Program-level permissions (per-program membership and roles)
- Automated tests (there's still no test runner)
