import pino from "pino";
import { config } from "./config.js";

export const log = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
  transport: config.NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { colorize: true } },
});
