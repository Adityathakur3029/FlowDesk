import { Router } from "express";
import * as employeeController from "./employee.controller";

export const employeeRouter = Router();

employeeRouter.post("/", employeeController.create);
employeeRouter.get("/", employeeController.list);
employeeRouter.get("/:id", employeeController.getById);
