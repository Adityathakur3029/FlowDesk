import { z } from "zod";
import {
  errorResponseSchema,
  internalServerErrorResponse,
  jsonResponse,
  paginationMetaSchema,
  PUBLIC_ACCESS_NOTE,
  registry,
  validationErrorResponseSchema,
} from "../../docs/registry";
import { employeeRole } from "../../db/schema";
import { createEmployeeSchema, employeeIdParamSchema, listEmployeesQuerySchema } from "./employee.validation";

const exampleEmployee = {
  id: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0",
  createdAt: "2026-10-15T14:13:43.757Z",
  updatedAt: "2026-10-15T14:13:43.757Z",
  isActive: true,
  emailId: "jane.doe@acme.com",
  name: "Jane Doe",
  role: "MANAGER",
};

// Mirrors the `employees` row returned by the repository (see src/db/schema/employees.ts)
const employeeSchema = registry.register(
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
    "**Headers:** `Content-Type: application/json` is required for the body to be parsed.\n\n" +
    PUBLIC_ACCESS_NOTE,
  security: [],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createEmployeeSchema,
          example: { email: "  Jane.Doe@ACME.com ", name: "Jane Doe", role: "MANAGER" },
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
    409: jsonResponse("An employee with this email already exists", errorResponseSchema, {
      error: "Employee with email jane.doe@acme.com already exists",
    }),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/employees",
  tags: ["Employees"],
  summary: "List employees",
  description:
    "Returns employees newest first (`createdAt` descending), one page at a time. Deactivated employees are excluded unless `includeInactive=true`.\n\n" +
    PUBLIC_ACCESS_NOTE,
  security: [],
  request: { query: listEmployeesQuerySchema },
  responses: {
    200: jsonResponse("A page of employees", employeeListSchema, {
      data: [exampleEmployee],
      meta: { total: 1, limit: 20, offset: 0 },
    }),
    400: jsonResponse(
      "Invalid query parameter: unknown `role`, a non-boolean `includeInactive`, `limit` outside 1-100, or a negative `offset`",
      validationErrorResponseSchema,
      {
        error: "Validation failed",
        details: [{ path: "limit", message: "Too big: expected number to be <=100" }],
      },
    ),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/employees/{id}",
  tags: ["Employees"],
  summary: "Get an employee by id",
  description: `Returns one active employee. A deactivated employee returns 404.\n\n${PUBLIC_ACCESS_NOTE}`,
  security: [],
  request: { params: employeeIdParamSchema },
  responses: {
    200: jsonResponse("The employee", employeeEnvelopeSchema, { data: exampleEmployee }),
    400: jsonResponse("`id` is not a valid UUID", validationErrorResponseSchema, {
      error: "Validation failed",
      details: [{ path: "id", message: "Invalid UUID" }],
    }),
    404: jsonResponse("No active employee with this id", errorResponseSchema, { error: "Employee not found" }),
    500: internalServerErrorResponse,
  },
});
