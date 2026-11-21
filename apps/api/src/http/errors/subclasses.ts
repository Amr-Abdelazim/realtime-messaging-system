import { AppError } from "./app-error.js";

export class ValidationError extends AppError {
    constructor(message: string, details?: unknown) {
        super("VALIDATION_ERROR", 400, message, details);
    }
}

export class UnauthenticatedError extends AppError {
    constructor(message = "Authentication required") {
        super("UNAUTHENTICATED", 401, message);
    }
}

export class ForbiddenError extends AppError {
    constructor(message = "Access forbidden") {
        super("FORBIDDEN", 403, message);
    }
}

export class NotFoundError extends AppError {
    constructor(message = "Resource not found") {
        super("NOT_FOUND", 404, message);
    }
}

export class ConflictError extends AppError {
    constructor(message: string, details?: unknown) {
        super("CONFLICT", 409, message, details);
    }
}

export class RateLimitedError extends AppError {
    constructor(message = "Too many requests") {
        super("RATE_LIMITED", 429, message);
    }
}