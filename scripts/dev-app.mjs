import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const overlay = resolve(root, 'overlay');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const backend = spawn(process.execPath, ['scripts/sidekick-local-server.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
children.push(backend);
backend.on('error', (error) => {
  console.error('Could not start the Sidekick local service:', error.message);
  stop(1);
});
backend.on('exit', (code) => {
  if (!stopping) stop(code ?? 1);
});

const vite = spawn(npm, ['run', 'dev'], {
  cwd: overlay,
  stdio: 'inherit',
  shell: isWindows,
});
children.push(vite);
vite.on('error', (error) => {
  console.error('Could not start the overlay. Run `npm ci --prefix overlay` first:', error.message);
  stop(1);
});
vite.on('exit', (code) => {
  if (!stopping) stop(code ?? 1);
});
