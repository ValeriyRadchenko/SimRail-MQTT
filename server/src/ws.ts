import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { parseClientMessage, type ClientMessage, type ServerMessage } from './protocol.js';

/** One connected browser tab. */
export interface Client {
  readonly id: number;
  send(message: ServerMessage): void;
}

export interface ClientHubHandlers {
  /** Messages to send a browser as soon as it connects (current state). */
  snapshot: () => ServerMessage[];
  onMessage: (message: ClientMessage, client: Client) => void | Promise<void>;
  onDisconnect: (client: Client) => void;
}

/** WebSocket endpoint at /ws shared by all open browser tabs. */
export class ClientHub {
  private readonly wss: WebSocketServer;
  private nextId = 1;

  constructor(server: Server, allowedOrigins: string[], handlers: ClientHubHandlers) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      // Browsers let any website open a socket to localhost; only accept our own page.
      verifyClient: ({ origin }: { origin?: string }) => origin !== undefined && allowedOrigins.includes(origin),
    });
    // The HTTP server's errors (such as the port being in use) are passed on here as well, and would
    // crash the server unhandled; listen() in index.ts reports them.
    this.wss.on('error', () => {});

    this.wss.on('connection', (socket) => {
      const client: Client = { id: this.nextId++, send: (message) => sendTo(socket, message) };
      for (const message of handlers.snapshot()) client.send(message);

      socket.on('message', (data) => {
        const message = parseClientMessage(data.toString());
        if (!message) {
          console.warn('[ws] ignoring malformed message');
          return;
        }
        Promise.resolve(handlers.onMessage(message, client)).catch((err: Error) =>
          console.error('[ws] handler failed:', err.message),
        );
      });
      socket.on('close', () => handlers.onDisconnect(client));
    });
  }

  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.wss.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }

  close(): void {
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close();
  }
}

function sendTo(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
