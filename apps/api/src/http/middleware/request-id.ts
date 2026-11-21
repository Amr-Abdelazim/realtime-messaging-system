import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
    const incomingId = req.headers["x-request-id"];

    const requestId =
        typeof incomingId === "string" && incomingId.trim().length > 0
            ? incomingId
            : randomUUID();

    res.setHeader("x-request-id", requestId);

    res.locals.requestId = requestId;

    next();
};