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

export const createProgramSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Key must be 2-10 letters or digits, starting with a letter")
      .meta({
        description:
          "Short prefix of the program's task keys (MKT -> MKT-42). Trimmed and uppercased, then 2-10 letters or digits starting with a letter. " +
          "Unique, including soft-deleted programs, and cannot be changed later.",
        example: "MKT",
      }),
    name: z.string().trim().min(1).max(150).meta({ description: "Trimmed; 1-150 characters", example: "Marketing Research" }),
    description: descriptionSchema.optional(),
    status: programStatusSchema.default("PLANNED").meta({ description: "Defaults to PLANNED" }),
  })
  .meta({ id: "CreateProgramRequest" });

export const updateProgramSchema = z
  .strictObject(
    {
      name: z.string().trim().min(1).max(150).optional().meta({ description: "Trimmed; 1-150 characters", example: "Market Research" }),
      description: descriptionSchema.optional(),
      status: programStatusSchema.optional(),
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
