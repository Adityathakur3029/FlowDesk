import type { Board } from "../../db/schema";

// Public shape of a board (matches boardSchema in board.docs.ts)
export function toBoardDto(board: Board) {
  return {
    id: board.id,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    isActive: board.isActive,
    key: board.key,
    name: board.name,
    description: board.description,
  };
}

export type BoardDto = ReturnType<typeof toBoardDto>;
