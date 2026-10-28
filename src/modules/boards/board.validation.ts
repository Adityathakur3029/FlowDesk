import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../db/repository";
import { containerKeySchema } from "../programs/program.validation";

// These schemas validate requests at runtime and also generate the OpenAPI docs
// (see board.docs.ts), so keep the `.meta` descriptions accurate.

const nameSchema = z.string().trim().min(1).max(150).meta({
  description: "The board's topic. Trimmed; 1-150 characters",
  example: "Product feedback",
});

const descriptionSchema = z.string().max(10_000).nullable().meta({
  description: "Free text, at most 10,000 characters; null clears it",
  example: "Ideas and bugs reported from the field",
});

export const createBoardSchema = z
  .object({
    key: containerKeySchema.meta({
      description:
        "Short prefix of the board's task keys (PRO -> PRO-50). Trimmed and uppercased, then 2-10 letters or digits starting with a letter. " +
        "Unique among boards, including soft-deleted ones, and cannot be changed later. May equal a program's key.",
      example: "PRO",
    }),
    name: nameSchema,
    description: descriptionSchema.optional(),
  })
  .meta({ id: "CreateBoardRequest" });

export const updateBoardSchema = z
  .strictObject(
    {
      name: nameSchema.optional(),
      description: descriptionSchema.optional(),
    },
    {
      error: (iss) =>
        iss.code === "unrecognized_keys" && iss.keys.includes("key") ? "Board key cannot be changed" : undefined,
    },
  )
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")
  .meta({
    id: "UpdateBoardRequest",
    description: "Send at least one field. `key` is immutable and is rejected; unknown fields are rejected too.",
  });

export const listBoardsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional().meta({
    description: "Case-insensitive substring match on name or key, 1-100 characters",
    example: "feedback",
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

export const boardIdParamSchema = z.object({
  boardId: z.uuid().meta({ description: "Board id (UUID)", example: "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f" }),
});

export type CreateBoardInput = z.infer<typeof createBoardSchema>;
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>;
export type ListBoardsQuery = z.infer<typeof listBoardsQuerySchema>;
