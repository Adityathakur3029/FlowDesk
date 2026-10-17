import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import * as authController from "./auth.controller";

export const authRouter = Router();

authRouter.post("/google", authController.googleLogin);
authRouter.get("/me", requireAuth, authController.me);
