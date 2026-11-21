import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors/index.js";
import { logger } from "../../infra/logger.js";

export const errorHandler: ErrorRequestHandler = (
    err,
    req,
    res,
    _next,
) => {
    const isOperational = err instanceof AppError;

    const status = isOperational ? err.status : 500;
    const code = isOperational ? err.code : "INTERNAL_SERVER_ERROR";
    const message = isOperational
        ? err.message
        : "Internal server error";

    if (isOperational) {
        logger.warn(
            {
                err,
                requestId: res.locals.requestId,
            },
            "Request failed",
        );
    } else {
        logger.error(
            {
                err,
                requestId: res.locals.requestId,
            },
            "Unexpected server error",
        );
    }

    res.status(status).json({
        error: {
            code,
            message,
            details: isOperational ? err.details ?? null : null,
            requestId: res.locals.requestId,
        },
    });
};