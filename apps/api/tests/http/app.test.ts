import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../../src/http/app.js";

describe("HTTP application", () => {
    const app = createApp();

    it("GET /health should return 200", async () => {
        const response = await request(app).get("/health");

        expect(response.status).toBe(200);
        expect(response.body.status).toBe("ok");
        expect(response.body.uptime).toBeTypeOf("number");
    });

    it("should return 404 for unknown routes", async () => {
        const response = await request(app).get("/unknown");

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("NOT_FOUND");
        expect(response.body.error.requestId).toBeDefined();
    });
});