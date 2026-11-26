// The desktop app: a window showing the UI, and the server (server/src/index.ts) in a utility
// process next to it. The server is the same as with npm start: it serves the UI on 127.0.0.1:8090,
// and the window loads it from there like a browser tab. In a process of its own, SDL and the COM
// ports stay away from Chromium, and a crash in them can't take the window down.
//
// - npm run app: runs from the project folder, with the same files as npm start
//   (settings/config.json, .runtime/).
// - Packaged (npm run dist): one portable exe. The settings are saved next to it, in
//   settings/config.json; on the first start they are copied from the project the exe was built
//   from, when that has any (see electron-builder.js). The log and SimRail's topic list go
//   to %APPDATA%\SimRail Controllers\logs.
//
// Closing the window quits the app: the server is asked to shut down (saving the settings, closing
// the ports) and the app exits once it has.

import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell, utilityProcess, type UtilityProcess } from 'electron';
import type { FromDesktopApp, ToDesktopApp } from '../server/src/desktop-app.js';

/** How long the server gets to shut down before it is killed. */
const SHUTDOWN_TIMEOUT_MS = 5000;
/** How much of the server's last output an error dialog shows. */
const OUTPUT_TAIL_CHARS = 2000;

const serverEntry = fileURLToPath(new URL('../server/src/index.js', import.meta.url));

const paths = (() => {
  const fromEnv = (name: string) => {
    const value = process.env[name];
    return value ? resolve(value) : undefined;
  };
  const project = app.getAppPath(); // when not packaged
  // The portable exe unpacks itself to a temporary folder and runs from there; it says where it is.
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(process.execPath);
  const settings =
    fromEnv('SETTINGS_FILE') ?? join(app.isPackaged ? exeDir : project, 'settings', 'config.json');
  const runtime =
    fromEnv('RUNTIME_DIR') ?? (app.isPackaged ? join(app.getPath('userData'), 'logs') : join(project, '.runtime'));
  return { settings, runtime, log: join(runtime, 'app.log') };
})();

let log: WriteStream | null = null;
let server: UtilityProcess | null = null;
let serverExited = false;
let quitting = false;
let window: BrowserWindow | null = null;

function writeLog(text: string): void {
  log?.write(text);
  if (!app.isPackaged) process.stdout.write(text);
}

/** The packaged app's first start: take the settings of the project it was built from, if it has any. */
async function importSettings(): Promise<void> {
  if (!app.isPackaged || existsSync(paths.settings)) return;
  const manifest = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8')) as {
    importSettingsFrom?: string;
  };
  const source = manifest.importSettingsFrom;
  if (!source || !existsSync(source)) return;
  await mkdir(dirname(paths.settings), { recursive: true });
  await copyFile(source, paths.settings);
  writeLog(`[app] settings imported from ${source}\n`);
}

function startServer(): void {
  // Flags such as --fake-joystick are the server's: `npm run app -- --fake-joystick`.
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const child = utilityProcess.fork(serverEntry, args, {
    serviceName: 'SimRail Controllers server',
    stdio: 'pipe',
    execArgv: ['--disable-warning=DEP0180'],
    env: { ...process.env, NO_OPEN: '1', SETTINGS_FILE: paths.settings, RUNTIME_DIR: paths.runtime },
  });
  server = child;

  let output = '';
  const take = (chunk: Buffer) => {
    const text = chunk.toString();
    writeLog(text);
    output = (output + text).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);

  child.on('message', (message: ToDesktopApp) => {
    if (message.type === 'ready' && !window) window = createWindow(message.url);
  });
  child.on('exit', (code) => {
    serverExited = true;
    writeLog(`[app] server exited with code ${code}\n`);
    if (quitting) {
      app.quit();
      return;
    }
    const message = window ? 'The server stopped unexpectedly.' : 'SimRail Controllers could not start.';
    void showError(message, output.trim()).then(() => app.exit(1));
  });
}

async function showError(message: string, detail: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'SimRail Controllers',
    message,
    detail: detail || `See the log: ${paths.log}`,
    buttons: ['Close', 'Show log'],
    defaultId: 0,
  });
  if (response === 1) shell.showItemInFolder(paths.log);
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    // The page's background (client/css/app.css), so the window doesn't flash white while it loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1216' : '#f4f6f8',
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (window = null));

  // The window only shows the app; links elsewhere open in the browser.
  const { origin } = new URL(url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openInBrowser(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === origin) return;
    event.preventDefault();
    openInBrowser(target);
  });

  setMenu(url);
  void win.loadURL(url);
  return win;
}

function openInBrowser(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

function setMenu(url: string): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Show settings file', click: () => shell.showItemInFolder(paths.settings) },
          { label: 'Show log', click: () => shell.showItemInFolder(paths.log) },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Open in browser', click: () => openInBrowser(url) },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  );
}

async function start(): Promise<void> {
  await app.whenReady();
  await mkdir(paths.runtime, { recursive: true });
  log = createWriteStream(paths.log); // a new log on every start
  try {
    await importSettings();
  } catch (err) {
    writeLog(`[app] could not import the settings: ${(err as Error).message}\n`);
  }
  startServer();
}

// One app at a time: a second one couldn't have the port (8090) or the COM ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (!server || serverExited) return; // nothing to wait for
    event.preventDefault(); // quit again once the server has exited
    if (quitting) return;
    quitting = true;
    server.postMessage({ type: 'shutdown' } satisfies FromDesktopApp);
    setTimeout(() => server?.kill(), SHUTDOWN_TIMEOUT_MS).unref();
  });

  start().catch((err: Error) => {
    dialog.showErrorBox('SimRail Controllers could not start', err.message);
    app.exit(1);
  });
}
