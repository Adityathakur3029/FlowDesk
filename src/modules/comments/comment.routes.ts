import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import * as commentController from "./comment.controller";

// Edit (author only) and delete (author, MANAGER or ADMIN) permissions are checked in the service.

// Mounted at /programs/:programId/comments; mergeParams exposes :programId.
// Lists and creates program-level comments; get/edit/delete by id work for task comments too.
export const programCommentRouter = Router({ mergeParams: true });

programCommentRouter.get("/", requireAuth, commentController.listForProgram);
programCommentRouter.post("/", requireAuth, commentController.createForProgram);
programCommentRouter.get("/:commentId", requireAuth, commentController.getById);
programCommentRouter.patch("/:commentId", requireAuth, commentController.update);
programCommentRouter.delete("/:commentId", requireAuth, commentController.remove);

// Mounted at /programs/:programId/tasks/:taskRef/comments
export const taskCommentRouter = Router({ mergeParams: true });

taskCommentRouter.get("/", requireAuth, commentController.listForTask);
taskCommentRouter.post("/", requireAuth, commentController.createForTask);

// Mounted at /tasks/:taskRef/comments: any reachable task, in a program or a board.
// Get/edit/delete by id only find comments on this task.
export const taskRefCommentRouter = Router({ mergeParams: true });

taskRefCommentRouter.get("/", requireAuth, commentController.listForTask);
taskRefCommentRouter.post("/", requireAuth, commentController.createForTask);
taskRefCommentRouter.get("/:commentId", requireAuth, commentController.getForTask);
taskRefCommentRouter.patch("/:commentId", requireAuth, commentController.updateForTask);
taskRefCommentRouter.delete("/:commentId", requireAuth, commentController.removeForTask);
