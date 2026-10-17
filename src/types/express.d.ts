import type { AuthContext } from "../middleware/auth";

// Set by requireAuth (src/middleware/auth.ts)
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
