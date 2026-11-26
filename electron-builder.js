// npm run dist: packages the desktop app (electron/main.ts) as a portable Windows exe, in release/.
import { fileURLToPath } from 'node:url';

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'simrail-mqtt.controllers',
  productName: 'SimRail Controllers',
  directories: { output: 'release' },
  // What the app needs at run time (the production dependencies are added by electron-builder).
  files: ['package.json', 'LICENSE', 'dist/**/*', 'client/**/*', 'server/data/**/*'],
  // Both native modules (SDL, serialport) are N-API builds, which work in Electron as they are. A
  // rebuild would also make SDL download itself again.
  npmRebuild: false,
  // Loaded from disk rather than from the app's archive; SDL2.dll has to be next to sdl.node.
  asarUnpack: ['node_modules/@kmamal/sdl/dist/**', 'node_modules/@serialport/bindings-cpp/**'],
  // This project's settings, copied next to the exe on its first start (see electron/main.ts).
  // On another PC the path doesn't exist and the app starts with empty settings.
  extraMetadata: { importSettingsFrom: fileURLToPath(new URL('settings/config.json', import.meta.url)) },
  win: { target: [{ target: 'portable', arch: ['x64'] }] },
  portable: { artifactName: '${productName} ${version}.exe' },
};
