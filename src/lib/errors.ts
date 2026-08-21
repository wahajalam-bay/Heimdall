/** Typed application errors so server actions can return structured failures. */

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "You must sign in to continue.") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Record") {
    super("NOT_FOUND", `${what} not found.`, 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION", message, 422, details);
    this.name = "ValidationError";
  }
}

/** A business rule blocked the operation (data-integrity guard). */
export class RuleViolationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("RULE_VIOLATION", message, 409, details);
    this.name = "RuleViolationError";
  }
}

export type ActionResult<T = unknown> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; code: string; details?: unknown };

export function toActionError(e: unknown): ActionResult<never> {
  if (e instanceof AppError) {
    return { ok: false, error: e.message, code: e.code, details: e.details };
  }
  if (e instanceof Error) {
    // Surface unique-constraint collisions readably.
    if (e.message.includes("Unique constraint")) {
      return { ok: false, error: "A record with these details already exists.", code: "DUPLICATE" };
    }
    return { ok: false, error: e.message, code: "INTERNAL" };
  }
  return { ok: false, error: "An unexpected error occurred.", code: "INTERNAL" };
}
