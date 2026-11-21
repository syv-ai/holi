import { win32 } from 'node:path'
import { gzipSync } from 'node:zlib'
import { brokerSource } from './owned-process-broker-source'
import { interopSource } from './owned-process-win32-interop-source'
import { protocolSource } from './owned-process-win32-protocol-source'
import { producerSource } from './owned-process-win32-source'

// All fragments compile into one class; fixtures run the same entry and producer.
const source = (broker: string) => `
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
using System.Web.Script.Serialization;
using Record = System.Collections.Generic.Dictionary<string,object>;
${interopSource}
${protocolSource}
${producerSource}
${broker}`

const bootstraps = new Map<string, string>()

/** Compile embedded source in system PowerShell, with no source or credentials on disk. */
export function win32Adapter(
  entry: 'Run' | 'RunBroker',
  env: NodeJS.ProcessEnv,
  brokerFixture?: (source: string) => string,
) {
  let bootstrap = brokerFixture ? undefined : bootstraps.get(entry)
  if (!bootstrap) {
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$source=@'\n${source(brokerFixture ? brokerFixture(brokerSource) : brokerSource)}\n'@\nAdd-Type -TypeDefinition $source -ReferencedAssemblies @('System.Web.Extensions','System.Core');exit [HoliOwnedProcess]::${entry}()`
    const compressed = gzipSync(Buffer.from(script)).toString('base64')
    // This bootstrap consists only of fixed text and the base64 of our own
    // source. Double encoding as UTF-16/base64 can exceed CreateProcess's
    // 32767-character limit; no launch data or secrets are interpolated.
    bootstrap = `$b=[Convert]::FromBase64String('${compressed}');$m=[IO.MemoryStream]::new($b);$g=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);& ([ScriptBlock]::Create($r.ReadToEnd()))`
    if (!brokerFixture) bootstraps.set(entry, bootstrap)
  }
  const systemRoot =
    [process.env.SystemRoot, process.env.WINDIR].find(
      (value) => value && win32.isAbsolute(value),
    ) ?? 'C:\\Windows'
  const cwd = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  return {
    file: win32.join(cwd, 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', bootstrap],
    env,
    cwd,
  }
}
