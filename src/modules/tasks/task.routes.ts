import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import * as taskController from "./task.controller";

// Mounted at /programs/:programId/tasks; mergeParams exposes :programId.
// Delete permission (ADMIN, MANAGER or the reporter) is checked in the service.
export const taskRouter = Router({ mergeParams: true });

taskRouter.post("/", requireAuth, taskController.create);
taskRouter.get("/", requireAuth, taskController.list);
taskRouter.get("/:taskRef", requireAuth, taskController.getByRef);
taskRouter.patch("/:taskRef", requireAuth, taskController.update);
taskRouter.delete("/:taskRef", requireAuth, taskController.remove);
taskRouter.post("/:taskRef/dependencies", requireAuth, taskController.addDependency);
taskRouter.delete("/:taskRef/dependencies/:dependsOnTaskId", requireAuth, taskController.removeDependency);
