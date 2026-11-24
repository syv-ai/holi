export type PtyHostLaunch = { file: string; args: string[]; cwd: string }

/** A Node child that hosts node-pty inside its already-owned native Job. */
const bootstrap = String.raw`
const modulePath = process.argv[1];
const pty = require(modulePath);
const MAX_FRAME = 1024 * 1024;
let buffer = Buffer.alloc(0);
let terminal;
let ready = false;
let ending = false;
let failed = false;
let blocked = false;
const pending = [];
let pendingBytes = 0;
function emit(record) {
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  if (blocked) {
    pendingBytes += bytes.length;
    if (pendingBytes > MAX_FRAME) return fail('output backpressure limit exceeded');
    pending.push(bytes); return;
  }
  blocked = !process.stdout.write(bytes);
  if (blocked) process.stdout.once('drain', flush);
}
function flush() {
  blocked = false;
  while (pending.length && !blocked) {
    const bytes = pending.shift();
    pendingBytes -= bytes.length;
    blocked = !process.stdout.write(bytes);
  }
  if (blocked) process.stdout.once('drain', flush);
  else if (ending) finish();
}
function finish() {
  if (pending.length || blocked) return;
  process.stdin.pause();
  process.stdin.destroy();
  process.stdout.end();
}
function fail(message) {
  if (failed) return;
  failed = true;
  if (pendingBytes <= MAX_FRAME - 128) emit({ type: 'error', message });
  if (terminal && !ending) { ending = true; terminal.kill(); }
  else process.exitCode = 1;
}
function validStartup(value) {
  return value && typeof value.file === 'string' && value.file.length > 0 &&
    Array.isArray(value.args) && value.args.every(x => typeof x === 'string') &&
    typeof value.cwd === 'string' && value.cwd.length > 0 &&
    value.env && typeof value.env === 'object' && !Array.isArray(value.env) &&
    Object.entries(value.env).every(([k,v]) => typeof k === 'string' && typeof v === 'string') &&
    Number.isInteger(value.cols) && value.cols > 0 && value.cols <= 1000 &&
    Number.isInteger(value.rows) && value.rows > 0 && value.rows <= 1000;
}
function frame(line) {
  let value;
  try { value = JSON.parse(line); } catch { return fail('invalid JSON frame'); }
  if (!ready) {
    if (!validStartup(value)) return fail('invalid startup record');
    try {
      terminal = pty.spawn(value.file, value.args, { cwd: value.cwd, env: value.env, cols: value.cols, rows: value.rows, useConpty: true });
      terminal.onData(data => emit({ type: 'data', data: Buffer.from(data, 'utf8').toString('base64') }));
      terminal.onExit(({ exitCode, signal }) => {
        emit({ type: 'exit', exitCode, signal });
        ending = true;
        finish();
      });
      ready = true;
      emit({ type: 'ready', pid: terminal.pid });
    } catch { fail('PTY spawn failed'); }
    return;
  }
  if (!value || typeof value.type !== 'string') return fail('invalid command');
  try {
    if (value.type === 'input' && typeof value.data === 'string' && Buffer.byteLength(value.data) <= MAX_FRAME) terminal.write(value.data);
    else if (value.type === 'resize' && Number.isInteger(value.cols) && Number.isInteger(value.rows) && value.cols > 0 && value.rows > 0 && value.cols <= 1000 && value.rows <= 1000) terminal.resize(value.cols, value.rows);
    else if (value.type === 'close') { ending = true; terminal.kill(); }
    else fail('invalid command');
  } catch { fail('PTY command failed'); }
  else fail('invalid command');
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > MAX_FRAME && !buffer.includes(10)) return fail('input frame too large');
  let at;
  while ((at = buffer.indexOf(10)) >= 0) {
    if (at > MAX_FRAME) return fail('input frame too large');
    const line = buffer.subarray(0, at).toString('utf8');
    buffer = buffer.subarray(at + 1);
    frame(line);
  }
  if (buffer.length > MAX_FRAME) fail('input frame too large');
});
process.stdin.on('end', () => { if (terminal && !ending) { ending = true; terminal.kill(); } });
process.stdin.on('error', () => { if (terminal && !ending) { ending = true; terminal.kill(); } });
process.stdin.resume();
`

export function ownedPtyHostPlan(
  nodeImage: string,
  nodePtyModule: string,
  native: PtyHostLaunch,
): PtyHostLaunch {
  return {
    file: nodeImage,
    args: ['-e', bootstrap, nodePtyModule],
    cwd: native.cwd,
  }
}
