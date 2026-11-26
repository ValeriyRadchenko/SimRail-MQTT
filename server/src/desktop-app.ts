// The link to the desktop app when the server runs inside it, as an Electron utility process (see
// electron/main.ts). Started with npm start there is none, and Ctrl+C stops the server instead.

/** Server -> desktop app. */
export type ToDesktopApp = { type: 'ready'; url: string };

/** Desktop app -> server. */
export type FromDesktopApp = { type: 'shutdown' };

interface ParentPort {
  postMessage(message: ToDesktopApp): void;
  on(event: 'message', listener: (event: { data: FromDesktopApp }) => void): void;
}

/** Null unless run by the desktop app. */
export const desktopApp: ParentPort | null = (process as unknown as { parentPort?: ParentPort }).parentPort ?? null;
