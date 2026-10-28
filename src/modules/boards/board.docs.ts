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
import { boardIdParamSchema, createBoardSchema, listBoardsQuerySchema, updateBoardSchema } from "./board.validation";

export const exampleBoard = {
  id: "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f",
  createdAt: "2026-10-28T09:00:00.000Z",
  updatedAt: "2026-10-28T09:00:00.000Z",
  isActive: true,
  key: "PRO",
  name: "Product feedback",
  description: "Ideas and bugs reported from the field",
};

// Mirrors toBoardDto in board.dto.ts
export const boardSchema = registry.register(
  "Board",
  z
    .object({
      id: z.uuid(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      isActive: z.boolean().meta({ description: "false once the board is soft-deleted (deleted boards are never returned)" }),
      key: z.string().meta({ description: "Uppercase prefix of the board's task keys. Immutable. May equal a program's key." }),
      name: z.string().meta({ description: "The board's topic" }),
      description: z.string().nullable(),
    })
    .meta({
      description:
        "A lightweight container of tasks: no status, dates, owner team or board-level comments, and it never closes. " +
        "Its tasks behave exactly like program tasks.",
      example: exampleBoard,
    }),
);

const boardEnvelopeSchema = registry.register("BoardResponse", z.object({ data: boardSchema }));

const boardListSchema = registry.register(
  "BoardListResponse",
  z.object({ data: z.array(boardSchema), meta: paginationMetaSchema }),
);

const labelStatsSchema = registry.register(
  "BoardLabelsResponse",
  z.object({
    data: z.array(
      z.object({
        label: z.string(),
        taskCount: z.number().int().meta({ description: "Active tasks on the board with this label" }),
      }),
    ),
  }),
);

const boardIdInvalid = jsonResponse("`boardId` is not a valid UUID", validationErrorResponseSchema, {
  error: "Validation failed",
  details: [{ path: "boardId", message: "Invalid UUID" }],
});

export const boardNotFoundResponse = jsonResponse(
  "No active board with this id (soft-deleted boards are not found either)",
  errorResponseSchema,
  { error: "Board not found" },
);

// A 400 that can be a Zod validation error or a business error with a `code`
const badRequest = (description: string, examples: Record<string, unknown>) => ({
  description,
  content: {
    "application/json": {
      schema: z.union([validationErrorResponseSchema, errorResponseSchema]),
      examples: Object.fromEntries(Object.entries(examples).map(([name, value]) => [name, { value }])),
    },
  },
});

const BODY_HEADER = "**Headers:** `Content-Type: application/json` is required for the body to be parsed.";

registry.registerPath({
  method: "post",
  path: "/boards",
  tags: ["Boards"],
  summary: "Create a board",
  description:
    "Creates a board. `key` is trimmed and uppercased; it becomes the prefix of the board's task keys, can't be changed later, " +
    "and stays taken after the board is soft-deleted. It only has to be unique among boards: a board and a program can share a key " +
    "(board `PRO` and program `PRO`), because task numbers are global, so their task keys never collide.\n\n" +
    `${BODY_HEADER}\n\n${authNote("ADMIN", "MANAGER")}`,
  security: bearerSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createBoardSchema,
          example: { key: "pro", name: "Product feedback", description: "Ideas and bugs reported from the field" },
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Board created", boardEnvelopeSchema, { data: exampleBoard }),
    400: jsonResponse(
      "The body breaks a validation rule: `key` 2-10 letters or digits starting with a letter, `name` 1-150 characters, " +
        "`description` at most 10,000 characters or null",
      validationErrorResponseSchema,
      { error: "Validation failed", details: [{ path: "key", message: "Key must be 2-10 letters or digits, starting with a letter" }] },
    ),
    401: unauthorizedResponse,
    403: forbiddenResponse,
    409: jsonResponse("`BOARD_KEY_EXISTS`: another board (active or soft-deleted) has this key", errorResponseSchema, {
      error: "Board key PRO is already taken",
      code: "BOARD_KEY_EXISTS",
    }),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/boards",
  tags: ["Boards"],
  summary: "List boards",
  description: `Returns active boards newest first (\`createdAt\` descending), one page at a time. Filter with \`q\`.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { query: listBoardsQuerySchema },
  responses: {
    200: jsonResponse("A page of boards", boardListSchema, { data: [exampleBoard], meta: { total: 1, limit: 20, offset: 0 } }),
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
  path: "/boards/{boardId}",
  tags: ["Boards"],
  summary: "Get a board",
  description: `Returns one active board.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: boardIdParamSchema },
  responses: {
    200: jsonResponse("The board", boardEnvelopeSchema, { data: exampleBoard }),
    400: boardIdInvalid,
    401: unauthorizedResponse,
    404: boardNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "patch",
  path: "/boards/{boardId}",
  tags: ["Boards"],
  summary: "Update a board",
  description:
    "Updates `name` and/or `description` (null clears it). At least one field is required. `key` is immutable: sending it returns 400, " +
    `as does any other unknown field.\n\n${BODY_HEADER}\n\n${authNote("ADMIN", "MANAGER")}`,
  security: bearerSecurity,
  request: {
    params: boardIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateBoardSchema, example: { name: "Customer feedback" } } },
    },
  },
  responses: {
    200: jsonResponse("The updated board", boardEnvelopeSchema, { data: { ...exampleBoard, name: "Customer feedback" } }),
    400: badRequest("Invalid `boardId`, an empty body, a field breaking its rule, or an attempt to change `key`", {
      keyChange: { error: "Validation failed", details: [{ path: "", message: "Board key cannot be changed" }] },
      empty: { error: "Validation failed", details: [{ path: "", message: "At least one field is required" }] },
      badName: { error: "Validation failed", details: [{ path: "name", message: "Too small: expected string to have >=1 characters" }] },
    }),
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: boardNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "delete",
  path: "/boards/{boardId}",
  tags: ["Boards"],
  summary: "Soft-delete a board",
  description:
    "Sets `isActive = false`. Only the board is hidden: it, its task list, its labels and creating tasks in it return 404 afterwards, " +
    "and it leaves `GET /boards`. **Its tasks stay live**: they can still be fetched, edited, linked, commented on and deleted through " +
    "`/tasks/{taskRef}` (their `parent.isActive` becomes false), and they still count in `GET /reports/overview` (without a `boards[]` row). " +
    "The key stays taken. There is no restore endpoint yet.\n\n" +
    authNote("ADMIN"),
  security: bearerSecurity,
  request: { params: boardIdParamSchema },
  responses: {
    204: { description: "Board deleted" },
    400: boardIdInvalid,
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: boardNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/boards/{boardId}/labels",
  tags: ["Boards"],
  summary: "List labels used on a board",
  description:
    "Distinct labels across the board's active tasks with how many tasks use each, ordered by `taskCount` descending then `label`. " +
    `Useful for label autocomplete.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: boardIdParamSchema },
  responses: {
    200: jsonResponse("Labels with usage counts", labelStatsSchema, {
      data: [
        { label: "mobile", taskCount: 3 },
        { label: "pricing", taskCount: 1 },
      ],
    }),
    400: boardIdInvalid,
    401: unauthorizedResponse,
    404: boardNotFoundResponse,
    500: internalServerErrorResponse,
  },
});
