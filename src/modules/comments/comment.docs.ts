import { z } from "zod";
import {
  bearerSecurity,
  employeeSummarySchema,
  errorResponseSchema,
  internalServerErrorResponse,
  jsonResponse,
  paginationMetaSchema,
  registry,
  unauthorizedResponse,
  validationErrorResponseSchema,
} from "../../docs/registry";
import { programIdParamSchema } from "../programs/program.validation";
import { programNotFoundResponse } from "../programs/program.docs";
import { taskRefParamSchema } from "../tasks/task.validation";
import { MAX_MENTIONS } from "./comment.mentions";
import {
  commentIdParamSchema,
  createCommentSchema,
  listCommentsQuerySchema,
  updateCommentSchema,
} from "./comment.validation";

const ids = {
  program: "5b1f6a3e-8c1d-4f8e-9a51-2a7c3d9e0b14",
  task: "7d2e9b40-1c3a-4e5f-8a6b-9c0d1e2f3a4b",
  comment: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  reply: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f",
  jane: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0",
};

const ravi = { id: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f", name: "Ravi Kumar", emailId: "ravi.kumar@saajha.org" };
const jane = { id: ids.jane, name: "Jane Doe", emailId: "jane.doe@saajha.org" };

const exampleReply = {
  id: ids.reply,
  createdAt: "2026-10-17T11:05:00.000Z",
  updatedAt: "2026-10-17T11:05:00.000Z",
  isActive: true,
  programId: ids.program,
  taskId: ids.task,
  parentId: ids.comment,
  author: jane,
  body: "Looks good, two small notes inline.",
  editedAt: null,
  mentions: [],
};

const exampleComment = {
  id: ids.comment,
  createdAt: "2026-10-17T10:30:00.000Z",
  updatedAt: "2026-10-17T10:30:00.000Z",
  isActive: true,
  programId: ids.program,
  taskId: ids.task,
  parentId: null,
  author: ravi,
  body: `Draft ready, @[Jane Doe](mention:${ids.jane}) please review`,
  editedAt: null,
  mentions: [jane],
  replies: [exampleReply],
};

const exampleTombstone = {
  ...exampleComment,
  updatedAt: "2026-10-17T12:00:00.000Z",
  isActive: false,
  author: null,
  body: null,
  mentions: [],
};

const exampleProgramComment = {
  ...exampleComment,
  taskId: null,
  body: `Scope change: survey moves to November. FYI @[Jane Doe](mention:${ids.jane})`,
  replies: [],
};

// Mirrors toCommentReplyDto / toCommentDto in comment.dto.ts
const commentShape = {
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  isActive: z.boolean().meta({ description: "false only on a tombstone (a deleted top-level comment that still has active replies)" }),
  programId: z.uuid(),
  taskId: z.uuid().nullable().meta({ description: "The task the comment is on; null for a program-level comment" }),
  parentId: z.uuid().nullable().meta({ description: "The top-level comment this replies to; null for a top-level comment" }),
  author: employeeSummarySchema.nullable().meta({
    description: "The employee who wrote it (still shown if since deactivated); null on a tombstone",
  }),
  body: z.string().nullable().meta({
    description: "Markdown as sent (trimmed), including mention tokens. Render it sanitised. null on a tombstone.",
  }),
  editedAt: z.iso.datetime().nullable().meta({ description: "When the body was last edited; null if never edited, and on a tombstone" }),
  mentions: z.array(employeeSummarySchema).meta({
    description:
      "Employees mentioned in the body, ordered by name, with their **current** name (which may differ from the label in the body). " +
      "Deactivated employees are still listed. Empty on a tombstone.",
  }),
};

export const commentReplySchema = registry.register(
  "CommentReply",
  z.object(commentShape).meta({ description: "A reply. Replies can't have replies, so there's no `replies` field.", example: exampleReply }),
);

export const commentSchema = registry.register(
  "Comment",
  z
    .object({
      ...commentShape,
      replies: z.array(commentReplySchema).optional().meta({
        description: "Only on top-level comments (absent on replies): every active reply, oldest first",
      }),
    })
    .meta({
      description:
        "A comment on a program (`taskId: null`) or on a task. `replies` appears only on top-level comments. " +
        "A deleted top-level comment that still has active replies is returned as a **tombstone**: `isActive: false`, `body: null`, " +
        "`author: null`, `editedAt: null` and `mentions: []`, with `id`, `createdAt`, `parentId` and `replies` still filled in. " +
        "`mentions` shows each person's current name.",
      example: exampleComment,
    }),
);

const commentEnvelope = registry.register("CommentResponse", z.object({ data: commentSchema }));
const commentListSchema = registry.register(
  "CommentListResponse",
  z.object({ data: z.array(commentSchema), meta: paginationMetaSchema }),
);

// ---- Reusable responses ----

const listMeta = { total: 1, limit: 20, offset: 0 };

type ErrorExample = { error: string; code?: string; details?: unknown };

const examplesResponse = (description: string, schema: z.ZodType, examples: Record<string, unknown>) => ({
  description,
  content: {
    "application/json": {
      schema,
      examples: Object.fromEntries(Object.entries(examples).map(([name, value]) => [name, { value }])),
    },
  },
});

const validation400 = (description: string, examples: Record<string, unknown>) =>
  examplesResponse(description, z.union([validationErrorResponseSchema, errorResponseSchema]), examples);

const programAndTaskNotFound = examplesResponse(
  "The program is unknown or soft-deleted, or there is no active task with this id/key in the program",
  errorResponseSchema,
  { program: { error: "Program not found" }, task: { error: "Task not found" } },
);

const commentNotFound = examplesResponse(
  "The program is unknown or soft-deleted, or the comment is missing, deleted (including tombstones), in another program, or on a soft-deleted task",
  errorResponseSchema,
  { program: { error: "Program not found" }, comment: { error: "Comment not found" } },
);

const forbidden = (description: string) =>
  jsonResponse(description, errorResponseSchema, {
    error: "You do not have permission to perform this action",
    code: "FORBIDDEN",
  } satisfies ErrorExample);

const replyErrors: Record<string, ErrorExample> = {
  parentNotFound: { error: "Parent comment not found", code: "PARENT_COMMENT_NOT_FOUND" },
  parentTargetMismatch: { error: "A reply must be on the same task or program as its parent", code: "PARENT_TARGET_MISMATCH" },
  nestedReply: { error: "Replies can't have replies; reply to the top-level comment", code: "NESTED_REPLY" },
};

const mentionErrors: Record<string, ErrorExample> = {
  tooManyMentions: { error: `A comment can mention at most ${MAX_MENTIONS} people`, code: "TOO_MANY_MENTIONS" },
  mentionNotFound: { error: `Mentioned employee ${ids.jane} not found or inactive`, code: "MENTION_NOT_FOUND" },
};

const bodyValidation = {
  error: "Validation failed",
  details: [{ path: "body", message: "Too small: expected string to have >=1 characters" }],
};

const CREATE_RULES =
  "Rules, in order: the target must be active (404); if `parentId` is sent, the parent must be an active comment in this program " +
  "(400 `PARENT_COMMENT_NOT_FOUND`) on the same task or program (400 `PARENT_TARGET_MISMATCH`) and itself top-level " +
  `(400 \`NESTED_REPLY\`); the body may mention at most ${MAX_MENTIONS} distinct people (400 \`TOO_MANY_MENTIONS\`), each an active ` +
  "employee (400 `MENTION_NOT_FOUND`). The comment and its mentions are saved in one transaction. Self-mentions are allowed.";

const LIST_RULES =
  "Returns top-level comments, one page of threads at a time, each with all of its active replies (oldest first) and mentions. " +
  "`limit`/`offset` page **threads**, and `meta.total` counts them. A deleted top-level comment is listed as a tombstone while it " +
  "still has active replies; deleted replies are never listed.";

const BODY_HEADER = "**Headers:** `Content-Type: application/json` is required for the body to be parsed.";
const AUTH_HEADER = "**Authentication:** required. Send `Authorization: Bearer <accessToken>` (from `POST /auth/google`, Google sign-in).";
const ANY_ROLE = `${AUTH_HEADER}\n\n**Authorization / roles:** any active employee.`;

const createBody = (example: unknown) => ({
  required: true,
  content: { "application/json": { schema: createCommentSchema, example } },
});

// ---- Paths ----

registry.registerPath({
  method: "get",
  path: "/programs/{programId}/comments",
  tags: ["Comments"],
  summary: "List program-level comments",
  description:
    `${LIST_RULES} Only program-level comments (no task) are returned; task comments are never mixed in.\n\n${ANY_ROLE}`,
  security: bearerSecurity,
  request: { params: programIdParamSchema, query: listCommentsQuerySchema },
  responses: {
    200: examplesResponse("A page of threads", commentListSchema, {
      thread: { data: [{ ...exampleProgramComment, replies: [{ ...exampleReply, taskId: null }] }], meta: listMeta },
      tombstone: {
        data: [{ ...exampleTombstone, taskId: null, replies: [{ ...exampleReply, taskId: null }] }],
        meta: listMeta,
      },
    }),
    400: jsonResponse(
      "Invalid `programId`, `order` not asc/desc, `limit` outside 1-100 or a negative `offset`",
      validationErrorResponseSchema,
      { error: "Validation failed", details: [{ path: "limit", message: "Too big: expected number to be <=100" }] },
    ),
    401: unauthorizedResponse,
    404: programNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/programs/{programId}/comments",
  tags: ["Comments"],
  summary: "Comment on a program (or reply)",
  description:
    "Adds a program-level comment, or a reply to one when `parentId` is set. The signed-in employee is the author. " +
    "Comments are allowed on programs in any status.\n\n" +
    `${CREATE_RULES}\n\n${BODY_HEADER}\n\n${ANY_ROLE}`,
  security: bearerSecurity,
  request: {
    params: programIdParamSchema,
    body: createBody({ body: exampleProgramComment.body }),
  },
  responses: {
    201: jsonResponse("Comment created; a top-level comment comes back with `replies: []`", commentEnvelope, {
      data: exampleProgramComment,
    }),
    400: validation400("Invalid params or body (empty or longer than 10,000 characters…), or a reply/mention rule failed (`code`)", {
      validation: bodyValidation,
      ...replyErrors,
      ...mentionErrors,
    }),
    401: unauthorizedResponse,
    404: programNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/programs/{programId}/tasks/{taskRef}/comments",
  tags: ["Comments"],
  summary: "List a task's comments",
  description: `${LIST_RULES} \`taskRef\` is the task UUID or its key (case-insensitive, e.g. \`mkt-7\`).\n\n${ANY_ROLE}`,
  security: bearerSecurity,
  request: { params: taskRefParamSchema, query: listCommentsQuerySchema },
  responses: {
    200: examplesResponse("A page of threads", commentListSchema, {
      thread: { data: [exampleComment], meta: listMeta },
      tombstone: { data: [exampleTombstone], meta: listMeta },
    }),
    400: jsonResponse(
      "Invalid `programId` or `taskRef`, `order` not asc/desc, `limit` outside 1-100 or a negative `offset`",
      validationErrorResponseSchema,
      { error: "Validation failed", details: [{ path: "taskRef", message: "Must be a task UUID or a task key like MKT-7" }] },
    ),
    401: unauthorizedResponse,
    404: programAndTaskNotFound,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/programs/{programId}/tasks/{taskRef}/comments",
  tags: ["Comments"],
  summary: "Comment on a task (or reply)",
  description:
    "Adds a comment to the task, or a reply to one of its comments when `parentId` is set. The signed-in employee is the author. " +
    "`taskRef` is the task UUID or its key (case-insensitive). Comments are allowed on tasks in any status, including DONE.\n\n" +
    `${CREATE_RULES}\n\n${BODY_HEADER}\n\n${ANY_ROLE}`,
  security: bearerSecurity,
  request: {
    params: taskRefParamSchema,
    body: createBody({ body: exampleComment.body }),
  },
  responses: {
    201: jsonResponse("Comment created; a top-level comment comes back with `replies: []`", commentEnvelope, {
      data: { ...exampleComment, replies: [] },
    }),
    400: validation400("Invalid params or body, or a reply/mention rule failed (`code`)", {
      validation: bodyValidation,
      ...replyErrors,
      ...mentionErrors,
    }),
    401: unauthorizedResponse,
    404: programAndTaskNotFound,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/programs/{programId}/comments/{commentId}",
  tags: ["Comments"],
  summary: "Get a comment",
  description:
    "Returns one program or task comment; a top-level comment comes with its active replies. This is the target for deep links.\n\n" +
    ANY_ROLE,
  security: bearerSecurity,
  request: { params: commentIdParamSchema },
  responses: {
    200: jsonResponse("The comment", commentEnvelope, { data: exampleComment }),
    400: jsonResponse("`programId` or `commentId` is not a valid UUID", validationErrorResponseSchema, {
      error: "Validation failed",
      details: [{ path: "commentId", message: "Invalid UUID" }],
    }),
    401: unauthorizedResponse,
    404: commentNotFound,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "patch",
  path: "/programs/{programId}/comments/{commentId}",
  tags: ["Comments"],
  summary: "Edit a comment",
  description:
    "Replaces the body and sets `editedAt` (even if the body is unchanged). Mentions are re-parsed: people no longer mentioned are " +
    "removed, new people are added, and people still mentioned keep their original mention record.\n\n" +
    "Rules, in order: the comment must exist (404); the caller must be its author (403 `FORBIDDEN`); then the mention rules " +
    `(400 \`TOO_MANY_MENTIONS\`, 400 \`MENTION_NOT_FOUND\`). People already mentioned in this comment are exempt from the active check, ` +
    "so an old comment stays editable after someone in it was deactivated.\n\n" +
    `${BODY_HEADER}\n\n${AUTH_HEADER}\n\n` +
    "**Authorization / roles:** the comment's **author** only (any role). Anyone else, including ADMINs and MANAGERs, gets 403 `FORBIDDEN`.",
  security: bearerSecurity,
  request: {
    params: commentIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateCommentSchema,
          example: { body: `Draft v2 ready, @[Jane Doe](mention:${ids.jane}) please review` },
        },
      },
    },
  },
  responses: {
    200: jsonResponse("The edited comment", commentEnvelope, {
      data: {
        ...exampleComment,
        body: `Draft v2 ready, @[Jane Doe](mention:${ids.jane}) please review`,
        updatedAt: "2026-10-17T11:30:00.000Z",
        editedAt: "2026-10-17T11:30:00.000Z",
      },
    }),
    400: validation400("Invalid params or body (unknown fields such as `parentId` are rejected), or a mention rule failed (`code`)", {
      validation: { error: "Validation failed", details: [{ path: "", message: 'Unrecognized key: "parentId"' }] },
      ...mentionErrors,
    }),
    401: unauthorizedResponse,
    403: forbidden("`FORBIDDEN`: the caller isn't the comment's author"),
    404: commentNotFound,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "delete",
  path: "/programs/{programId}/comments/{commentId}",
  tags: ["Comments"],
  summary: "Delete a comment",
  description:
    "Soft-deletes the comment and removes its mention records. Replies are kept: a deleted top-level comment with active replies is " +
    "listed as a tombstone (`isActive: false`, `body: null`, `author: null`) until they're deleted too. A deleted comment can't be " +
    "fetched, edited, deleted again or replied to.\n\n" +
    `${AUTH_HEADER}\n\n` +
    "**Authorization / roles:** ADMIN or MANAGER, or the comment's **author** (any role). Anyone else gets 403 `FORBIDDEN`.",
  security: bearerSecurity,
  request: { params: commentIdParamSchema },
  responses: {
    204: { description: "Comment deleted" },
    400: jsonResponse("`programId` or `commentId` is not a valid UUID", validationErrorResponseSchema, {
      error: "Validation failed",
      details: [{ path: "commentId", message: "Invalid UUID" }],
    }),
    401: unauthorizedResponse,
    403: forbidden("`FORBIDDEN`: the caller is a MEMBER who isn't the comment's author"),
    404: commentNotFound,
    500: internalServerErrorResponse,
  },
});
