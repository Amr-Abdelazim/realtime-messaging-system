import { createApp } from "./http/app.js";
import { env } from "./config/env.js";
import { logger } from "./infra/logger.js";

const app = createApp();

app.listen(env.PORT, () => {
    logger.info(
        { port: env.PORT },
        "API server started",
    );
});