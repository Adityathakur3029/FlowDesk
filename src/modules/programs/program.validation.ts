import { z } from "zod";
import { programStatus } from "../../db/schema";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../db/repository";

// These schemas validate requests at runtime and also generate the OpenAPI docs
// (see program.docs.ts), so keep the `.meta` descriptions accurate.

export const programStatusSchema = z
  .enum(programStatus.enumValues)
  .meta({ id: "ProgramStatus", description: "Program lifecycle status. Any status can move to any other.", example: "ACTIVE" });

const descriptionSchema = z.string().max(10_000).nullable().meta({
  description: "Free text, at most 10,000 characters; null clears it",
  example: "Q4 market research for the new product line",
});

const ownerTeamIdSchema = z.uuid().meta({
  description: "Id of the active team that owns the program. A program always has exactly one owner team.",
  example: "3f2c8b1e-6d4a-4b7e-9c21-5a8e7d0f1b23",
});

const startDateSchema = z.iso.date().nullable().meta({
  description: "Planned start, YYYY-MM-DD, or null. Past dates are allowed.",
  example: "2026-10-01",
});

const endDateSchema = z.iso.date().nullable().meta({
  description: "Planned end, YYYY-MM-DD, or null. Must be on or after startDate. Past dates are allowed.",
  example: "2026-12-31",
});

// Key rule shared by programs and boards, whose keys prefix their task keys
export const containerKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Key must be 2-10 letters or digits, starting with a letter");

export const createProgramSchema = z
  .object({
    ownerTeamId: ownerTeamIdSchema,
    key: containerKeySchema.meta({
      description:
        "Short prefix of the program's task keys (MKT -> MKT-42). Trimmed and uppercased, then 2-10 letters or digits starting with a letter. " +
        "Unique among programs, including soft-deleted ones, and cannot be changed later. A board may use the same key.",
      example: "MKT",
    }),
    name: z.string().trim().min(1).max(150).meta({ description: "Trimmed; 1-150 characters", example: "Marketing Research" }),
    description: descriptionSchema.optional(),
    status: programStatusSchema.default("PLANNED").meta({ description: "Defaults to PLANNED" }),
    startDate: startDateSchema.optional(),
    endDate: endDateSchema.optional(),
  })
  .meta({ id: "CreateProgramRequest" });

export const updateProgramSchema = z
  .strictObject(
    {
      name: z.string().trim().min(1).max(150).optional().meta({ description: "Trimmed; 1-150 characters", example: "Market Research" }),
      description: descriptionSchema.optional(),
      status: programStatusSchema.optional(),
      startDate: startDateSchema.optional(),
      endDate: endDateSchema.optional(),
      ownerTeamId: z
        .uuid({
          error: (iss) => (iss.input === null ? "A program must have an owner team" : undefined),
        })
        .optional()
        .meta({
          description: "Move ownership to another active team. Can't be null: a program always has an owner team.",
          example: "3f2c8b1e-6d4a-4b7e-9c21-5a8e7d0f1b23",
        }),
    },
    {
      error: (iss) =>
        iss.code === "unrecognized_keys" && iss.keys.includes("key") ? "Program key cannot be changed" : undefined,
    },
  )
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")
  .meta({
    id: "UpdateProgramRequest",
    description: "Send at least one field. `key` is immutable and is rejected; unknown fields are rejected too.",
  });

export const listProgramsQuerySchema = z.object({
  status: programStatusSchema.optional().meta({ description: "Only return programs with this status" }),
  ownerTeamId: z.uuid().optional().meta({
    description: "Only return programs owned by this team",
    example: "3f2c8b1e-6d4a-4b7e-9c21-5a8e7d0f1b23",
  }),
  q: z.string().trim().min(1).max(100).optional().meta({
    description: "Case-insensitive substring match on name or key, 1-100 characters",
    example: "market",
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

export const programIdParamSchema = z.object({
  programId: z.uuid().meta({ description: "Program id (UUID)", example: "5b1f6a3e-8c1d-4f8e-9a51-2a7c3d9e0b14" }),
});

export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;
export type ListProgramsQuery = z.infer<typeof listProgramsQuerySchema>;
