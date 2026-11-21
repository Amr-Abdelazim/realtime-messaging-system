import type { RequestHandler } from "express";
import { logger } from "../../infra/logger.js";

export const requestLogger: RequestHandler = (req, res, next) => {
    const startTime = process.hrtime.bigint();

    res.on("finish", () => {
        const duration =
            Number(process.hrtime.bigint() - startTime) / 1_000_000;

        logger.info(
            {
                requestId: res.locals.requestId,
                method: req.method,
                url: req.originalUrl,
                statusCode: res.statusCode,
                durationMs: Number(duration.toFixed(2)),
            },
            "Request completed",
        );
    });

    next();
};