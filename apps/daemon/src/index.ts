import { createApp } from "./app.js";
import { AgentBoardRuntime, loadRuntimeConfig } from "./runtime.js";

const config = loadRuntimeConfig();
const app = await createApp(new AgentBoardRuntime(config));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void app.close().finally(() => process.exit(0)); });
}

try {
  await app.listen({ host: config.listenHost, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
