import type { Comment } from "../../db/schema";
import type { EmployeeSummary } from "../tasks/task.repository";

// A comment with everything the API returns. `replies` is filled only on top-level comments.
export interface CommentView {
  comment: Comment;
  author: EmployeeSummary;
  mentions: EmployeeSummary[];
  replies: CommentView[];
}

// Public shape of a reply, and the base of a top-level comment (matches commentReplySchema in comment.docs.ts).
// A deleted comment (a tombstone) hides its author, body and mentions.
export function toCommentReplyDto({ comment, author, mentions }: CommentView) {
  const deleted = !comment.isActive;
  return {
    id: comment.id,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    isActive: comment.isActive,
    programId: comment.programId,
    boardId: comment.boardId,
    taskId: comment.taskId,
    parentId: comment.parentId,
    author: deleted ? null : author,
    body: deleted ? null : comment.body,
    editedAt: deleted ? null : comment.editedAt,
    mentions: deleted ? [] : mentions,
  };
}

// Public shape of a comment (matches commentSchema in comment.docs.ts): replies only on top-level comments
export function toCommentDto(view: CommentView) {
  const dto = toCommentReplyDto(view);
  return view.comment.parentId === null ? { ...dto, replies: view.replies.map(toCommentReplyDto) } : dto;
}

export type CommentDto = ReturnType<typeof toCommentDto>;
