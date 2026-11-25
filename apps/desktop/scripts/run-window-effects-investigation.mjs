#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { observeChild } from './native-smoke-process.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '')
const phase = process.argv[3] ?? 'pilot'
if (!process.argv[2] || !['pilot', 'compare'].includes(phase)) throw new Error('Usage: node run-window-effects-investigation.mjs <unique-evidence-dir> [pilot|compare] [pilot-dir]')
if (process.platform !== 'darwin') throw new Error('Window effects investigation requires macOS')
await mkdir(evidence, { recursive: false })
const id = randomUUID(), root = await mkdtemp(join(tmpdir(), `holi-window-effects-${id}-`))
const protocol = { id, phase, pairs: ['AB','BA','AB','BA','AB'], warmupSeconds: phase === 'pilot' ? 30 : 180, steadySeconds: phase === 'pilot' ? 30 : 120, intervalSeconds: 1, activitySeconds: 30, recoverySeconds: 30, frozenTolerances: null, status: 'inconclusive until metrics are collected', decision: '64 MiB and 15% steady physical-footprint reduction in at least 4/5 pairs; unavailable metrics are not zero.' }
let child, childState
const sleep = ms => new Promise(r => setTimeout(r, ms))
const owned = new Set()
try {
  if (phase === 'compare') {
    if (!process.argv[4]) throw new Error('Compare requires a pilot evidence directory')
    const pilot = JSON.parse(await readFile(join(resolve(process.argv[4]), 'summary.json'), 'utf8'))
    if (!pilot.noiseTolerances) throw new Error('Pilot has no valid measured noise tolerances')
    protocol.frozenTolerances = pilot.noiseTolerances
  }
  for (const d of ['userData','sessionData','app-data','home','tmp','vault']) await mkdir(join(root,d), {recursive:true})
  await build({ configFile:false, root:desktop, base:'./', resolve:{alias:{'@':join(desktop,'src/renderer/src')}}, plugins:[react(),tailwindcss(),{name:'fixture-transform',enforce:'pre',transform(_c,id){if(id.endsWith('/src/renderer/src/lib/trpc.ts')) return `const call=(n,i)=>window.richTextVimIO.call(n,i);const p=(a=[])=>new Proxy(()=>{}, {get(_,k){if(k==='then')return;const b=[...a,String(k)];if(['query','mutate'].includes(String(k)))return i=>call(b.slice(0,-1).join('.'),i);return p(b)}});export const trpc=p();`;return null}}],build:{target:'chrome140',outDir:join(root,'renderer'),emptyOutDir:true,rollupOptions:{input:join(desktop,'scripts/rich-text-vim-native-smoke.tsx'),output:{entryFileNames:'renderer.js',assetFileNames:'renderer.[ext]'}}} })
  await build({configFile:false,root:desktop,plugins:[externalizeDepsPlugin({exclude:['@holi/shared']})],build:{ssr:true,target:'node24',outDir:root,emptyOutDir:false,rollupOptions:{input:join(desktop,'scripts/window-effects-investigation-main.ts'),external:['electron'],output:{format:'cjs',entryFileNames:'main.cjs',banner:`module.paths.unshift(${JSON.stringify(join(desktop,'node_modules'))});`}}}})
  await writeFile(join(root,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('richTextVimIO',{call:(n,i)=>{if(n==='notes.read')return ipcRenderer.invoke('rich-text-vim:read',i.path);if(n==='notes.write')return ipcRenderer.invoke('rich-text-vim:write',i.path,i.text);if(n==='comments.read'||n==='comments.list')return ipcRenderer.invoke('rich-text-vim:comments',n==='comments.read'?'read':'list');if(n==='comments.write')return ipcRenderer.invoke('rich-text-vim:comments','write',i.text);if(n==='github.fileContributors'||n==='history.list')return Promise.resolve([]);if(n.startsWith('fixture.'))return Promise.resolve({});throw Error('denied')}});`)
  await writeFile(join(root,'renderer/index.html'),`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';img-src data:;font-src 'self';connect-src 'none'"><div id="root"></div><script type="module" src="./renderer.js"></script></html>`)
  await writeFile(join(root,'package.json'),JSON.stringify({name:`holi-window-effects-${id}`,main:'main.cjs'}))
  const cc=spawnSync('clang',[join(desktop,'scripts/window-effects-metrics.c'),'-o',join(root,'metrics')],{encoding:'utf8'}); if(cc.status!==0) throw Error(cc.stderr)
  const electron=createRequire(import.meta.url)('electron'); const env={...process.env,HOME:join(root,'home'),TMPDIR:join(root,'tmp'),HOLI_WINDOW_EFFECTS_ROOT:root,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}
  child=spawn(electron,[root],{cwd:root,env,detached:true,stdio:['pipe','pipe','pipe']}); childState=observeChild(child); owned.add(child.pid)
  const lines=createInterface({input:child.stdout}); const events=[]; lines.on('line',line=>{try{events.push(JSON.parse(line))}catch{}}); child.stderr.on('data',()=>{})
  await Promise.race([new Promise((res,rej)=>{const t=setInterval(()=>{if(events.some(x=>x.event==='ready')){clearInterval(t);res()}},100);childState.closed.then(rej)}),sleep(60000).then(()=>{throw Error('startup timeout')})])
  const samples=[]; const target=phase==='pilot'?['native']:[...protocol.pairs.flatMap(x=>x.split(''))]
  for(const mode of target){ if(mode==='B') continue; await sleep(protocol.warmupSeconds*1000); for(let i=0;i<protocol.steadySeconds;i++){ const r=spawnSync(join(root,'metrics'),[String(child.pid)],{encoding:'utf8'}); samples.push({mode,at:new Date().toISOString(),metric:JSON.parse(r.stdout||'{}')}); await sleep(1000) } }
  await writeFile(join(evidence,'raw-samples.json'),JSON.stringify(samples,null,2)); await writeFile(join(evidence,'events.json'),JSON.stringify(events,null,2)); await writeFile(join(evidence,'protocol.json'),JSON.stringify(protocol,null,2)); await writeFile(join(evidence,'summary.json'),JSON.stringify({status:'inconclusive',reason:'This runner currently samples only its owned Electron main PID; paired renderer/GPU/WindowServer collection and activity commands remain unavailable.',samples:samples.length},null,2))
} finally {
  if(child&&!childState?.exit){child.kill('SIGTERM');await Promise.race([childState.closed,sleep(5000)]); if(!childState.exit) child.kill('SIGKILL')}
  // Keep runtime evidence until process exit is confirmed.
  if(!child || childState?.exit) await rm(root,{recursive:true,force:true})
}
