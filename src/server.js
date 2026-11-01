import { connectMongoDB, closeMongoDB } from './services/mongodbData.js';
import { createServer } from "node:http";
import { app } from "./app.js";

const port = Number(process.env.PORT || 5050);
const server = createServer(app);
server.requestTimeout = 240000;
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
  void closeMongoDB();
});

try {
  await connectMongoDB();
  console.log('MongoDB connected.');
  server.listen(port, '127.0.0.1', () => console.log(`RAG backend: http://127.0.0.1:${port}`));
} catch {
  console.error('MongoDB startup failed. Check the driver installation, URI, DNS and Atlas network access.');
  process.exitCode = 1;
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closeMongoDB();
  } catch { process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
