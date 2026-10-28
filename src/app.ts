import "dotenv/config";
import express, { Request, Response, Router } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { pool } from "./db";
import { buildOpenApiDocument } from "./docs/openapi";
import { authRouter } from "./modules/auth/auth.routes";
import { employeeRouter } from "./modules/employees/employee.routes";
import { inviteRouter } from "./modules/invites/invite.routes";
import { teamRouter } from "./modules/teams/team.routes";
import { programRouter } from "./modules/programs/program.routes";
import { boardRouter } from "./modules/boards/board.routes";
import { boardTaskRouter, taskByRefRouter, taskRouter } from "./modules/tasks/task.routes";
import { programCommentRouter, taskCommentRouter, taskRefCommentRouter } from "./modules/comments/comment.routes";
import { reportRouter } from "./modules/reports/report.routes";
import { errorHandler } from "./middleware/errorHandler";

// Feature routers and their mount paths. Mount routers here (not with ad-hoc app.use)
// so `npm run docs:validate` can check every route has OpenAPI docs.
export const routeModules: ReadonlyArray<{ basePath: string; router: Router }> = [
  { basePath: "/auth", router: authRouter },
  { basePath: "/employees", router: employeeRouter },
  { basePath: "/invites", router: inviteRouter },
  { basePath: "/teams", router: teamRouter },
  // Most specific first
  { basePath: "/programs/:programId/tasks/:taskRef/comments", router: taskCommentRouter },
  { basePath: "/programs/:programId/comments", router: programCommentRouter },
  { basePath: "/programs/:programId/tasks", router: taskRouter },
  { basePath: "/programs", router: programRouter },
  { basePath: "/boards/:boardId/tasks", router: boardTaskRouter },
  { basePath: "/boards", router: boardRouter },
  // Any task by UUID or key, whatever its parent
  { basePath: "/tasks/:taskRef/comments", router: taskRefCommentRouter },
  { basePath: "/tasks", router: taskByRefRouter },
  { basePath: "/reports", router: reportRouter },
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
