import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";

// Side-effect imports: each registers its routes on the shared registry
import "./health.docs";
import "../modules/auth/auth.docs";
import "../modules/employees/employee.docs";
import "../modules/invites/invite.docs";
import "../modules/teams/team.docs";
import "../modules/programs/program.docs";
import "../modules/tasks/task.docs";
import "../modules/comments/comment.docs";
import "../modules/reports/report.docs";

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "FlowDesk API",
      version: "1.0.0",
      description:
        "Backend for FlowDesk, a mini Jira-style project management tool.\n\n" +
        "**Authentication:** sign in with Google via `POST /auth/google` to get an access token, then send it as " +
        "`Authorization: Bearer <accessToken>` (the `bearerAuth` scheme; use **Authorize** in Swagger UI). " +
        "Only invited, active employees can sign in. Each operation states whether it needs a token and which roles may call it. " +
        "All request and response bodies are JSON.",
    },
    servers: [{ url: "/", description: "Current host" }],
    tags: [
      { name: "Health", description: "Service status" },
      { name: "Auth", description: "Sign in with Google and get the current employee" },
      { name: "Employees", description: "Organisation employees" },
      { name: "Invites", description: "Invite new members by email and accept invites" },
      { name: "Teams", description: "Teams of employees; every program has an owner team" },
      { name: "Programs", description: "Programs, the core entity that owns tasks and future research content" },
      { name: "Tasks", description: "Jira-style tasks within a program, including dependencies" },
      { name: "Comments", description: "Discussion threads on programs and tasks, with @mentions" },
      { name: "Reports", description: "Organisation-wide reports computed from programs and tasks" },
    ],
  });
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
