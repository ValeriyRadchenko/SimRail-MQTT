// Lets Node run the TypeScript sources directly (no build step):
//   node --import ./server/ts-node-register.js server/src/index.ts
import { register } from 'node:module';

register('ts-node/esm', import.meta.url);
