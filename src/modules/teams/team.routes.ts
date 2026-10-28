import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import * as teamController from "./team.controller";

// Organisation-level, so mounted at /teams (not under a program)
export const teamRouter = Router();

teamRouter.post("/", requireAuth, requireRole("ADMIN", "MANAGER"), teamController.create);
teamRouter.get("/", requireAuth, teamController.list);
teamRouter.get("/:teamId", requireAuth, teamController.getById);
teamRouter.patch("/:teamId", requireAuth, requireRole("ADMIN", "MANAGER"), teamController.update);
teamRouter.delete("/:teamId", requireAuth, requireRole("ADMIN"), teamController.remove);
teamRouter.get("/:teamId/members", requireAuth, teamController.listMembers);
teamRouter.put("/:teamId/members/:employeeId", requireAuth, requireRole("ADMIN", "MANAGER"), teamController.addMember);
teamRouter.delete("/:teamId/members/:employeeId", requireAuth, requireRole("ADMIN", "MANAGER"), teamController.removeMember);
