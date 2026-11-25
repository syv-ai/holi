export type PtyHostLaunch = { file: string; args: string[]; cwd: string }

/** Runs inside the native Job before node-pty creates any ConPTY process. */
const bootstrap = String.raw`
const pty = require(process.argv[1]);
const MAX = 1024 * 1024;
let buffer = Buffer.alloc(0), terminal, started = false, ending = false, failed = false;
let blocked = false, queued = [], queuedBytes = 0;
function closeInput() { process.stdin.destroy(); }
function emit(record) {
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  if (bytes.length > MAX) return fail('PTY output frame too large');
  if (blocked) {
    if (queuedBytes + bytes.length > MAX) return fail('PTY output queue exceeded');
    queued.push(bytes); queuedBytes += bytes.length; return;
  }
  blocked = !process.stdout.write(bytes);
  if (blocked && terminal) terminal.pause();
}
process.stdout.on('drain', () => {
  blocked = false;
  while (queued.length && !blocked) {
    const bytes = queued.shift(); queuedBytes -= bytes.length;
    blocked = !process.stdout.write(bytes);
  }
  if (!blocked && terminal && !ending) terminal.resume();
});
function fail(message) {
  if (failed) return;
  failed = true; process.exitCode = 1;
  if (!blocked) emit({type: 'error', message});
  closeInput();
  if (terminal && !ending) {
    ending = true;
    try { terminal.kill(); } catch { /* Native Job cleanup remains authoritative. */ }
  }
}
process.stdout.on('error', () => fail('PTY output transport failed'));
process.stdin.on('error', () => fail('PTY input transport failed'));
process.stdin.on('end', () => fail('PTY input transport closed'));
function dimensions(x) {
  return Number.isInteger(x.cols) && x.cols > 0 && x.cols <= 32767 &&
    Number.isInteger(x.rows) && x.rows > 0 && x.rows <= 32767;
}
function frame(line) {
  if (ending || failed) return;
  let x;
  try { x = JSON.parse(line); } catch { return fail('Invalid PTY JSON frame'); }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return fail('Invalid PTY record');
  if (!started) {
    if (typeof x.file !== 'string' || !x.file || typeof x.cwd !== 'string' || !x.cwd ||
        !(typeof x.args === 'string' || (Array.isArray(x.args) && x.args.every(a => typeof a === 'string'))) ||
        !x.env || typeof x.env !== 'object' || Array.isArray(x.env) ||
        !Object.values(x.env).every(v => typeof v === 'string') || !dimensions(x))
      return fail('Invalid PTY startup');
    started = true;
    try {
      terminal = pty.spawn(x.file, x.args, {
        cwd: x.cwd, env: x.env, cols: x.cols, rows: x.rows,
        name: 'xterm-256color', useConpty: true
      });
      emit({type: 'ready', pid: terminal.pid});
      terminal.onData(data => {
        // Split before encoding: each frame remains bounded without breaking UTF-8.
        const bytes = Buffer.from(data, 'utf8');
        for (let at = 0; at < bytes.length; at += 32768)
          emit({type: 'data', data: bytes.subarray(at, at + 32768).toString('base64')});
      });
      terminal.onExit(({exitCode, signal}) => {
        ending = true;
        emit({type: 'exit', exitCode, signal});
        // Keep the Job-owned helper until main requests native drainage.
        // Root exit alone must not race ahead of the controller's observers.
      });
    } catch { fail('PTY startup failed'); }
    return;
  }
  try {
    if (x.type === 'input' && typeof x.data === 'string') terminal.write(x.data);
    else if (x.type === 'resize' && dimensions(x)) terminal.resize(x.cols, x.rows);
    else if (x.type === 'close') { ending = true; terminal.kill(); }
    else fail('Invalid PTY command');
  } catch { fail('PTY command failed'); }
}
process.stdin.on('data', chunk => {
  if (failed || ending) return;
  buffer = Buffer.concat([buffer, chunk]);
  let n;
  while ((n = buffer.indexOf(10)) >= 0) {
    if (n > MAX) return fail('PTY input frame too large');
    const line = buffer.subarray(0, n).toString('utf8');
    buffer = buffer.subarray(n + 1);
    frame(line);
    if (failed || ending) { buffer = Buffer.alloc(0); return; }
  }
  if (buffer.length > MAX) fail('PTY input frame too large');
});
`

export function ownedPtyHostPlan(
  nodeImage: string,
  nodePtyModule: string,
  native: PtyHostLaunch,
): PtyHostLaunch {
  return { file: nodeImage, args: ['-e', bootstrap, nodePtyModule], cwd: native.cwd }
}
