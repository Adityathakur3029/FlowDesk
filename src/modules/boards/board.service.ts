import { withTransaction } from "../../db";
import type { Board } from "../../db/schema";
import type { Page } from "../../db/repository";
import { ConflictError, getPgErrorCode, NotFoundError, PG_UNIQUE_VIOLATION } from "../../lib/errors";
import { boardRepository } from "./board.repository";
import type { CreateBoardInput, ListBoardsQuery, UpdateBoardInput } from "./board.validation";

// Boards never close; deleting one hides only the board, never its tasks. See .claude/specs/10-boards.md

const keyTaken = (key: string) => new ConflictError(`Board key ${key} is already taken`, "BOARD_KEY_EXISTS");
const boardNotFound = () => new NotFoundError("Board not found");

export async function createBoard(input: CreateBoardInput): Promise<Board> {
  // Keys of soft-deleted boards stay taken: the unique constraint covers them. Program keys aren't checked.
  const existing = await boardRepository.findByKey(input.key, { includeInactive: true });
  if (existing) throw keyTaken(input.key);
  try {
    return await boardRepository.create({ key: input.key, name: input.name, description: input.description ?? null });
  } catch (err) {
    // Lost a race with a concurrent create of the same key
    if (getPgErrorCode(err) === PG_UNIQUE_VIOLATION) throw keyTaken(input.key);
    throw err;
  }
}

// Unknown and soft-deleted boards are both 404, here and on the board's own routes
export async function getActiveBoard(id: string): Promise<Board> {
  const board = await boardRepository.findById(id);
  if (!board) throw boardNotFound();
  return board;
}

export function listBoards(query: ListBoardsQuery): Promise<Page<Board>> {
  return boardRepository.findPage({
    where: query.q ? boardRepository.searchWhere(query.q) : undefined,
    limit: query.limit,
    offset: query.offset,
  });
}

export function updateBoard(id: string, input: UpdateBoardInput): Promise<Board> {
  return withTransaction(async (tx) => {
    const repo = boardRepository.withTx(tx);
    if (!(await repo.lockForUpdate(id))) throw boardNotFound();
    const updated = await repo.updateById(id, input);
    if (!updated) throw boardNotFound();
    return updated;
  });
}

// Soft delete. The board's tasks stay live: they're still reachable through /tasks/:taskRef
// and still count in the overview report.
export async function deleteBoard(id: string): Promise<void> {
  await getActiveBoard(id);
  await boardRepository.deactivate(id);
}
