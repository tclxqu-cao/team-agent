import './configure-dev-app-name.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const executable = process.platform === 'darwin'
  ? fileURLToPath(new URL('../.runtime/agentroam.app/Contents/MacOS/Electron', import.meta.url))
  : require('electron');
// LaunchServices makes the app itself responsible for TCC, instead of Node.
const appArgs = [fileURLToPath(new URL('..', import.meta.url)), ...process.argv.slice(2)];
const child = process.platform === 'darwin'
  ? spawn('/usr/bin/open', ['-W', '-n', '-a', fileURLToPath(new URL('../.runtime/agentroam.app', import.meta.url)),
    ...['NODE_ENV', 'VITE_PORT'].flatMap(key => process.env[key] ? ['--env', `${key}=${process.env[key]}`] : []),
    '--args', ...appArgs], { stdio: 'inherit' })
  : spawn(executable, appArgs, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
