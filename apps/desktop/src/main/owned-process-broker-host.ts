type LaunchPlan = { file: string; args: string[]; cwd: string }

// Only the Node host is detached. Its referenced native child can roll back
// after the original parent disappears; the native broker still owns protocol
// decisions and watches the original parent, not this byte proxy.
const bootstrap = String.raw`
const { spawn } = require('node:child_process');
const { finished } = require('node:stream/promises');
const [file, cwd, ...args] = process.argv.slice(1);

// Fail closed even if a join or a flush never completes.
process.exitCode = 1;
let native;
try {
  native = spawn(file, args, {
    cwd, detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch {
  // Nothing to join. Never print a spawn error or invocation data.
}
if (native) {
  const { stdin, stdout, stderr } = native;
  const input = process.stdin;
  let failed = false;
  let inputStopped = false;

  function stopInput() {
    if (inputStopped) return;
    inputStopped = true;
    if (stdin) input.unpipe(stdin);
    input.destroy();
    // On failure do not wait for pending writes to a broker that may no longer
    // be reading. Give it EOF, never a kill. On normal join stdin is already done.
    stdin?.destroy();
  }
  function fail() {
    failed = true;
    process.exitCode = 1;
    stopInput();
  }

  native.on('error', fail);
  input.on('error', fail);
  input.once('close', () => {
    if (!inputStopped && !input.readableEnded) fail();
  });
  stdin?.on('error', fail);
  // ChildProcess 'close' joins the process and both readable pipes, not stdin.
  const inputClosed = stdin && new Promise(resolve => stdin.once('close', resolve));

  function output(source, destination) {
    let undeliverable = false;
    const flushed = finished(destination, { readable: false }).catch(() => {
      undeliverable = true;
      fail();
      // pipe() pauses on backpressure and unpipes on write error. Resume to
      // discard bytes so native rollback can finish even without its reader.
      source?.unpipe(destination);
      source?.resume();
    });
    if (source) {
      source.on('error', fail);
      source.once('close', () => {
        if (!source.readableEnded) fail();
      });
      source.pipe(destination, { end: false });
    }
    return () => {
      if (!undeliverable) destination.end();
      return flushed;
    };
  }

  const flushOut = output(stdout, process.stdout);
  const flushErr = output(stderr, process.stderr);
  if (stdin && stdout && stderr) input.pipe(stdin); // Parent EOF is normal.
  else fail();

  native.once('close', async (code, signal) => {
    stopInput(); // An open parent input cannot keep the joined host alive.
    await Promise.all([inputClosed, flushOut(), flushErr()]);
    if (!failed && signal === null && Number.isInteger(code) && code >= 0 && code <= 255) {
      process.exitCode = code;
    }
  });
}
`

// Match libuv's Windows argv quoting (with windowsVerbatimArguments off).
// Quoted arguments double backslash runs only before a quote or the closing quote.
function windowsQuotedLength(arg: string): number {
  if (arg.includes('\0')) throw new TypeError('broker host arguments must not contain NUL')
  if (!arg.length) return 2
  if (!/[ \t"]/.test(arg)) return arg.length
  let length = arg.length + 2
  let escape = true
  for (let i = arg.length - 1; i >= 0; i--) {
    if (arg[i] === '\\') {
      if (escape) length++
    } else {
      escape = arg[i] === '"'
      if (escape) length++
    }
  }
  return length
}

/** Plan a detached host on the bundled Node image. Only the public native invocation
 * belongs in argv; the original parent writes the private spec to the host's stdin. */
export function brokerHostPlan(nodeImage: string, native: LaunchPlan): LaunchPlan {
  const args = ['-e', bootstrap, '--', native.file, native.cwd, ...native.args]
  const length = args.length + windowsQuotedLength(nodeImage) // One space per argument.
  if (args.reduce((total, arg) => total + windowsQuotedLength(arg), length) >= 32_000)
    throw new RangeError('broker host command line must be shorter than 32000 UTF-16 code units')
  return { file: nodeImage, args, cwd: native.cwd }
}
