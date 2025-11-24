// Custom error base class
export class AppError extends Error {
  public statusCode: number;
  public context?: Record<string, unknown>;

  constructor(message: string, statusCode = 500, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 400, context);
  }
}

export class AuthError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 401, context);
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string, statusCode = 502, context?: Record<string, unknown>) {
    super(message, statusCode, context);
  }
} 