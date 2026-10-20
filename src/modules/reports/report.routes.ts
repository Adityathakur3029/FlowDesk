import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import * as reportController from "./report.controller";

// Organisation-level reports, mounted at /reports
export const reportRouter = Router();

reportRouter.get("/overview", requireAuth, reportController.overview);
