import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import * as boardController from "./board.controller";

// Board tasks are served by boardTaskRouter (/boards/:boardId/tasks) and taskByRefRouter (/tasks)
export const boardRouter = Router();

boardRouter.post("/", requireAuth, requireRole("ADMIN", "MANAGER"), boardController.create);
boardRouter.get("/", requireAuth, boardController.list);
boardRouter.get("/:boardId", requireAuth, boardController.getById);
boardRouter.patch("/:boardId", requireAuth, requireRole("ADMIN", "MANAGER"), boardController.update);
boardRouter.delete("/:boardId", requireAuth, requireRole("ADMIN"), boardController.remove);
boardRouter.get("/:boardId/labels", requireAuth, boardController.listLabels);
