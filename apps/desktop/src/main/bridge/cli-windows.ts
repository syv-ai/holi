import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBundledWindowsNode } from '../windows-node-runtime'

const CLIENT = String.raw`'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const descriptor = DESCRIPTOR;
const scoped = SCOPED;

function fail(message, code = 1) {
  process.stderr.write('holi: ' + message + '\n');
  process.exit(code);
}

function valid() {
  try {
    const stat = fs.lstatSync(descriptor);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const raw = fs.readFileSync(descriptor, 'utf8');
    const match = raw.match(/^\\{\\r?\\n  "host": "127\\.0\\.0\\.1",\\r?\\n  "port": ([0-9]+),\\r?\\n  "token": "([0-9a-f]+)"\\r?\\n\\}\\r?\\n?$/);
    if (!match) return null;
    const parsed = JSON.parse(raw);
    const port = Number(match[1]);
    if (parsed.host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (parsed.port !== port || parsed.token !== match[2] || match[2].length !== (scoped ? 32 : 64)) return null;
    if (Object.keys(parsed).join(',') !== 'host,port,token') return null;
    return parsed;
  } catch {
    return null;
  }
}

function input() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function request(endpoint, fields) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(fields).toString();
    const req = http.request({
      host: '127.0.0.1', port: endpoint.port, path: '/cli', method: 'POST', agent: false,
      headers: {
        'x-holi-cli-token': endpoint.token,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('response disconnected')));
      res.on('end', () => {
        if (!res.complete) return reject(new Error('incomplete response'));
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const endpoint = valid();
  if (!endpoint) fail('Holi is not running (CLI endpoint descriptor is missing or unsafe).');
  const cwd = fs.realpathSync(process.cwd());
  const fields = [...process.argv.slice(2).map(value => ['argv', value]), ['cwd', cwd], ['runFormat', 'json']];
  const jobPath = (process.env.CLAUDE_JOB_DIR || '').replace(/\\\\/g, '/');
  const job = jobPath.replace(/^.*\\//, '');
  if (/^[0-9a-f]{8}$/.test(job) && jobPath && !jobPath.endsWith('/')) fields.push(['job', job]);
  let response;
  try {
    response = await request(endpoint, fields);
  } catch {
    fail('could not reach the running Holi app.');
  }
  let stdinConsumed = false;
  if (response.status === 428) {
    let contents;
    try {
      contents = await input();
      stdinConsumed = true;
      response = await request(endpoint, [...fields, ['stdin', contents]]);
    } catch {
      fail('could not reach the running Holi app.');
    }
  }
  if (response.status === 202) {
    let run;
    try {
      run = JSON.parse(response.body);
      if (!Array.isArray(run.argv) || !run.argv.length || !run.argv.every(value => typeof value === 'string') ||
          typeof run.argv[0] !== 'string' || !run.argv[0] || typeof run.cwd !== 'string' ||
          !path.isAbsolute(run.cwd) || !run.env || typeof run.env !== 'object' || Array.isArray(run.env) ||
          !Object.entries(run.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string')) throw Error();
    } catch {
      fail('Holi returned an invalid program handoff.');
    }
    const child = spawn(run.argv[0], run.argv.slice(1), {
      cwd: run.cwd, env: { ...process.env, ...run.env },
      stdio: stdinConsumed ? [process.stdin, 'inherit', 'inherit'] : 'inherit', shell: false,
    });
    child.on('error', () => fail('could not start the requested program.'));
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        process.exit(1);
      }
      process.exit(code ?? 1);
    });
    return;
  }
  if (response.status === 200) { process.stdout.write(response.body + '\n'); return; }
  if (response.status === 400) { process.stderr.write(response.body + '\n'); process.exit(2); }
  if (response.status === 422) { process.stderr.write(response.body + '\n'); process.exit(1); }
  if (response.status === 401 || response.status === 403) fail('this CLI endpoint rejected the request.');
  fail('Holi answered ' + response.status);
})().catch(() => fail('could not reach the running Holi app.'));
`

export async function installWindowsCli(
  userDataDir: string,
  binding?: { descriptorPath: string; binDir: string },
): Promise<string> {
  if (binding && (!isAbsolute(binding.descriptorPath) || !isAbsolute(binding.binDir)))
    throw new Error('vault CLI binding paths must be absolute')
  const bin = binding?.binDir ?? join(userDataDir, 'bin')
  await mkdir(bin, { recursive: true })
  const native = nativeCli()
  const executable = join(bin, 'holi.exe')
  const incoming = await readFile(native)
  let same = false
  try {
    same = (await readFile(executable)).equals(incoming)
  } catch {
    /* first install */
  }
  if (!same) await copyFile(native, executable)
  const descriptor = binding?.descriptorPath ?? join(userDataDir, 'cli-endpoint.json')
  const runtime = resolveBundledWindowsNode()
  if (!runtime) throw new Error('the bundled Windows Node runtime is unavailable')
  await writeFile(
    join(bin, 'holi-runtime.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(runtime, 'utf16le')]),
  )
  const client = CLIENT.replace(/DESCRIPTOR|SCOPED/g, (placeholder) =>
    placeholder === 'DESCRIPTOR' ? JSON.stringify(descriptor) : JSON.stringify(!!binding),
  )
  await writeFile(join(bin, 'holi-client.cjs'), client, { mode: 0o600 })
  await writeFile(join(bin, 'holi'), `#!/bin/sh\nexec "$(dirname "$0")/holi.exe" "$@"\n`, {
    mode: 0o755,
  })
  return executable
}

function nativeCli(): string {
  if (process.type === 'browser') {
    const { app } = require('electron') as typeof import('electron')
    return app.isPackaged
      ? join(process.resourcesPath, 'holi.exe')
      : join(app.getAppPath(), 'build/native/holi.exe')
  }
  return fileURLToPath(new URL('../../../build/native/holi.exe', import.meta.url))
}
