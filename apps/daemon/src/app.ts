import { existsSync } from "node:fs";
import { resolve } from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentBoardRuntime } from "./runtime.js";

const idParams = z.object({ id: z.string().min(1) });
const projectInput = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().default("") });
const repositoryInput = z.object({
  name: z.string().trim().min(1).max(120),
  localPath: z.string().trim().min(1).nullable().optional(),
  remoteUrl: z.string().trim().nullable().default(null),
  baseBranch: z.string().trim().min(1).default("main"),
});
const taskInput = z.object({ projectId: z.string().min(1), title: z.string().trim().min(1).max(200), description: z.string().trim().default("") });
const workspaceInput = z.object({
  repositoryIds: z.array(z.string().min(1)).min(1), rootPath: z.string().optional(),
  branchName: z.string().optional(), fetch: z.boolean().default(false),
  knowledgeSources: z.array(z.object({ path: z.string(), scope: z.enum(["global", "project", "repository", "task"]), title: z.string().optional() })).default([]),
});
const sessionInput = z.object({
  provider: z.enum(["codex", "claude"]), executorType: z.enum(["native", "docker"]),
  executionProfileId: z.string().optional(), prompt: z.string().trim().min(1), image: z.string().optional(),
});
const profileInput = z.object({
  name: z.string().trim().min(1), type: z.enum(["native", "docker"]), provider: z.enum(["codex", "claude"]),
  image: z.string().nullable().default(null), environment: z.record(z.string()).default({}),
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

  app.get("/api/projects", async () => ({ items: runtime.db.listProjects() }));
  app.post("/api/projects", async (request, reply) => {
    const input = parsed(projectInput, request.body);
    return reply.code(201).send(runtime.createProject({ name: input.name, description: input.description ?? "" }));
  });
  app.get("/api/projects/:id/repositories", async (request) => {
    const { id } = parsed(idParams, request.params);
    return { items: runtime.db.listRepositories(id) };
  });
  app.post("/api/projects/:id/repositories", async (request, reply) => {
    const { id } = parsed(idParams, request.params);
    const input = parsed(repositoryInput, request.body);
    return reply.code(201).send(await runtime.createRepository(id, {
      name: input.name, localPath: input.localPath ?? null, remoteUrl: input.remoteUrl ?? null, baseBranch: input.baseBranch ?? "main",
    }));
  });

  app.get("/api/tasks", async (request) => {
    const query = parsed(z.object({ projectId: z.string().optional() }), request.query);
    return { items: runtime.db.listTasks(query.projectId).map((task) => runtime.taskDetails(task.id)) };
  });
  app.post("/api/tasks", async (request, reply) => {
    const input = parsed(taskInput, request.body);
    return reply.code(201).send(runtime.createTask({ projectId: input.projectId, title: input.title, description: input.description ?? "" }));
  });
  app.get("/api/tasks/:id", async (request) => runtime.taskDetails(parsed(idParams, request.params).id));
  app.post("/api/tasks/:id/workspace", async (request, reply) => {
    const { id } = parsed(idParams, request.params);
    const input = parsed(workspaceInput, request.body);
    return reply.code(201).send(await runtime.createTaskWorkspace(id, input.repositoryIds, {
      ...(input.rootPath ? { rootPath: input.rootPath } : {}),
      ...(input.branchName ? { branchName: input.branchName } : {}),
      fetch: input.fetch ?? false,
      knowledgeSources: (input.knowledgeSources ?? []).map((source) => ({
        path: source.path, scope: source.scope, ...(source.title ? { title: source.title } : {}),
      })),
    }));
  });
  app.get("/api/tasks/:id/changes", async (request) => ({ items: await runtime.taskChanges(parsed(idParams, request.params).id) }));
  app.post("/api/tasks/:id/workspace/cleanup", async (request) => {
    const body = parsed(z.object({ force: z.boolean().default(false) }), request.body);
    return runtime.cleanupWorkspace(parsed(idParams, request.params).id, body.force ?? false);
  });
  app.post("/api/tasks/:id/sessions", async (request, reply) => {
    const { id } = parsed(idParams, request.params);
    const input = parsed(sessionInput, request.body);
    return reply.code(201).send(await runtime.startSession(id, {
      provider: input.provider, executorType: input.executorType, prompt: input.prompt,
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(input.image ? { image: input.image } : {}),
    }));
  });
  app.post("/api/tasks/:id/review/approve", async (request) => runtime.approveReview(parsed(idParams, request.params).id));
  app.post("/api/tasks/:id/review/request-changes", async (request) => runtime.requestChanges(parsed(idParams, request.params).id));
  app.post("/api/tasks/:id/cancel", async (request) => runtime.cancelTask(parsed(idParams, request.params).id));
  app.post("/api/tasks/:id/knowledge-candidates", async (request) => {
    const { title, content } = parsed(z.object({ title: z.string().trim().min(1), content: z.string().trim().min(1) }), request.body);
    return runtime.saveKnowledgeCandidate(parsed(idParams, request.params).id, title, content);
  });

  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = parsed(idParams, request.params);
    const { message } = parsed(z.object({ message: z.string().trim().min(1) }), request.body);
    await runtime.sendMessage(id, message);
    return reply.code(202).send({ accepted: true });
  });
  app.post("/api/sessions/:id/interrupt", async (request) => { await runtime.interruptSession(parsed(idParams, request.params).id); return { ok: true }; });
  app.post("/api/sessions/:id/terminate", async (request) => { await runtime.terminateSession(parsed(idParams, request.params).id); return { ok: true }; });

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
    socket.send(JSON.stringify({ type: "snapshot", events: runtime.db.listEvents(taskId ?? undefined, after) }));
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
