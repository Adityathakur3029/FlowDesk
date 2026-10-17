// Errors thrown by services; the error middleware turns them into HTTP responses.
// `code` is an optional machine-readable identifier (e.g. "INVITE_EXPIRED").
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
    public readonly code?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code?: string) {
    super(400, message, undefined, code);
  }
}

// Missing or invalid credentials (no token, bad access token, bad Google ID token)
export class UnauthorizedError extends AppError {
  constructor(message: string, code?: string) {
    super(401, message, undefined, code);
  }
}

// Identity is known but access is not allowed (not invited, inactive, wrong role)
export class ForbiddenError extends AppError {
  constructor(message: string, code?: string) {
    super(403, message, undefined, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code?: string, details?: unknown) {
    super(409, message, details, code);
  }
}

// The resource existed but is no longer available (e.g. an expired invite link)
export class GoneError extends AppError {
  constructor(message: string, code?: string) {
    super(410, message, undefined, code);
  }
}

// An upstream dependency (e.g. the mail server) failed
export class BadGatewayError extends AppError {
  constructor(message: string, code?: string) {
    super(502, message, undefined, code);
  }
}

// Postgres error codes we map explicitly
export const PG_UNIQUE_VIOLATION = "23505";

// Drizzle wraps driver errors (DrizzleQueryError), so check the cause as well
export function getPgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 3; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
