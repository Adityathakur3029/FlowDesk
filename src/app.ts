import "dotenv/config";
import express, { Request, Response, Router } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { pool } from "./db";
import { buildOpenApiDocument } from "./docs/openapi";
import { employeeRouter } from "./modules/employees/employee.routes";
import { errorHandler } from "./middleware/errorHandler";

// Feature routers and their mount paths. Mount routers here (not with ad-hoc app.use)
// so `npm run docs:validate` can check every route has OpenAPI docs.
export const routeModules: ReadonlyArray<{ basePath: string; router: Router }> = [
  { basePath: "/employees", router: employeeRouter },
];

export const app = express();

// Middleware: allow cross-origin requests and parse JSON bodies
app.use(cors());
app.use(express.json());

// Health check that also verifies the database connection
app.get("/health-check", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");
    res.json({ status: "ok", dbTime: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "Database unreachable" });
  }
});

// API documentation
const openApiDocument = buildOpenApiDocument();
app.get("/openapi.json", (_req: Request, res: Response) => {
  res.json(openApiDocument);
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

for (const { basePath, router } of routeModules) {
  app.use(basePath, router);
}

// Must be registered after all routes
app.use(errorHandler);
