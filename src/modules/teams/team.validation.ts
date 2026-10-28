import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../db/repository";

// These schemas validate requests at runtime and also generate the OpenAPI docs
// (see team.docs.ts), so keep the `.meta` descriptions accurate.

const nameSchema = z.string().trim().min(1).max(100).meta({
  description: "Trimmed; 1-100 characters. Unique among active teams, ignoring case.",
  example: "Research",
});

const descriptionSchema = z.string().max(2_000).nullable().meta({
  description: "Free text, at most 2,000 characters; null clears it",
  example: "User and market research",
});

const pagination = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).meta({
    description: `Page size, 1-${MAX_PAGE_SIZE}`,
    example: 20,
  }),
  offset: z.coerce.number().int().min(0).default(0).meta({
    description: "Number of rows to skip",
    nullable: false,
    example: 0,
  }),
};

export const createTeamSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
  })
  .meta({ id: "CreateTeamRequest" });

export const updateTeamSchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")
  .meta({ id: "UpdateTeamRequest", description: "Send at least one field. Unknown fields are rejected." });

export const listTeamsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional().meta({
    description: "Case-insensitive substring match on name, 1-100 characters",
    example: "research",
  }),
  ...pagination,
});

export const listTeamMembersQuerySchema = z.object(pagination);

const teamId = z.uuid().meta({ description: "Team id (UUID)", example: "3f2c8b1e-6d4a-4b7e-9c21-5a8e7d0f1b23" });

export const teamIdParamSchema = z.object({ teamId });

export const teamMemberParamSchema = z.object({
  teamId,
  employeeId: z.uuid().meta({ description: "Employee id (UUID)", example: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0" }),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;
export type ListTeamMembersQuery = z.infer<typeof listTeamMembersQuerySchema>;
