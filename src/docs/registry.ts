import { extendZodWithOpenApi, OpenAPIRegistry, type ResponseConfig } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Adds .openapi() to Zod schemas; registry.register() relies on it
extendZodWithOpenApi(z);

// Single registry every module's *.docs.ts adds its routes to
export const registry = new OpenAPIRegistry();

// ---- Shared schemas ----

export const errorResponseSchema = registry.register(
  "ErrorResponse",
  z
    .object({
      error: z.string().meta({ description: "Human-readable error message" }),
      code: z.string().optional().meta({
        description:
          "Machine-readable error code, present on errors that have one: INVALID_INVITE_TOKEN, INVITE_REVOKED, " +
          "INVITE_ALREADY_ACCEPTED, INVITE_PENDING, INVITE_EXPIRED, EMPLOYEE_EXISTS, EMAIL_DELIVERY_FAILED, " +
          "AUTH_REQUIRED, INVALID_AUTH_TOKEN, FORBIDDEN, INVALID_GOOGLE_TOKEN, GOOGLE_EMAIL_NOT_VERIFIED, " +
          "EMAIL_DOMAIN_NOT_ALLOWED, NOT_INVITED, ACCOUNT_INACTIVE, GOOGLE_ACCOUNT_MISMATCH, GOOGLE_UNAVAILABLE, " +
          "PROGRAM_KEY_EXISTS, ASSIGNEE_NOT_FOUND, INVALID_DATE_RANGE, TASK_BLOCKED, TASK_DONE, DEPENDENCY_TASK_NOT_FOUND, " +
          "DEPENDENCY_OTHER_PROGRAM, SELF_DEPENDENCY, DEPENDENCY_EXISTS, DEPENDENCY_LIMIT_REACHED, DEPENDENCY_CYCLE, " +
          "PARENT_COMMENT_NOT_FOUND, PARENT_TARGET_MISMATCH, NESTED_REPLY, TOO_MANY_MENTIONS, MENTION_NOT_FOUND, " +
          "TEAM_NAME_EXISTS, TEAM_OWNS_PROGRAMS, OWNER_TEAM_NOT_FOUND, SELF_LOCKOUT, LAST_ADMIN, DATE_RANGE_TOO_LONG",
        example: "INVITE_EXPIRED",
      }),
      details: z.unknown().optional().meta({
        description: "Extra context on some errors, e.g. the open blockers on TASK_BLOCKED or the owned programs on TEAM_OWNS_PROGRAMS",
        example: { blockers: [{ id: "0e6c1f2a-4b8d-4c3e-9f7a-1d2b3c4d5e6f", key: "MKT-3", title: "Finalise sample", status: "IN_PROGRESS" }] },
      }),
    })
    .meta({
      description:
        "Error body returned by the error middleware for non-validation errors (e.g. 400 with a `code`, 401, 403, 404, 409, 410, 500, 502)",
      example: { error: "Employee not found" },
    }),
);

export const validationIssueSchema = registry.register(
  "ValidationIssue",
  z.object({
    path: z.string().meta({
      description: "Dot-separated path of the invalid field; empty string when the whole input is invalid",
      example: "email",
    }),
    message: z.string().meta({ example: "Invalid email address" }),
  }),
);

export const validationErrorResponseSchema = registry.register(
  "ValidationErrorResponse",
  z
    .object({
      error: z.string().meta({
        description: '"Validation failed" for schema violations, "Malformed JSON body" when the body cannot be parsed',
      }),
      details: z.array(validationIssueSchema),
    })
    .meta({
      description: "400 body for invalid path params, query params or request body",
      example: { error: "Validation failed", details: [{ path: "email", message: "Invalid email address" }] },
    }),
);

export const paginationMetaSchema = registry.register(
  "PaginationMeta",
  z.object({
    total: z.number().int().meta({ description: "Total rows matching the filters", example: 42 }),
    limit: z.number().int().meta({ description: "Page size used", example: 20 }),
    offset: z.number().int().meta({ description: "Rows skipped", example: 0 }),
  }),
);

export const employeeSummarySchema = registry.register(
  "EmployeeSummary",
  z
    .object({
      id: z.uuid(),
      name: z.string(),
      emailId: z.email(),
    })
    .meta({
      description: "Short form of an employee, embedded in other resources",
      example: { id: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0", name: "Jane Doe", emailId: "jane.doe@saajha.org" },
    }),
);

// ---- Shared responses ----

const errorRef = { $ref: "#/components/schemas/ErrorResponse" };

registry.registerComponent("responses", "InternalServerError", {
  description: "Unexpected server error. Details are logged server-side, not returned.",
  content: {
    "application/json": { schema: errorRef, example: { error: "Internal server error" } },
  },
});

export const internalServerErrorResponse = { $ref: "#/components/responses/InternalServerError" };

registry.registerComponent("responses", "Unauthorized", {
  description:
    "`AUTH_REQUIRED`: no `Authorization: Bearer <token>` header. " +
    "`INVALID_AUTH_TOKEN`: the access token is malformed, has a bad signature or has expired, " +
    "or its employee no longer exists or has been deactivated. Sign in again with `POST /auth/google`.",
  content: {
    "application/json": {
      schema: errorRef,
      examples: {
        authRequired: { value: { error: "Authentication required", code: "AUTH_REQUIRED" } },
        invalidToken: { value: { error: "Invalid or expired access token", code: "INVALID_AUTH_TOKEN" } },
      },
    },
  },
});

export const unauthorizedResponse = { $ref: "#/components/responses/Unauthorized" };

registry.registerComponent("responses", "Forbidden", {
  description: "`FORBIDDEN`: the signed-in employee's role is not allowed to call this endpoint.",
  content: {
    "application/json": {
      schema: errorRef,
      example: { error: "You do not have permission to perform this action", code: "FORBIDDEN" },
    },
  },
});

export const forbiddenResponse = { $ref: "#/components/responses/Forbidden" };

// ---- Security ----

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description:
    "FlowDesk access token (HS256 JWT) returned by `POST /auth/google` after signing in with Google. " +
    "Send it as `Authorization: Bearer <accessToken>`.",
});

// Operation-level security for endpoints that need a signed-in employee
export const bearerSecurity = [{ bearerAuth: [] }];

// ---- Helpers ----

// JSON response with a schema and a concrete example
export function jsonResponse(description: string, schema: z.ZodType, example: unknown): ResponseConfig {
  return { description, content: { "application/json": { schema, example } } };
}

// Shown in the description of public operations
export const PUBLIC_ACCESS_NOTE =
  "**Authentication:** none, the endpoint is public.\n\n**Authorization / roles:** none required.";

// Shown in the description of protected operations; no roles means any signed-in employee
export function authNote(...roles: string[]): string {
  const rolesText = roles.length
    ? `${roles.join(" or ")} only; other roles get 403 \`FORBIDDEN\`.`
    : "any active employee.";
  return (
    "**Authentication:** required. Send `Authorization: Bearer <accessToken>` (from `POST /auth/google`, Google sign-in).\n\n" +
    `**Authorization / roles:** ${rolesText}`
  );
}
