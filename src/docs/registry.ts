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
          "INVITE_ALREADY_ACCEPTED, INVITE_PENDING, INVITE_EXPIRED, EMPLOYEE_EXISTS, EMAIL_DELIVERY_FAILED",
        example: "INVITE_EXPIRED",
      }),
    })
    .meta({
      description:
        "Error body returned by the error middleware for non-validation errors (e.g. 400 with a `code`, 404, 409, 410, 500, 502)",
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

// ---- Shared responses ----

const errorRef = { $ref: "#/components/schemas/ErrorResponse" };

registry.registerComponent("responses", "InternalServerError", {
  description: "Unexpected server error. Details are logged server-side, not returned.",
  content: {
    "application/json": { schema: errorRef, example: { error: "Internal server error" } },
  },
});

export const internalServerErrorResponse = { $ref: "#/components/responses/InternalServerError" };

// ---- Helpers ----

// JSON response with a schema and a concrete example
export function jsonResponse(description: string, schema: z.ZodType, example: unknown): ResponseConfig {
  return { description, content: { "application/json": { schema, example } } };
}

// Shown in each operation description until auth exists
export const PUBLIC_ACCESS_NOTE =
  "**Authentication:** none, the endpoint is public.\n\n**Authorization / roles:** none required.";
