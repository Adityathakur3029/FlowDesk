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
import { employeeSchema, exampleEmployee } from "../employees/employee.docs";
import {
  createTeamSchema,
  listTeamMembersQuerySchema,
  listTeamsQuerySchema,
  teamIdParamSchema,
  teamMemberParamSchema,
  updateTeamSchema,
} from "./team.validation";

const ids = {
  team: "3f2c8b1e-6d4a-4b7e-9c21-5a8e7d0f1b23",
  otherTeam: "8a7d6c5b-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
};

export const exampleTeam = {
  id: ids.team,
  createdAt: "2026-10-17T09:00:00.000Z",
  updatedAt: "2026-10-17T09:00:00.000Z",
  isActive: true,
  name: "Research",
  description: "User and market research",
  memberCount: 4,
};

const exampleMember = { ...exampleEmployee, teamId: ids.team };

// Mirrors toTeamDto in team.dto.ts
const teamSchema = registry.register(
  "Team",
  z
    .object({
      id: z.uuid(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      isActive: z.boolean().meta({ description: "false once the team is deleted" }),
      name: z.string(),
      description: z.string().nullable(),
      memberCount: z.number().int().meta({ description: "Active employees in the team" }),
    })
    .meta({ example: exampleTeam }),
);

const teamEnvelopeSchema = registry.register("TeamResponse", z.object({ data: teamSchema }));

const teamListSchema = registry.register(
  "TeamListResponse",
  z.object({ data: z.array(teamSchema), meta: paginationMetaSchema }),
);

const teamMemberListSchema = registry.register(
  "TeamMemberListResponse",
  z.object({ data: z.array(employeeSchema), meta: paginationMetaSchema }),
);

const teamMembershipSchema = registry.register(
  "TeamMembershipResponse",
  z.object({
    data: z.object({
      employee: employeeSchema.meta({ description: "The employee, now in the team" }),
      previousTeamId: z.uuid().nullable().meta({
        description:
          "The employee's team before this call: null if they had none, the same `teamId` if they were already a member (nothing changed)",
      }),
    }),
  }),
);

// ---- Reusable responses ----

const BODY_HEADER = "**Headers:** `Content-Type: application/json` is required for the body to be parsed.";

const teamIdInvalid = jsonResponse("`teamId` is not a valid UUID", validationErrorResponseSchema, {
  error: "Validation failed",
  details: [{ path: "teamId", message: "Invalid UUID" }],
});

const memberParamsInvalid = jsonResponse("`teamId` or `employeeId` is not a valid UUID", validationErrorResponseSchema, {
  error: "Validation failed",
  details: [{ path: "employeeId", message: "Invalid UUID" }],
});

const teamNotFound = jsonResponse("No active team with this id (deleted teams are not found either)", errorResponseSchema, {
  error: "Team not found",
});

const notFound = (description: string, examples: Record<string, { error: string }>) => ({
  description,
  content: {
    "application/json": {
      schema: errorResponseSchema,
      examples: Object.fromEntries(Object.entries(examples).map(([name, value]) => [name, { value }])),
    },
  },
});

const nameTaken = jsonResponse(
  "`TEAM_NAME_EXISTS`: another active team has this name (compared ignoring case)",
  errorResponseSchema,
  { error: "Team name Research is already taken", code: "TEAM_NAME_EXISTS" },
);

// ---- Paths ----

registry.registerPath({
  method: "post",
  path: "/teams",
  tags: ["Teams"],
  summary: "Create a team",
  description:
    "Creates an empty team. Names are unique among active teams, ignoring case; the name of a deleted team can be reused.\n\n" +
    `${BODY_HEADER}\n\n${authNote("ADMIN", "MANAGER")}`,
  security: bearerSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createTeamSchema,
          example: { name: "Research", description: "User and market research" },
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Team created", teamEnvelopeSchema, { data: { ...exampleTeam, memberCount: 0 } }),
    400: jsonResponse(
      "The body breaks a validation rule: `name` 1-100 characters after trimming, `description` at most 2,000 characters or null",
      validationErrorResponseSchema,
      { error: "Validation failed", details: [{ path: "name", message: "Too small: expected string to have >=1 characters" }] },
    ),
    401: unauthorizedResponse,
    403: forbiddenResponse,
    409: nameTaken,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/teams",
  tags: ["Teams"],
  summary: "List teams",
  description: `Returns active teams sorted by name (ignoring case), one page at a time.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { query: listTeamsQuerySchema },
  responses: {
    200: jsonResponse("A page of teams", teamListSchema, { data: [exampleTeam], meta: { total: 1, limit: 20, offset: 0 } }),
    400: jsonResponse(
      "Invalid query parameter: `q` outside 1-100 characters, `limit` outside 1-100, or a negative `offset`",
      validationErrorResponseSchema,
      { error: "Validation failed", details: [{ path: "limit", message: "Too big: expected number to be <=100" }] },
    ),
    401: unauthorizedResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/teams/{teamId}",
  tags: ["Teams"],
  summary: "Get a team",
  description: `Returns one active team with its member count.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: teamIdParamSchema },
  responses: {
    200: jsonResponse("The team", teamEnvelopeSchema, { data: exampleTeam }),
    400: teamIdInvalid,
    401: unauthorizedResponse,
    404: teamNotFound,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "patch",
  path: "/teams/{teamId}",
  tags: ["Teams"],
  summary: "Update a team",
  description:
    "Updates `name` and/or `description` (null clears it). At least one field is required; unknown fields are rejected. " +
    "Renaming a team to its own name in a different case is allowed.\n\n" +
    `${BODY_HEADER}\n\n${authNote("ADMIN", "MANAGER")}`,
  security: bearerSecurity,
  request: {
    params: teamIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateTeamSchema, example: { name: "User Research" } } },
    },
  },
  responses: {
    200: jsonResponse("The updated team", teamEnvelopeSchema, { data: { ...exampleTeam, name: "User Research" } }),
    400: {
      description: "Invalid `teamId`, an empty body, an unknown field, or a field breaking its rule",
      content: {
        "application/json": {
          schema: validationErrorResponseSchema,
          examples: {
            empty: { value: { error: "Validation failed", details: [{ path: "", message: "At least one field is required" }] } },
            unknownField: { value: { error: "Validation failed", details: [{ path: "", message: 'Unrecognized key: "lead"' }] } },
          },
        },
      },
    },
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: teamNotFound,
    409: nameTaken,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "delete",
  path: "/teams/{teamId}",
  tags: ["Teams"],
  summary: "Delete a team",
  description:
    "Soft-deletes the team. It's refused with 409 `TEAM_OWNS_PROGRAMS` while the team owns an active program: " +
    "move those programs to another team first (`PATCH /programs/{programId}` with `ownerTeamId`). " +
    "Otherwise every member is released (their `teamId` becomes null) and the team returns 404 afterwards. " +
    "Its name can be used again. There is no restore endpoint.\n\n" +
    authNote("ADMIN"),
  security: bearerSecurity,
  request: { params: teamIdParamSchema },
  responses: {
    204: { description: "Team deleted" },
    400: teamIdInvalid,
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: teamNotFound,
    409: jsonResponse(
      "`TEAM_OWNS_PROGRAMS`: the team still owns active programs. `details.programs` lists up to 20 of them, by key.",
      errorResponseSchema,
      {
        error: "Team still owns active programs; move them to another team first",
        code: "TEAM_OWNS_PROGRAMS",
        details: { programs: [{ id: "5b1f6a3e-8c1d-4f8e-9a51-2a7c3d9e0b14", key: "MKT", name: "Marketing Research" }] },
      },
    ),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/teams/{teamId}/members",
  tags: ["Teams"],
  summary: "List a team's members",
  description: `Returns the team's active employees sorted by name, one page at a time.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: teamIdParamSchema, query: listTeamMembersQuerySchema },
  responses: {
    200: jsonResponse("A page of members", teamMemberListSchema, {
      data: [exampleMember],
      meta: { total: 1, limit: 20, offset: 0 },
    }),
    400: jsonResponse(
      "Invalid `teamId`, `limit` outside 1-100, or a negative `offset`",
      validationErrorResponseSchema,
      { error: "Validation failed", details: [{ path: "teamId", message: "Invalid UUID" }] },
    ),
    401: unauthorizedResponse,
    404: teamNotFound,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "put",
  path: "/teams/{teamId}/members/{employeeId}",
  tags: ["Teams"],
  summary: "Add or move an employee into a team",
  description:
    "Puts the employee in this team. An employee is in at most one team, so this **moves** them out of any other team. " +
    "Idempotent: if they're already a member nothing changes, and `previousTeamId` equals `teamId`. No request body.\n\n" +
    authNote("ADMIN", "MANAGER"),
  security: bearerSecurity,
  request: { params: teamMemberParamSchema },
  responses: {
    200: jsonResponse("The employee and the team they were in before", teamMembershipSchema, {
      data: { employee: exampleMember, previousTeamId: ids.otherTeam },
    }),
    400: memberParamsInvalid,
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: notFound("The team is unknown or deleted, or there is no active employee with this id", {
      team: { error: "Team not found" },
      employee: { error: "Employee not found" },
    }),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "delete",
  path: "/teams/{teamId}/members/{employeeId}",
  tags: ["Teams"],
  summary: "Remove an employee from a team",
  description: `Takes the employee out of the team; their \`teamId\` becomes null.\n\n${authNote("ADMIN", "MANAGER")}`,
  security: bearerSecurity,
  request: { params: teamMemberParamSchema },
  responses: {
    204: { description: "Employee removed from the team" },
    400: memberParamsInvalid,
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: notFound("The team is unknown or deleted, or the employee is not an active member of it", {
      team: { error: "Team not found" },
      member: { error: "Team member not found" },
    }),
    500: internalServerErrorResponse,
  },
});
