export type AppErrorKind = "aborted" | "auth" | "contract" | "http" | "network" | "permission" | "timeout";

export interface AppErrorOptions {
  kind: AppErrorKind;
  status?: number;
  code?: string;
  requestId?: string;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
