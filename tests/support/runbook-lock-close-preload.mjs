// Test-only builtin I/O shim for an owned real direct-CLI child, never a product option.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.lstat;
let injected = false;
fs.lstat = async (path, ...args) => {
  if (!injected && String(path).startsWith(process.env.SYNTHETIC_LOCK_CLOSE_ROOT + '/') && String(path).endsWith('.lock')) {
    injected = true; process.send?.({ kind: 'lock_lstat_hit', code: process.env.SYNTHETIC_LOCK_CLOSE_CODE });
    throw Object.assign(new Error('synthetic lstat fault'), { code: process.env.SYNTHETIC_LOCK_CLOSE_CODE });
  }
  return original(path, ...args);
};
syncBuiltinESMExports();
