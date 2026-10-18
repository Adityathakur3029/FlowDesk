import { z } from "zod";
import {
  authNote,
  bearerSecurity,
  errorResponseSchema,
  forbiddenResponse,
  internalServerErrorResponse,
  jsonResponse,
  paginationMetaSchema,
  registry,
  unauthorizedResponse,
  validationErrorResponseSchema,
} from "../../docs/registry";
import { employeeRole } from "../../db/schema";
import {
  createEmployeeSchema,
  employeeIdParamSchema,
  listEmployeesQuerySchema,
  updateEmployeeSchema,
} from "./employee.validation";

export const exampleEmployee = {
  id: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0",
  createdAt: "2026-10-15T14:13:43.757Z",
  updatedAt: "2026-10-15T14:13:43.757Z",
  isActive: true,
  emailId: "jane.doe@saajha.org",
  name: "Jane Doe",
  role: "MANAGER",
  teamId: null,
};

// Mirrors toEmployeeDto in employee.dto.ts (internal columns like google_sub are not returned)
export const employeeSchema = registry.register(
  "Employee",
  z
    .object({
      id: z.uuid(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      isActive: z.boolean().meta({ description: "false once the employee is deactivated (soft-deleted)" }),
      emailId: z.email().meta({ description: "Lowercased organisation email" }),
      name: z.string(),
      role: z.enum(employeeRole.enumValues),
      teamId: z.uuid().nullable().meta({ description: "The employee's team; null when not in a team. An employee is in at most one team." }),
    })
    .meta({ example: exampleEmployee }),
);

const employeeEnvelopeSchema = registry.register(
  "EmployeeResponse",
  z.object({ data: employeeSchema }),
);

const employeeListSchema = registry.register(
  "EmployeeListResponse",
  z.object({ data: z.array(employeeSchema), meta: paginationMetaSchema }),
);

registry.registerPath({
  method: "post",
  path: "/employees",
  tags: ["Employees"],
  summary: "Create (seed) an employee",
  description:
    "Creates one employee. `email` is trimmed and lowercased before the uniqueness check, so emails are unique regardless of case. " +
    "Emails of deactivated employees are taken too.\n\n" +
    "Note: an employee created here has no invite, so they can't sign in until they're invited and accept. " +
    "Prefer `POST /invites` for new members.\n\n" +
    "**Headers:** `Content-Type: application/json` is required for the body to be parsed.\n\n" +
    authNote("ADMIN"),
  security: bearerSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createEmployeeSchema,
          example: { email: "  Jane.Doe@saajha.org ", name: "Jane Doe", role: "MANAGER" },
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Employee created", employeeEnvelopeSchema, { data: exampleEmployee }),
    400: jsonResponse(
      "The body is missing, is not valid JSON, or breaks a validation rule: `email` must be a valid email of at most 255 characters, " +
        "`name` 1-150 characters after trimming, and `role` one of ADMIN, MANAGER or MEMBER. Every failing field is listed in `details`.",
      validationErrorResponseSchema,
      {
        error: "Validation failed",
        details: [
          { path: "email", message: "Invalid email address" },
          { path: "name", message: "Too small: expected string to have >=1 characters" },
          { path: "role", message: 'Invalid option: expected one of "ADMIN"|"MANAGER"|"MEMBER"' },
        ],
      },
    ),
    401: unauthorizedResponse,
    403: forbiddenResponse,
    409: jsonResponse(
      "`EMPLOYEE_EXISTS`: an employee with this email already exists (including deactivated employees)",
      errorResponseSchema,
      { error: "Employee with email jane.doe@saajha.org already exists", code: "EMPLOYEE_EXISTS" },
    ),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/employees",
  tags: ["Employees"],
  summary: "List and search employees",
  description:
    "Returns employees one page at a time. Deactivated employees are excluded unless `includeInactive=true`. " +
    "All filters (`q`, `role`, `teamId`, `includeInactive`) combine with AND, and `meta.total` counts the matching rows.\n\n" +
    "**Search (`q`):** trimmed, then matched as a case-insensitive substring of `name` **or** `emailId`. " +
    "`%`, `_` and `\\` match literally. There's no accent folding or fuzzy matching. " +
    "Built for type-ahead pickers, e.g. `?q=jan&limit=10`.\n\n" +
    "**Order:**\n" +
    "- without `q`: newest first (`createdAt` descending), as before\n" +
    "- with `q`: by match quality, then by name ignoring case, then by `id`. Match quality, best first: " +
    "(1) name or email equal to `q`; (2) name starting with `q`, a word in the name (after a space) starting with `q`, " +
    "or email starting with `q`; (3) any other match. For `q=jan`: `Jan`, then `Ana Janssen` and `Janet King`, then `Benjamin Ojanen`.\n\n" +
    authNote(),
  security: bearerSecurity,
  request: { query: listEmployeesQuerySchema },
  responses: {
    200: jsonResponse("A page of employees", employeeListSchema, {
      data: [exampleEmployee],
      meta: { total: 1, limit: 10, offset: 0 },
    }),
    400: {
      description:
        "Invalid query parameter: `q` empty after trimming or longer than 100 characters, unknown `role`, " +
        "`teamId` not a UUID or `none`, a non-boolean `includeInactive`, `limit` outside 1-100, or a negative `offset`",
      content: {
        "application/json": {
          schema: validationErrorResponseSchema,
          examples: {
            emptyQ: { value: { error: "Validation failed", details: [{ path: "q", message: "Too small: expected string to have >=1 characters" }] } },
            limit: { value: { error: "Validation failed", details: [{ path: "limit", message: "Too big: expected number to be <=100" }] } },
          },
        },
      },
    },
    401: unauthorizedResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/employees/{id}",
  tags: ["Employees"],
  summary: "Get an employee by id",
  description:
    "Returns one active employee. A deactivated employee returns 404: read them with `GET /employees?includeInactive=true`, " +
    `and reactivate them with \`PATCH /employees/{id}\`.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: employeeIdParamSchema },
  responses: {
    200: jsonResponse("The employee", employeeEnvelopeSchema, { data: exampleEmployee }),
    400: jsonResponse("`id` is not a valid UUID", validationErrorResponseSchema, {
      error: "Validation failed",
      details: [{ path: "id", message: "Invalid UUID" }],
    }),
    401: unauthorizedResponse,
    404: jsonResponse("No active employee with this id", errorResponseSchema, { error: "Employee not found" }),
    500: internalServerErrorResponse,
  },
});

const conflict = (description: string, examples: Record<string, { error: string; code: string }>) => ({
  description,
  content: {
    "application/json": {
      schema: errorResponseSchema,
      examples: Object.fromEntries(Object.entries(examples).map(([name, value]) => [name, { value }])),
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/employees/{id}",
  tags: ["Employees"],
  summary: "Update an employee",
  description:
    "Changes an employee's `name`, `role` and/or `isActive`. At least one field is required; unknown fields are rejected. " +
    "`email` can't be changed (it's bound to the Google account), and teams change through " +
    "`PUT` / `DELETE /teams/{teamId}/members/{employeeId}`, so `teamId` is rejected too. " +
    "Inactive employees are found as well, so `{ \"isActive\": true }` reactivates one.\n\n" +
    "**Rules, in order:**\n" +
    "1. No employee, active or not, has this `id` → 404.\n" +
    "2. You can't deactivate yourself or change your own role → 409 `SELF_LOCKOUT`. Renaming yourself is allowed.\n" +
    "3. The change would leave no active ADMIN → 409 `LAST_ADMIN`. Concurrent demotions are serialised, so two admins " +
    "demoting each other at the same moment can't both succeed.\n" +
    "4. Idempotent: if every sent field already has that value, nothing is written (`updatedAt` doesn't change) and the employee is returned with 200.\n\n" +
    "**Deactivating** (`isActive: false`): the employee's existing access tokens stop working on their next request " +
    "(401 `INVALID_AUTH_TOKEN`), and signing in again gives 403 `ACCOUNT_INACTIVE`. They keep their `teamId` but leave the team's " +
    "member list and `memberCount`; reactivating them puts them back. Their tasks keep them as assignee or reporter, and their comments " +
    "and mentions stay. They can't be newly assigned (`ASSIGNEE_NOT_FOUND`) or mentioned (`MENTION_NOT_FOUND`).\n\n" +
    "**Changing a role:** roles are read from the database on every request, not from the token, so the new role applies " +
    "to the employee's next request (including `GET /auth/me`) without signing in again.\n\n" +
    "**Headers:** `Content-Type: application/json` is required for the body to be parsed.\n\n" +
    authNote("ADMIN"),
  security: bearerSecurity,
  request: {
    params: employeeIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateEmployeeSchema, example: { name: "Jane Smith", role: "ADMIN" } } },
    },
  },
  responses: {
    200: jsonResponse("The employee after the update (unchanged if nothing differed)", employeeEnvelopeSchema, {
      data: { ...exampleEmployee, name: "Jane Smith", role: "ADMIN", updatedAt: "2026-10-18T10:00:00.000Z" },
    }),
    400: {
      description:
        "Invalid `id`, an empty body, an unknown field (such as `email` or `teamId`), a `null`, or a field breaking its rule: " +
        "`name` 1-150 characters after trimming, `role` one of ADMIN, MANAGER or MEMBER, `isActive` a JSON boolean. " +
        "Also returned for a body that isn't valid JSON (`Malformed JSON body`).",
      content: {
        "application/json": {
          schema: validationErrorResponseSchema,
          examples: {
            empty: { value: { error: "Validation failed", details: [{ path: "", message: "At least one field is required" }] } },
            unknownField: { value: { error: "Validation failed", details: [{ path: "", message: 'Unrecognized key: "email"' }] } },
            name: { value: { error: "Validation failed", details: [{ path: "name", message: "Too small: expected string to have >=1 characters" }] } },
          },
        },
      },
    },
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: jsonResponse("No employee, active or inactive, has this id", errorResponseSchema, { error: "Employee not found" }),
    409: conflict(
      "`SELF_LOCKOUT`: you tried to deactivate yourself or change your own role. " +
        "`LAST_ADMIN`: the change would demote or deactivate the last active ADMIN.",
      {
        selfDeactivate: { error: "You can't deactivate your own account", code: "SELF_LOCKOUT" },
        selfRole: { error: "You can't change your own role", code: "SELF_LOCKOUT" },
        lastAdmin: { error: "At least one active ADMIN must remain", code: "LAST_ADMIN" },
      },
    ),
    500: internalServerErrorResponse,
  },
});
