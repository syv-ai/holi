import assert from 'node:assert/strict'
import type { Plugin } from 'vite'
import { brokerSource } from '../src/main/owned-process-broker-source'
import { runBroker } from '../src/main/owned-process-broker'

import type { SpawnOptions } from 'node:child_process'
import type { Launch } from '../src/main/launch'
import { launchOwned } from '../src/main/owned-process-launch'

/** Exercises real query failure without providing a provider-controlled fault switch. */
export function spawnOwnedLaunchWithNativeQueryFault(
  plan: Launch,
  options: SpawnOptions,
  parentPid: number,
) {
  return launchOwned(plan, options, parentPid, false, 'query')
}

export function spawnOwnedLaunchWithHandoffFault(
  plan: Launch,
  options: SpawnOptions,
  point: 'before-clear' | 'after-clear',
) {
  return launchOwned(plan, options, process.pid, true, point)
}

type RegistrationHooks = NonNullable<Parameters<typeof launchOwned>[5]>
type BrokerHooks = NonNullable<Parameters<typeof runBroker>[4]>
type AuthGate = Parameters<NonNullable<RegistrationHooks['pauseAuth']>>

export function spawnOwnedLaunchWithRegistrationStopAudit(
  plan: Launch,
  options: SpawnOptions,
  retained: boolean,
  fixture: RegistrationHooks,
) {
  return launchOwned(plan, options, process.pid, retained, 'registration-stop-audit', fixture)
}

/** Fault before or during slot publication, or on the adopted side of REGISTERED. */
export function spawnOwnedLaunchWithRegistrationFault(
  plan: Launch,
  options: SpawnOptions,
  point: 'before-first-dup' | 'after-first-dup' | 'after-both-dups' | 'drop-registered',
  fixture?: Required<Pick<RegistrationHooks, 'beforeJoin' | 'adopted'>> & {
    pauseAuth(identity: AuthGate[0] & NonNullable<AuthGate[1]>): Promise<void>
    directory: string
    loseReceipt: boolean
    beforeBroker(action: Parameters<typeof runBroker>[1]): Promise<void>
    brokerClosed: BrokerHooks['closed']
  },
) {
  return launchOwned(
    plan,
    options,
    process.pid,
    true,
    point,
    fixture && {
      pauseAuth: (identity, jobs) => {
        assert(jobs, 'registration fault fixture requires retained Jobs')
        return fixture.pauseAuth({ ...identity, ...jobs })
      },
      beforeJoin: fixture.beforeJoin,
      adopted: fixture.adopted,
      broker: async (ticket, action, grant, committed) => {
        await fixture.beforeBroker(action)
        return runBroker(ticket, action, grant, committed, {
          transformSource: (source) => registrationBrokerSource(source, fixture.loseReceipt),
          directory: fixture.directory,
          closed: fixture.brokerClosed,
        })
      },
    },
  )
}

function registrationBrokerSource(source: string, loseReceipt: boolean) {
  source = substitute(
    source,
    '  static void BrokerSend(',
    `${registrationNativeSource}\n  static void BrokerSend(`,
  )
  source = substitute(
    source,
    'string action=(string)data["action"];',
    'string action=(string)data["action"]; fixtureDirectory=(string)data["fixtureDirectory"];',
  )
  source = substitute(
    source,
    'const int ProcessHandleInformation=51;',
    'fixtureSweeps++; const int ProcessHandleInformation=51;',
  )
  source = substitute(
    source,
    'RecoverPending(output,jobId,guardId,pid,expectedBirth,deadline);',
    'RecoverPending(output,jobId,guardId,pid,expectedBirth,deadline);\n        RecordRegistration(action,null,null);',
  )
  const closed = 'try { CloseSource(source); } finally { CloseSource(guardSource); }'
  source = substitute(
    source,
    closed,
    `${closed}\n      uint jobActive=ActiveProcesses(job), guardActive=ActiveProcesses(guard);`,
  )
  const finalReceipt = String.raw`BrokerSend(output,"{\"type\":\""+(action=="revoke"?"drained":"released")+"\""+binding,deadline);`
  return substitute(
    source,
    finalReceipt,
    `RecordRegistration(action,jobActive,guardActive);
      ${
        loseReceipt
          ? String.raw`if(action!="revoke") throw Fail("protocolFailure");
      // Keep the broker alive after both closes so the witness can reuse a slot
      // before the stale lease observes EOF. Exit successfully without writing DRAINED.
      while(!File.Exists(Path.Combine(fixtureDirectory,"broker-finish"))) {
        if(Clock.ElapsedMilliseconds>=deadline || !ParentAlive()) throw Fail("controlFailure");
        Thread.Sleep(10);
      }`
          : finalReceipt
      }`,
  )
}

const registrationNativeSource = String.raw`
  static string fixtureDirectory;
  static int fixtureSweeps;
  static void RecordRegistration(string action,uint? jobActive,uint? guardActive) {
    var report=new Record{{"action",action},{"sweeps",fixtureSweeps},{"jobActive",jobActive},{"guardActive",guardActive}};
    // Atomic, single-writer audit after the real source closes. A second broker
    // cannot overwrite it, and this audit never grants cleanup authority.
    string path=Path.Combine(fixtureDirectory,"broker-close.json");
    File.WriteAllText(path+".tmp",Json.Serialize(report),Utf8);
    File.Move(path+".tmp",path);
  }
`

// Only a fixture-built disposable Node driver includes this instrumentation.
// Its credential travels on the two private stdin streams, not the launch
// environment, provider argv, embedded PowerShell source, or readiness files.
let fixtureSpec: { directory: string; key: string } | undefined

export function configureBrokerFixture(directory: string, key: string) {
  assert(!fixtureSpec && /^[A-Za-z0-9+/]{43}=$/.test(key), 'bad private fixture credential')
  fixtureSpec = { directory, key }
}

/** @public Used by the instrumented disposable Node driver. */
export function brokerFixtureSpec() {
  assert(fixtureSpec, 'missing private broker fixture credential')
  return fixtureSpec
}

export type CommitBarrier = 'before-send' | 'after-send'

export function nativeCommitBarrier(point: CommitBarrier): Plugin {
  const committed = String.raw`BrokerSend(output,"{\"type\":\"committed\""+binding,deadline);`
  const barrier = `BrokerFixtureBarrier("${point}",job,guard);`
  let sourcePatched = false
  let driverPatched = false
  return {
    name: 'private-native-commit-barrier',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/owned-process-broker-source.ts')) {
        let source = substitute(
          brokerSource,
          '  static void BrokerSend(',
          `${fixtureNativeSource}\n  static void BrokerSend(`,
        )
        source = substitute(
          source,
          'launchId=(string)data["launchId"];',
          'fixture=(Record)data["fixture"];\n      launchId=(string)data["launchId"];',
        )
        source = substitute(
          source,
          committed,
          point === 'before-send'
            ? `${barrier}\n      ${committed}`
            : `${committed}\n      ${barrier}`,
        )
        source = substitute(
          source,
          'try { DrainWithGuard(job,guard); } catch {}',
          'try { DrainWithGuard(job,guard); BrokerFixtureRecord("rollback",job,guard); } catch {}',
        )
        sourcePatched = true
        return `export const brokerSource = ${JSON.stringify(source)}`
      }
      if (id.endsWith('/owned-process-broker.ts')) {
        driverPatched = true
        return `import { brokerFixtureSpec } from '../../test/owned-process-test-adapter'\n${substitute(
          code,
          '...ticket,',
          '...ticket, fixture: brokerFixtureSpec(),',
        )}`
      }
    },
    generateBundle() {
      assert(sourcePatched && driverPatched, 'native broker fixture did not instrument the driver')
    },
  }
}

function substitute(source: string, needle: string, replacement: string) {
  assert.equal(source.split(needle).length, 2, `native fixture seam changed: ${needle}`)
  return source.replace(needle, () => replacement)
}

const fixtureNativeSource = String.raw`
  static Record fixture;
  static void BrokerFixtureRecord(string phase,IntPtr job,IntPtr guard) {
    var self=GetCurrentProcess();
    long birth, parentBirth, ignored;
    Check(GetProcessTimes(self,out birth,out ignored,out ignored,out ignored));
    Check(GetProcessTimes(parent,out parentBirth,out ignored,out ignored,out ignored));
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION counts;
    Check(QueryInformationJobObject(job,1,out counts,(uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),IntPtr.Zero));
    string payload=Json.Serialize(new Record{{"phase",phase},{"pid",GetProcessId(self)},
      {"birth",birth.ToString(CultureInfo.InvariantCulture)},{"parentPid",GetProcessId(parent)},
      {"parentBirth",parentBirth.ToString(CultureInfo.InvariantCulture)},
      {"guardArmed",KillOnCloseArmed(guard)},{"activeProcesses",counts.ActiveProcesses}});
    byte[] mac;
    using(var h=new HMACSHA256(DecodeBase64((string)fixture["key"]))) mac=h.ComputeHash(Utf8.GetBytes(payload));
    string path=Path.Combine((string)fixture["directory"],"broker-"+phase);
    File.WriteAllText(path+".tmp",Json.Serialize(new Record{{"payload",payload},{"mac",Convert.ToBase64String(mac)}}),Utf8);
    File.Move(path+".tmp",path+".json");
  }
  static void BrokerFixtureBarrier(string phase,IntPtr job,IntPtr guard) {
    BrokerFixtureRecord(phase,job,guard);
    // Observation only: the real broker performs the next write/read, detects
    // failure, and takes its own rollback path. The fixture never kills the Job.
    WaitForSingleObject(parent,10000);
  }
`
