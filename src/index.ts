import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export interface RequestActor {
  tenantId: string;
  userId: string;
  role: string;
}

export interface HttpContext<TBody = unknown> {
  req: IncomingMessage;
  res: ServerResponse;
  method: HttpMethod;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: TBody;
  actor: RequestActor;
}

export type Handler = (ctx: HttpContext) => Promise<unknown> | unknown;
export type PermissionChecker = (role: string, permission?: string) => void;

interface RouteDefinition {
  method: HttpMethod;
  path: string;
  regex: RegExp;
  paramNames: string[];
  permission?: string;
  handler: Handler;
}

export class Router {
  private routes: RouteDefinition[] = [];

  constructor(private readonly checkPermission: PermissionChecker = defaultPermissionChecker) {}

  add(method: HttpMethod, path: string, handler: Handler, permission?: string): void {
    const { regex, paramNames } = compilePath(path);
    this.routes.push({ method, path, regex, paramNames, permission, handler });
  }

  get(path: string, handler: Handler, permission?: string): void { this.add("GET", path, handler, permission); }
  post(path: string, handler: Handler, permission?: string): void { this.add("POST", path, handler, permission); }
  put(path: string, handler: Handler, permission?: string): void { this.add("PUT", path, handler, permission); }
  patch(path: string, handler: Handler, permission?: string): void { this.add("PATCH", path, handler, permission); }
  delete(path: string, handler: Handler, permission?: string): void { this.add("DELETE", path, handler, permission); }

  listRoutes(): Array<{ method: string; path: string; permission?: string }> {
    return this.routes.map(({ method, path, permission }) => ({ method, path, permission }));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = String(req.method ?? "GET").toUpperCase() as HttpMethod;
      if (method === "OPTIONS") return jsonResponse(res, 200, { ok: true });
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = normalizePath(url.pathname);
      const route = this.match(method, path);
      if (!route) return jsonResponse(res, 404, { ok: false, error: "Route not found", method, path });

      const role = getHeader(req, "x-role") ?? "viewer";
      this.checkPermission(role, route.permission);
      const actor = {
        tenantId: getHeader(req, "x-tenant-id") ?? process.env.DEFAULT_TENANT_ID ?? "demo-tenant",
        userId: getHeader(req, "x-user-id") ?? `${role}-user`,
        role
      };

      const body = await parseJsonBody(req);
      const result = await route.handler({ req, res, method, path, query: url.searchParams, params: route.params, body, actor });
      if (!res.headersSent) jsonResponse(res, 200, { ok: true, data: result ?? null });
    } catch (error) {
      handleError(res, error);
    }
  }

  private match(method: HttpMethod, path: string): (RouteDefinition & { params: Record<string, string> }) | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1] ?? "");
      });
      return { ...route, params };
    }
    return undefined;
  }
}

export function createOsServer(router: Router) {
  return createServer((req, res) => void router.handle(req, res));
}

export function jsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-role, x-tenant-id, x-user-id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.end(JSON.stringify(payload, null, 2));
}

export async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const method = String(req.method ?? "GET").toUpperCase();
  if (["GET", "DELETE", "OPTIONS"].includes(method)) return undefined;
  const chunks: string[] = [];
  for await (const chunk of req) chunks.push(String(chunk));
  const raw = chunks.join("").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }
}

function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexSource = normalizePath(path)
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        paramNames.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${regexSource}$`), paramNames };
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) return `/${path}`;
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value[0];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function handleError(res: ServerResponse, error: unknown): void {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
  const message = error instanceof Error ? error.message : "Internal server error";
  const details = typeof error === "object" && error !== null && "details" in error ? error.details : undefined;
  jsonResponse(res, Number.isFinite(statusCode) ? statusCode : 500, { ok: false, error: message, details });
}

function defaultPermissionChecker(): void {}
