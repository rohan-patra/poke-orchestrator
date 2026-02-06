/**
 * Base application error with structured fields for logging and MCP responses.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>,
    options?: { cause?: Error }
  ) {
    super(message, options);
    this.name = 'AppError';
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      ...(this.details && { details: this.details }),
      ...(this.cause instanceof Error && { cause: this.cause.message }),
    };
  }
}

export class SessionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: Error }) {
    super(message, 'SESSION_ERROR', 400, details, options);
    this.name = 'SessionError';
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, { sessionId });
    this.code = 'SESSION_NOT_FOUND';
    this.name = 'SessionNotFoundError';
  }
}

export class SessionLimitError extends SessionError {
  constructor(maxSessions: number) {
    super(`Maximum number of sessions (${maxSessions}) reached`, { maxSessions });
    this.code = 'SESSION_LIMIT_REACHED';
    this.statusCode = 429;
    this.name = 'SessionLimitError';
  }
}

export class SessionStateError extends SessionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = 'SESSION_STATE_ERROR';
    this.name = 'SessionStateError';
  }
}

export class WorkspaceError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: Error }) {
    super(message, 'WORKSPACE_ERROR', 500, details, options);
    this.name = 'WorkspaceError';
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(sessionId: string) {
    super(`Workspace not found for session: ${sessionId}`, { sessionId });
    this.code = 'WORKSPACE_NOT_FOUND';
    this.statusCode = 404;
    this.name = 'WorkspaceNotFoundError';
  }
}

export class FileAccessError extends WorkspaceError {
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: Error }) {
    super(message, details, options);
    this.code = 'FILE_ACCESS_ERROR';
    this.name = 'FileAccessError';
  }
}

export class WebhookError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: Error }) {
    super(message, 'WEBHOOK_ERROR', 502, details, options);
    this.name = 'WebhookError';
  }
}

export class PokeApiError extends AppError {
  constructor(message: string, statusCode: number, details?: Record<string, unknown>) {
    super(message, 'POKE_API_ERROR', statusCode, details);
    this.name = 'PokeApiError';
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: Error }) {
    super(message, 'CONFIG_ERROR', 500, details, options);
    this.name = 'ConfigError';
  }
}

/**
 * Type guard for AppError instances.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
