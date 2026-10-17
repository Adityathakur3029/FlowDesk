import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, getPgErrorCode, PG_UNIQUE_VIOLATION } from "../lib/errors";

// Express 5 forwards rejected async handlers here automatically
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  // express.json() rejects unparseable bodies with a SyntaxError of type entity.parse.failed
  if ((err as { type?: unknown }).type === "entity.parse.failed") {
    res.status(400).json({
      error: "Malformed JSON body",
      details: [{ path: "", message: (err as Error).message }],
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code, details: err.details });
    return;
  }

  if (getPgErrorCode(err) === PG_UNIQUE_VIOLATION) {
    res.status(409).json({ error: "Resource already exists" });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
