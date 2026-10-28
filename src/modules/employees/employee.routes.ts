import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import * as employeeController from "./employee.controller";

export const employeeRouter = Router();

employeeRouter.post("/", requireAuth, requireRole("ADMIN"), employeeController.create);
employeeRouter.get("/", requireAuth, employeeController.list);
employeeRouter.get("/:id", requireAuth, employeeController.getById);
employeeRouter.patch("/:id", requireAuth, requireRole("ADMIN"), employeeController.update);
