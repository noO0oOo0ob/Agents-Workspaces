import { existsSync } from "node:fs";
import { resolve } from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { registerAgUiGateway } from "./ag-ui-gateway.js";
import { AgentBoardRuntime } from "./runtime.js";

const idParams = z.object({ id: z.string().min(1) });
const profileInput = z.object({
  name: z.string().trim().min(1), type: z.enum(["native", "docker"]), provider: z.enum(["codex", "claude"]),
  image: z.string().nullable().default(null), environment: z.record(z.string()).default({}),
});
const workspaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  rootPath: z.string().trim().min(1).optional(),
  branchName: z.string().trim().min(1).optional(),
});
const workspaceProjectInput = z.discriminatedUnion("sourceType", [
  z.object({ sourceType: z.literal("remote"), remoteUrl: z.string().trim().min(1) }),
  z.object({ sourceType: z.literal("local"), localPath: z.string().trim().min(1) }),
]);
const agentTaskInput = z.object({
  title: z.string().trim().min(1).max(200), provider: z.enum(["codex", "claude"]),
  executorType: z.enum(["native", "docker"]), prompt: z.string().trim().min(1),
  executionProfileId: z.string().optional(), startImmediately: z.boolean().default(true),
});

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error("Invalid request") as Error & { statusCode: number; details: unknown };
    error.statusCode = 400;
    error.details = result.error.flatten();
    throw error;
  }
  return result.data;
}

export async function createApp(runtime = new AgentBoardRuntime()): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    const remote = request.ip.replace(/^::ffff:/, "");
    const loopback = remote === "127.0.0.1" || remote === "::1";
    if (request.url.startsWith("/api/hooks/claude")) {
      if (request.headers.authorization !== `Bearer ${runtime.config.hookToken}`) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      return;
    }
    if (!loopback) return reply.code(403).send({ error: "local_access_only" });
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:");
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const status = "statusCode" in normalized && typeof normalized.statusCode === "number" ? normalized.statusCode : 500;
    reply.code(status).send({
      error: status >= 500 ? "internal_error" : "invalid_request",
      message: normalized.message,
      ...("details" in normalized ? { details: normalized.details } : {}),
    });
  });

  app.get("/api/health", async () => runtime.health());
  registerAgUiGateway(app, runtime);

  app.get("/api/workspaces", async () => ({ items: runtime.listWorkspaceDetails() }));
  app.post("/api/workspaces", async (request, reply) => {
    const input = parsed(workspaceInput, request.body);
    return reply.code(201).send(await runtime.createWorkspace({
      name: input.name,
      ...(input.rootPath ? { rootPath: input.rootPath } : {}),
      ...(input.branchName ? { branchName: input.branchName } : {}),
    }));
  });
  app.get("/api/workspaces/:id", async (request) => runtime.workspaceDetails(parsed(idParams, request.params).id));
  app.post("/api/workspaces/:id/projects", async (request, reply) => {
    const { id } = parsed(idParams, request.params);
    return reply.code(201).send(await runtime.addProjectToWorkspace(id, parsed(workspaceProjectInput, request.body)));
  });
  app.post("/api/workspaces/:id/tasks", async (request, reply) => {
    const { id } = parsed(idParams, request.params);
    const input = parsed(agentTaskInput, request.body);
    return reply.code(201).send(await runtime.createAgentTask(id, {
      title: input.title, provider: input.provider, executorType: input.executorType,
      prompt: input.prompt, startImmediately: input.startImmediately ?? true,
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
    }));
  });
  app.get("/api/tasks/:id/changes", async (request) => ({ items: await runtime.taskChanges(parsed(idParams, request.params).id) }));
  app.post("/api/tasks/:id/review/approve", async (request) => runtime.approveReview(parsed(idParams, request.params).id));
  app.post("/api/tasks/:id/review/request-changes", async (request) => runtime.requestChanges(parsed(idParams, request.params).id));
  app.post("/api/tasks/:id/archive", async (request) => runtime.archiveTask(parsed(idParams, request.params).id));
  app.delete("/api/tasks/:id", async (request) => runtime.deleteTask(parsed(idParams, request.params).id));
  app.post("/api/tasks/:id/cancel", async (request) => runtime.cancelTask(parsed(idParams, request.params).id));
  app.post("/api/tasks/:id/knowledge-candidates", async (request) => {
    const { title, content } = parsed(z.object({ title: z.string().trim().min(1), content: z.string().trim().min(1) }), request.body);
    return runtime.saveKnowledgeCandidate(parsed(idParams, request.params).id, title, content);
  });

  app.get("/api/interactions", async (request) => {
    const query = parsed(z.object({ taskId: z.string().optional(), status: z.string().optional() }), request.query);
    return { items: runtime.db.listInteractions(query.taskId, query.status) };
  });
  app.post("/api/interactions/:id/respond", async (request) => runtime.respondInteraction(parsed(idParams, request.params).id, parsed(z.record(z.unknown()), request.body)));

  app.get("/api/execution-profiles", async () => ({ items: runtime.db.listExecutionProfiles() }));
  app.post("/api/execution-profiles", async (request, reply) => {
    const input = parsed(profileInput, request.body);
    return reply.code(201).send(runtime.createExecutionProfile({
      name: input.name, type: input.type, provider: input.provider,
      image: input.image ?? null, environment: input.environment ?? {},
    }));
  });
  app.post("/api/execution-profiles/:id/health-check", async (request) => {
    const profile = runtime.db.getExecutionProfile(parsed(idParams, request.params).id);
    if (!profile) throw new Error("Execution Profile not found");
    return runtime.profileHealth(profile);
  });

  app.post("/api/hooks/claude", async (request) => {
    const query = parsed(z.object({ sessionId: z.string().min(1) }), request.query);
    return runtime.handleClaudeHook(query.sessionId, parsed(z.record(z.unknown()), request.body));
  });

  app.get("/api/events", async (request) => {
    const query = parsed(z.object({ taskId: z.string().optional(), after: z.coerce.number().int().min(0).default(0) }), request.query);
    return { items: runtime.db.listEvents(query.taskId, query.after) };
  });
  app.get("/api/events/ws", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== request.headers.host) {
          socket.close(1008, "Origin not allowed");
          return;
        }
      } catch {
        socket.close(1008, "Invalid origin");
        return;
      }
    }
    const url = new URL(request.url, "http://localhost");
    const taskId = url.searchParams.get("taskId");
    const after = Number(url.searchParams.get("after") ?? 0);
    if (url.searchParams.get("snapshot") !== "0") {
      socket.send(JSON.stringify({ type: "snapshot", events: runtime.db.listEvents(taskId ?? undefined, after) }));
    }
    const unsubscribe = runtime.subscribe((event) => {
      if (!taskId || event.taskId === taskId) socket.send(JSON.stringify({ type: "event", event }));
    });
    socket.on("close", unsubscribe);
  });

  const publicDirectory = runtime.config.publicDirectory ?? resolve(process.cwd(), "apps/web/dist");
  if (existsSync(publicDirectory)) {
    await app.register(staticPlugin, { root: publicDirectory, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => runtime.close());
  return app;
}
