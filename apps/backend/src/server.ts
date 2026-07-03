import { createApp } from "./app.js";
import { config } from "./config.js";
import { createRuntime } from "./runtime.js";

const { database, service } = createRuntime();
const app = createApp(service);
const server = app.listen(config.port, config.host, () => {
  console.log(`CHANTER Operator backend: http://${config.host}:${config.port}`);
  console.log("Runner mode: mock only (real execution disabled)");
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

