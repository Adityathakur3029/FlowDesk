import { z } from "zod";
import { employeeRole } from "../../db/schema";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../db/repository";

// These schemas validate requests at runtime and also generate the OpenAPI docs
// (see employee.docs.ts), so keep the `.meta` descriptions accurate.

export const roleSchema = z.enum(employeeRole.enumValues).meta({ id: "EmployeeRole", example: "MANAGER" });

const nameSchema = z.string().trim().min(1).max(150).meta({
  description: "Full name; trimmed; 1-150 characters",
  example: "Jane Doe",
});

export const createEmployeeSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email().max(255))
      .meta({
        description:
          "Organisation email. Trimmed and lowercased before saving. Must be unique (case-insensitive), including deactivated employees.",
        // The pipe hides the email/max checks from the generator, so state them here
        format: "email",
        maxLength: 255,
        example: "jane.doe@saajha.org",
      }),
    name: nameSchema,
    role: roleSchema,
  })
  .meta({ id: "CreateEmployeeRequest" });

// email is bound to the Google account and teamId changes through the team member routes,
// so neither is editable here (strict: they're rejected as unknown keys)
export const updateEmployeeSchema = z
  .strictObject({
    name: nameSchema.optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional().meta({
      description: "false deactivates the employee, true reactivates them",
      example: false,
    }),
  })
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")
  .meta({
    id: "UpdateEmployeeRequest",
    description: "Send at least one field. Unknown fields are rejected, including `email` and `teamId`.",
  });

export const listEmployeesQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional().meta({
    description:
      "Search text, trimmed, 1-100 characters. Case-insensitive substring match on `name` or `emailId`; " +
      "`%`, `_` and `\\` match literally. Changes the order (see the operation description).",
    example: "jan",
  }),
  role: roleSchema.optional().meta({ description: "Only return employees with this role" }),
  teamId: z
    .union([z.uuid(), z.literal("none")])
    .optional()
    .meta({
      description:
        "Only return members of this team (UUID), or `none` for employees not in any team. " +
        "An unknown or deleted team simply matches nobody.",
      example: "none",
    }),
  includeInactive: z.stringbool().optional().meta({
    description: "Include deactivated employees. Case-insensitive; true values: true, 1, yes, on, y, enabled; false values: false, 0, no, off, n, disabled. Defaults to false.",
    example: "false",
  }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).meta({
    description: `Page size, 1-${MAX_PAGE_SIZE}`,
    example: 20,
  }),
  offset: z.coerce.number().int().min(0).default(0).meta({
    description: "Number of rows to skip",
    nullable: false,
    example: 0,
  }),
});

export const employeeIdParamSchema = z.object({
  id: z.uuid().meta({ description: "Employee id (UUID)", example: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0" }),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;
