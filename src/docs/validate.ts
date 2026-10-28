import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI } from "openapi-types";
import { app, routeModules } from "../app";
import { pool } from "../db";
import { buildOpenApiDocument } from "./openapi";

// Routes that serve the docs themselves and aren't part of the API
const UNDOCUMENTED_ROUTES = new Set(["GET /openapi.json"]);
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

// "/employees" + "/:id" -> "/employees/{id}"
function toOpenApiPath(basePath: string, routePath: string): string {
  const joined = `${basePath}${routePath === "/" ? "" : routePath}` || "/";
  return joined.replace(/:(\w+)/g, "{$1}");
}

function routesOf(stack: RouteLayer[], basePath: string): string[] {
  return stack.flatMap(({ route }) =>
    route
      ? Object.keys(route.methods)
          .filter((m) => m !== "_all")
          .map((m) => `${m.toUpperCase()} ${toOpenApiPath(basePath, route.path)}`)
      : [],
  );
}

function implementedRoutes(): Set<string> {
  const appStack = (app as unknown as { router: { stack: RouteLayer[] } }).router.stack;
  const routes = [
    ...routesOf(appStack, ""),
    ...routeModules.flatMap(({ basePath, router }) => routesOf(router.stack as RouteLayer[], basePath)),
  ];
  return new Set(routes.filter((r) => !UNDOCUMENTED_ROUTES.has(r)));
}

function documentedRoutes(doc: ReturnType<typeof buildOpenApiDocument>): Set<string> {
  const routes = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
    HTTP_METHODS.filter((m) => m in (item as object)).map((m) => `${m.toUpperCase()} ${path}`),
  );
  return new Set(routes);
}

async function main(): Promise<void> {
  const doc = buildOpenApiDocument();

  // Validates against the OpenAPI schema and resolves every $ref (works on a copy)
  await SwaggerParser.validate(structuredClone(doc) as OpenAPI.Document);
  console.log("OpenAPI document is valid");

  const implemented = implementedRoutes();
  const documented = documentedRoutes(doc);
  const missingDocs = [...implemented].filter((r) => !documented.has(r));
  const staleDocs = [...documented].filter((r) => !implemented.has(r));

  if (missingDocs.length) console.error("Routes without OpenAPI docs:\n  " + missingDocs.join("\n  "));
  if (staleDocs.length) console.error("Documented routes that don't exist:\n  " + staleDocs.join("\n  "));
  if (missingDocs.length || staleDocs.length) {
    process.exitCode = 1;
    return;
  }
  console.log(`All ${implemented.size} routes are documented:\n  ${[...implemented].join("\n  ")}`);
}

main()
  .catch((err) => {
    console.error("OpenAPI validation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
