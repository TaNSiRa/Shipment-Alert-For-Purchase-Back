const http = require("http");
const { Server } = require("socket.io");
const { env } = require("./config/env");
const { createApp } = require("./app");
const { registerRealtime } = require("./services/realtimeService");
const { startMailScheduler } = require("./services/mailScheduler");

const app = createApp();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: env.frontendOrigins, credentials: true },
  path: "/ws"
});
registerRealtime(io);

server.listen(env.apiPort, env.apiHost, () => {
  console.log(`Purchase Shipment Alert API running at http://${env.apiHost}:${env.apiPort}`);
  if (env.mailSchedulerEnabled) startMailScheduler();
});
