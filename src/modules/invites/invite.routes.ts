import { Router } from "express";
import * as inviteController from "./invite.controller";

export const inviteRouter = Router();

inviteRouter.post("/", inviteController.create);
inviteRouter.post("/accept", inviteController.accept);
