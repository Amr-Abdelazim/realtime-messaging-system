import { z } from "zod";

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({
    path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
});


const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),

    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().url(),

    DATABASE_URL_TEST: z.string().url(),

    REDIS_URL: z.string().url(),
    CORS_ORIGINS: z.string().default("http://localhost:5173"),

    LOG_LEVEL: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace"])
        .default("debug"),
});

function validateEnv() {
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        console.error("Invalid environment configuration:");

        for (const issue of result.error.issues) {
            console.error(`- ${issue.path.join(".")}: ${issue.message}`);
        }

        process.exit(1);
    }

    return result.data;
}

export const env = validateEnv();