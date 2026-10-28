import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import * as programController from "./program.controller";

export const programRouter = Router();

programRouter.post("/", requireAuth, requireRole("ADMIN", "MANAGER"), programController.create);
programRouter.get("/", requireAuth, programController.list);
programRouter.get("/:programId", requireAuth, programController.getById);
programRouter.patch("/:programId", requireAuth, requireRole("ADMIN", "MANAGER"), programController.update);
programRouter.delete("/:programId", requireAuth, requireRole("ADMIN"), programController.remove);
programRouter.get("/:programId/labels", requireAuth, programController.listLabels);
