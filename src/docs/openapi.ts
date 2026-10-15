import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";

// Side-effect imports: each registers its routes on the shared registry
import "./health.docs";
import "../modules/employees/employee.docs";

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "FlowDesk API",
      version: "1.0.0",
      description:
        "Backend for FlowDesk, a mini Jira-style project management tool.\n\n" +
        "Authentication is not implemented yet, so every endpoint is public. " +
        "All request and response bodies are JSON.",
    },
    servers: [{ url: "/", description: "Current host" }],
    tags: [
      { name: "Health", description: "Service status" },
      { name: "Employees", description: "Organisation employees" },
    ],
  });
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
