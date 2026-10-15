import { z } from "zod";
import { jsonResponse, PUBLIC_ACCESS_NOTE, registry } from "./registry";

const healthOkSchema = registry.register(
  "HealthOk",
  z.object({
    status: z.literal("ok"),
    dbTime: z.iso.datetime().meta({ description: "Current database server time" }),
  }),
);

const healthErrorSchema = registry.register(
  "HealthError",
  z.object({
    status: z.literal("error"),
    message: z.string(),
  }),
);

registry.registerPath({
  method: "get",
  path: "/health-check",
  tags: ["Health"],
  summary: "Service and database health check",
  description: `Runs \`SELECT NOW()\` against PostgreSQL and returns the database time.\n\n${PUBLIC_ACCESS_NOTE}`,
  security: [],
  responses: {
    200: jsonResponse("Service is up and the database is reachable", healthOkSchema, {
      status: "ok",
      dbTime: "2026-10-15T14:13:43.757Z",
    }),
    500: jsonResponse("Database is unreachable", healthErrorSchema, {
      status: "error",
      message: "Database unreachable",
    }),
  },
});
