import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../db/repository";
import { programIdParamSchema } from "../programs/program.validation";
import { MAX_MENTIONS } from "./comment.mentions";

// These schemas validate requests at runtime and also generate the OpenAPI docs
// (see comment.docs.ts), so keep the `.meta` descriptions accurate.

export const MAX_COMMENT_LENGTH = 10_000;

const bodySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_COMMENT_LENGTH)
  .meta({
    description:
      `Markdown, trimmed, 1-${MAX_COMMENT_LENGTH.toLocaleString("en-US")} characters, stored as sent. ` +
      "Mention someone with the token `@[Display Name](mention:<employee uuid>)`, e.g. " +
      "`@[Jane Doe](mention:baac08e5-eaef-46f0-ac9e-f8b7266c71e0)` (the frontend inserts it from an @-autocomplete backed by " +
      "`GET /employees`). The UUID identifies the person; the label is display text only and isn't checked. A plain `@jane` is just text. " +
      `At most ${MAX_MENTIONS} distinct people, each an active employee. ` +
      "The API stores the Markdown as-is, so clients must render it **sanitised**.",
    example: "Draft ready, @[Jane Doe](mention:baac08e5-eaef-46f0-ac9e-f8b7266c71e0) please review",
  });

export const createCommentSchema = z
  .object({
    body: bodySchema,
    parentId: z.uuid().optional().meta({
      description:
        "Reply to this comment. It must be an active, top-level comment on the same program or task. Omit for a new top-level comment.",
      example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
    }),
  })
  .meta({ id: "CreateCommentRequest", description: "The author is the signed-in employee." });

export const updateCommentSchema = z
  .strictObject({ body: bodySchema })
  .meta({ id: "UpdateCommentRequest", description: "Only `body` can change; any other field (including `parentId`) is rejected." });

export const commentIdParamSchema = programIdParamSchema.extend({
  commentId: z.uuid().meta({ description: "Comment id (UUID)", example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d" }),
});

export const listCommentsQuerySchema = z.object({
  order: z.enum(["asc", "desc"]).default("asc").meta({
    description: "Order of top-level comments by `createdAt`: `asc` (oldest first, the default) or `desc`. Replies are always oldest first.",
    example: "asc",
  }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).meta({
    description: `Threads (top-level comments) per page, 1-${MAX_PAGE_SIZE}. Each comes with all of its replies.`,
    example: 20,
  }),
  offset: z.coerce.number().int().min(0).default(0).meta({
    description: "Number of threads to skip",
    nullable: false,
    example: 0,
  }),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;
