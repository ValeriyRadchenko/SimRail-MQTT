import { createServer, type Server } from 'node:http';
import express from 'express';

/**
 * Express app serving the static frontend. Returned as a plain http.Server so the
 * WebSocket endpoint can share the same port.
 */
export function createHttpServer(clientDir: string): Server {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(clientDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  return createServer(app);
}
