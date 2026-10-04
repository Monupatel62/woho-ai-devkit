export class AIError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
  constructor(message: string, code = "AI_ERROR", retryable = false, cause?: unknown) {
    super(message);
    this.name = "AIError";
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}
export class AuthenticationError extends AIError {
  constructor(message = "Authentication failed", cause?: unknown) { super(message, "AUTHENTICATION_ERROR", false, cause); this.name = "AuthenticationError"; }
}
export class RateLimitError extends AIError {
  constructor(message = "Rate limit exceeded", cause?: unknown) { super(message, "RATE_LIMIT_ERROR", true, cause); this.name = "RateLimitError"; }
}
export class InvalidRequestError extends AIError {
  constructor(message = "Invalid AI request", cause?: unknown) { super(message, "INVALID_REQUEST_ERROR", false, cause); this.name = "InvalidRequestError"; }
}
export class ModelNotFoundError extends AIError {
  constructor(message = "Model not found", cause?: unknown) { super(message, "MODEL_NOT_FOUND", false, cause); this.name = "ModelNotFoundError"; }
}
export class TimeoutError extends AIError {
  constructor(message = "AI request timed out", cause?: unknown) { super(message, "TIMEOUT_ERROR", true, cause); this.name = "TimeoutError"; }
}
export class NetworkError extends AIError {
  constructor(message = "Network request failed", cause?: unknown) { super(message, "NETWORK_ERROR", true, cause); this.name = "NetworkError"; }
}