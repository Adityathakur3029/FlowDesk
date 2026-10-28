import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import * as taskController from "./task.controller";

// Delete permission (ADMIN, MANAGER or the reporter) is checked in the service.

// Mounted at /programs/:programId/tasks; mergeParams exposes :programId.
export const taskRouter = Router({ mergeParams: true });

taskRouter.post("/", requireAuth, taskController.create);
taskRouter.get("/", requireAuth, taskController.list);
taskRouter.get("/:taskRef", requireAuth, taskController.getByRef);
taskRouter.patch("/:taskRef", requireAuth, taskController.update);
taskRouter.delete("/:taskRef", requireAuth, taskController.remove);
taskRouter.post("/:taskRef/dependencies", requireAuth, taskController.addDependency);
taskRouter.delete("/:taskRef/dependencies/:dependsOnTaskId", requireAuth, taskController.removeDependency);

// Mounted at /boards/:boardId/tasks; mergeParams exposes :boardId. Single board tasks live under /tasks.
export const boardTaskRouter = Router({ mergeParams: true });

boardTaskRouter.post("/", requireAuth, taskController.create);
boardTaskRouter.get("/", requireAuth, taskController.list);

// Mounted at /tasks: any reachable task by UUID or key, in a program or a board
export const taskByRefRouter = Router();

taskByRefRouter.get("/:taskRef", requireAuth, taskController.getByRef);
taskByRefRouter.patch("/:taskRef", requireAuth, taskController.update);
taskByRefRouter.delete("/:taskRef", requireAuth, taskController.remove);
taskByRefRouter.post("/:taskRef/dependencies", requireAuth, taskController.addDependency);
taskByRefRouter.delete("/:taskRef/dependencies/:dependsOnTaskId", requireAuth, taskController.removeDependency);
