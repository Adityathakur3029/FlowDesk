import { db, withTransaction, type DbExecutor } from "../../db";
import type { Comment } from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors";
import { employeeRepository } from "../employees/employee.repository";
import { getActiveProgram } from "../programs/program.service";
import type { EmployeeSummary } from "../tasks/task.repository";
import { getActiveTask } from "../tasks/task.service";
import { isUuid } from "../tasks/task.validation";
import type { CommentView } from "./comment.dto";
import { MAX_MENTIONS, parseMentionIds } from "./comment.mentions";
import { commentRepository, type CommentRow, type CommentTarget } from "./comment.repository";
import { commentMentionRepository } from "./commentMention.repository";
import type { CreateCommentInput, ListCommentsQuery, UpdateCommentInput } from "./comment.validation";

const commentNotFound = () => new NotFoundError("Comment not found");
const forbidden = () => new ForbiddenError("You do not have permission to perform this action", "FORBIDDEN");

function groupBy<T, V>(items: T[], keyOf: (item: T) => string, valueOf: (item: T) => V): Map<string, V[]> {
  const groups = new Map<string, V[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(valueOf(item));
    else groups.set(key, [valueOf(item)]);
  }
  return groups;
}

// Attaches mentions to every comment and active replies to top-level ones.
// Sequential: a transaction is one client, which can't run queries in parallel.
async function toViews(executor: DbExecutor, rows: CommentRow[]): Promise<CommentView[]> {
  const topLevelIds = rows.filter((r) => r.comment.parentId === null).map((r) => r.comment.id);
  const replies = await commentRepository.withTx(executor).activeRepliesOf(topLevelIds);
  const mentions = await commentMentionRepository
    .withTx(executor)
    .mentionsFor([...rows, ...replies].map((r) => r.comment.id));

  const mentionsOf = groupBy(mentions, (m) => m.commentId, (m): EmployeeSummary => m.employee);
  const view = (row: CommentRow): CommentView => ({ ...row, mentions: mentionsOf.get(row.comment.id) ?? [], replies: [] });
  const repliesOf = groupBy(replies, (r) => r.comment.parentId!, view);
  return rows.map((row) => ({ ...view(row), replies: repliesOf.get(row.comment.id) ?? [] }));
}

async function loadComment(executor: DbExecutor, commentId: string): Promise<CommentView> {
  const row = await commentRepository.withTx(executor).findRowById(commentId);
  if (!row) throw commentNotFound();
  const [view] = await toViews(executor, [row]);
  return view;
}

// Mention rules: at most MAX_MENTIONS distinct people, each an active employee. On edit, people
// already mentioned in the comment are exempt from the active check. Returns the ids to store.
async function resolveMentions(executor: DbExecutor, body: string, alreadyMentioned: string[] = []): Promise<string[]> {
  const ids = parseMentionIds(body);
  if (ids.length > MAX_MENTIONS) {
    throw new BadRequestError(`A comment can mention at most ${MAX_MENTIONS} people`, "TOO_MANY_MENTIONS");
  }
  const exempt = new Set(alreadyMentioned);
  const toCheck = ids.filter((id) => !exempt.has(id));
  // A 36-character token that isn't a UUID can't be an employee
  const active = await employeeRepository.withTx(executor).findActiveIds(toCheck.filter(isUuid));
  const missing = toCheck.find((id) => !active.has(id));
  if (missing) throw new BadRequestError(`Mentioned employee ${missing} not found or inactive`, "MENTION_NOT_FOUND");
  return ids;
}

// Reply rules, in order: the parent exists, has the same target, and is top-level
async function assertParent(tx: DbExecutor, target: CommentTarget, parentId: string): Promise<void> {
  // Share lock: a concurrent delete of the parent waits until this reply is committed
  const parent = await commentRepository.withTx(tx).findReachable(target.programId, parentId, "share");
  if (!parent) throw new BadRequestError("Parent comment not found", "PARENT_COMMENT_NOT_FOUND");
  if (parent.taskId !== target.taskId) {
    throw new BadRequestError("A reply must be on the same task or program as its parent", "PARENT_TARGET_MISMATCH");
  }
  if (parent.parentId !== null) {
    throw new BadRequestError("Replies can't have replies; reply to the top-level comment", "NESTED_REPLY");
  }
}

async function createComment(target: CommentTarget, input: CreateCommentInput, authorId: string): Promise<CommentView> {
  return withTransaction(async (tx) => {
    if (input.parentId) await assertParent(tx, target, input.parentId);
    const mentionIds = await resolveMentions(tx, input.body);

    const comment = await commentRepository.withTx(tx).create({
      programId: target.programId,
      taskId: target.taskId,
      parentId: input.parentId ?? null,
      authorId,
      body: input.body,
    });
    await commentMentionRepository.withTx(tx).replaceForComment(target.programId, comment.id, mentionIds);
    return loadComment(tx, comment.id);
  });
}

async function listThreads(target: CommentTarget, query: ListCommentsQuery) {
  const page = await commentRepository.listThreads(target, query);
  return { ...page, items: await toViews(db, page.items) };
}

// Locks the comment row so concurrent edits, deletes and replies to it run one at a time
async function findForWrite(tx: DbExecutor, programId: string, commentId: string): Promise<Comment> {
  const comment = await commentRepository.withTx(tx).findReachable(programId, commentId, "update");
  if (!comment) throw commentNotFound();
  return comment;
}

export async function listProgramComments(programId: string, query: ListCommentsQuery) {
  await getActiveProgram(programId);
  return listThreads({ programId, taskId: null }, query);
}

export async function listTaskComments(programId: string, taskRef: string, query: ListCommentsQuery) {
  const task = await getActiveTask(programId, taskRef);
  return listThreads({ programId, taskId: task.id }, query);
}

export async function createProgramComment(
  programId: string,
  input: CreateCommentInput,
  authorId: string,
): Promise<CommentView> {
  await getActiveProgram(programId);
  return createComment({ programId, taskId: null }, input, authorId);
}

export async function createTaskComment(
  programId: string,
  taskRef: string,
  input: CreateCommentInput,
  authorId: string,
): Promise<CommentView> {
  const task = await getActiveTask(programId, taskRef);
  return createComment({ programId, taskId: task.id }, input, authorId);
}

// Program or task comment by id; deleted comments, tombstones and comments on deleted tasks are 404
export async function getComment(programId: string, commentId: string): Promise<CommentView> {
  await getActiveProgram(programId);
  const comment = await commentRepository.findReachable(programId, commentId);
  if (!comment) throw commentNotFound();
  return loadComment(db, comment.id);
}

// Author only. Sets editedAt on every edit and diffs comment_mentions.
export async function updateComment(
  programId: string,
  commentId: string,
  input: UpdateCommentInput,
  auth: AuthContext,
): Promise<CommentView> {
  await getActiveProgram(programId);
  return withTransaction(async (tx) => {
    const comment = await findForWrite(tx, programId, commentId);
    if (comment.authorId !== auth.employeeId) throw forbidden();

    const mentionRepo = commentMentionRepository.withTx(tx);
    const mentionIds = await resolveMentions(tx, input.body, await mentionRepo.employeeIdsFor(comment.id));
    await commentRepository.withTx(tx).updateById(comment.id, { body: input.body, editedAt: new Date() });
    await mentionRepo.replaceForComment(programId, comment.id, mentionIds);
    return loadComment(tx, comment.id);
  });
}

// Soft delete by the author, a MANAGER or an ADMIN. Replies stay; mention rows are removed.
export async function deleteComment(programId: string, commentId: string, auth: AuthContext): Promise<void> {
  await getActiveProgram(programId);
  await withTransaction(async (tx) => {
    const comment = await findForWrite(tx, programId, commentId);
    const canDelete = auth.role === "ADMIN" || auth.role === "MANAGER" || comment.authorId === auth.employeeId;
    if (!canDelete) throw forbidden();

    await commentRepository.withTx(tx).deactivate(comment.id);
    await commentMentionRepository.withTx(tx).deleteForComment(comment.id);
  });
}
