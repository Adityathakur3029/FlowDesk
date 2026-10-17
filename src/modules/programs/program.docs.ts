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
import {
  createProgramSchema,
  listProgramsQuerySchema,
  programIdParamSchema,
  programStatusSchema,
  updateProgramSchema,
} from "./program.validation";

export const exampleProgram = {
  id: "5b1f6a3e-8c1d-4f8e-9a51-2a7c3d9e0b14",
  createdAt: "2026-10-17T09:30:00.000Z",
  updatedAt: "2026-10-17T09:30:00.000Z",
  isActive: true,
  key: "MKT",
  name: "Marketing Research",
  description: "Q4 market research for the new product line",
  status: "ACTIVE",
};

// Mirrors toProgramDto in program.dto.ts (task_counter is internal and not returned)
export const programSchema = registry.register(
  "Program",
  z
    .object({
      id: z.uuid(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      isActive: z.boolean().meta({ description: "false once the program is soft-deleted" }),
      key: z.string().meta({ description: "Uppercase prefix of the program's task keys. Immutable." }),
      name: z.string(),
      description: z.string().nullable(),
      status: programStatusSchema,
    })
    .meta({ example: exampleProgram }),
);

const programEnvelopeSchema = registry.register("ProgramResponse", z.object({ data: programSchema }));

const programListSchema = registry.register(
  "ProgramListResponse",
  z.object({ data: z.array(programSchema), meta: paginationMetaSchema }),
);

const labelStatsSchema = registry.register(
  "ProgramLabelsResponse",
  z.object({
    data: z.array(
      z.object({
        label: z.string(),
        taskCount: z.number().int().meta({ description: "Active tasks in the program with this label" }),
      }),
    ),
  }),
);

const programIdInvalid = jsonResponse("`programId` is not a valid UUID", validationErrorResponseSchema, {
  error: "Validation failed",
  details: [{ path: "programId", message: "Invalid UUID" }],
});

export const programNotFoundResponse = jsonResponse(
  "No active program with this id (soft-deleted programs are not found either)",
  errorResponseSchema,
  { error: "Program not found" },
);

registry.registerPath({
  method: "post",
  path: "/programs",
  tags: ["Programs"],
  summary: "Create a program",
  description:
    "Creates a program. `key` is trimmed and uppercased; it becomes the prefix of every task key in the program (MKT -> MKT-1, MKT-2…), " +
    "can't be changed later, and stays taken after the program is soft-deleted.\n\n" +
    "**Headers:** `Content-Type: application/json` is required for the body to be parsed.\n\n" +
    authNote("ADMIN", "MANAGER"),
  security: bearerSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createProgramSchema,
          example: { key: "mkt", name: "Marketing Research", description: "Q4 market research for the new product line", status: "ACTIVE" },
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Program created", programEnvelopeSchema, { data: exampleProgram }),
    400: jsonResponse(
      "The body breaks a validation rule: `key` 2-10 letters or digits starting with a letter, `name` 1-150 characters, " +
        "`description` at most 10,000 characters, `status` a ProgramStatus.",
      validationErrorResponseSchema,
      {
        error: "Validation failed",
        details: [{ path: "key", message: "Key must be 2-10 letters or digits, starting with a letter" }],
      },
    ),
    401: unauthorizedResponse,
    403: forbiddenResponse,
    409: jsonResponse("`PROGRAM_KEY_EXISTS`: another program (active or soft-deleted) has this key", errorResponseSchema, {
      error: "Program key MKT is already taken",
      code: "PROGRAM_KEY_EXISTS",
    }),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/programs",
  tags: ["Programs"],
  summary: "List programs",
  description: `Returns active programs newest first (\`createdAt\` descending), one page at a time.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { query: listProgramsQuerySchema },
  responses: {
    200: jsonResponse("A page of programs", programListSchema, {
      data: [exampleProgram],
      meta: { total: 1, limit: 20, offset: 0 },
    }),
    400: jsonResponse(
      "Invalid query parameter: unknown `status`, `q` outside 1-100 characters, `limit` outside 1-100, or a negative `offset`",
      validationErrorResponseSchema,
      { error: "Validation failed", details: [{ path: "limit", message: "Too big: expected number to be <=100" }] },
    ),
    401: unauthorizedResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/programs/{programId}",
  tags: ["Programs"],
  summary: "Get a program",
  description: `Returns one active program.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: programIdParamSchema },
  responses: {
    200: jsonResponse("The program", programEnvelopeSchema, { data: exampleProgram }),
    400: programIdInvalid,
    401: unauthorizedResponse,
    404: programNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "patch",
  path: "/programs/{programId}",
  tags: ["Programs"],
  summary: "Update a program",
  description:
    "Updates any of `name`, `description` (null clears it) and `status`. At least one field is required. " +
    "`key` is immutable: sending it returns 400. Any status can move to any other.\n\n" +
    "**Headers:** `Content-Type: application/json` is required for the body to be parsed.\n\n" +
    authNote("ADMIN", "MANAGER"),
  security: bearerSecurity,
  request: {
    params: programIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateProgramSchema, example: { status: "ON_HOLD" } } },
    },
  },
  responses: {
    200: jsonResponse("The updated program", programEnvelopeSchema, { data: { ...exampleProgram, status: "ON_HOLD" } }),
    400: {
      description: "Invalid `programId`, an empty body, a field breaking its rule, or an attempt to change `key`",
      content: {
        "application/json": {
          schema: validationErrorResponseSchema,
          examples: {
            keyChange: { value: { error: "Validation failed", details: [{ path: "", message: "Program key cannot be changed" }] } },
            empty: { value: { error: "Validation failed", details: [{ path: "", message: "At least one field is required" }] } },
          },
        },
      },
    },
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: programNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "delete",
  path: "/programs/{programId}",
  tags: ["Programs"],
  summary: "Soft-delete a program",
  description:
    "Sets `isActive = false`. The program's tasks are kept, but the program and every route under it (tasks, labels) return 404 afterwards. " +
    "Its key stays taken. There is no restore endpoint yet.\n\n" +
    authNote("ADMIN"),
  security: bearerSecurity,
  request: { params: programIdParamSchema },
  responses: {
    204: { description: "Program deleted" },
    400: programIdInvalid,
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: programNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/programs/{programId}/labels",
  tags: ["Programs"],
  summary: "List labels used in a program",
  description:
    "Distinct labels across the program's active tasks with how many tasks use each, ordered by `taskCount` descending then `label`. " +
    `Useful for label autocomplete.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: programIdParamSchema },
  responses: {
    200: jsonResponse("Labels with usage counts", labelStatsSchema, {
      data: [
        { label: "survey", taskCount: 4 },
        { label: "q4", taskCount: 2 },
      ],
    }),
    400: programIdInvalid,
    401: unauthorizedResponse,
    404: programNotFoundResponse,
    500: internalServerErrorResponse,
  },
});
