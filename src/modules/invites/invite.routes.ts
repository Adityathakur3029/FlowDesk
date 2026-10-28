import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import * as inviteController from "./invite.controller";

export const inviteRouter = Router();

inviteRouter.post("/", requireAuth, requireRole("ADMIN", "MANAGER"), inviteController.create);
// Public: the invitee has no account yet
inviteRouter.post("/accept", inviteController.accept);
