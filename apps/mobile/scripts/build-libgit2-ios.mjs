import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import https from 'node:https'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkName = process.env.HOLI_IOS_SDK ?? 'iphonesimulator'
if (!['iphonesimulator', 'iphoneos'].includes(sdkName)) throw new Error(`Unsupported iOS SDK: ${sdkName}`)
const device = sdkName === 'iphoneos'
const generated = join(root, `.native-deps/libgit2-1.9.7-${sdkName}`)
const archive = join(generated, 'libgit2-1.9.7.tar.gz')
const source = join(generated, 'source')
const build = join(generated, 'build')
const prefix = join(generated, 'install')
const url = 'https://github.com/libgit2/libgit2/archive/refs/tags/v1.9.7.tar.gz'
const sha256 = '1a4fbe7589e814777ae76b64734ad80f4ecad22cd33a22682a2aaea4ae5375e7'
const patchVersion = 'holi-isolated-config-open-v2'
// Existing libgit2 source patch retained verbatim.
async function patchRepository(sourceRoot) {
  const repositoryPath = join(sourceRoot, 'src/libgit2/repository.c')
  let repository = await readFile(repositoryPath, 'utf8')
  const signature = 'int git_repository_open_ext('
  if (repository.split(signature).length !== 2) throw new Error('Unexpected libgit2 repository.c open_ext definition')
  const start = repository.indexOf(signature); const brace = repository.indexOf('{', start)
  if (brace < 0) throw new Error('Could not locate open_ext body')
  let depth = 0; let end = -1
  for (let i = brace; i < repository.length; i++) { if (repository[i] === '{') depth++; if (repository[i] === '}' && --depth === 0) { end = i + 1; break } }
  if (end < 0) throw new Error('Could not parse open_ext body')
  const original = repository.slice(start, end)
  const declaration = 'int git_repository_open_holi(git_repository **out, const char *path, unsigned int flags, const char *ceiling_dirs, git_config *isolated_config)'
  if (repository.includes('git_repository_open_holi')) { if (!repository.includes(declaration)) throw new Error('Conflicting existing git_repository_open_holi patch') }
  else {
    let duplicate = original.replace(signature, 'int git_repository_open_holi(')
    const parameterEnd = duplicate.indexOf(')', duplicate.indexOf('int git_repository_open_holi('))
    if (parameterEnd < 0) throw new Error('Could not parse open_ext parameters')
    duplicate = `${duplicate.slice(0, parameterEnd)}, git_config *isolated_config${duplicate.slice(parameterEnd)}`
    const allocation = 'repo = repository_alloc();\n\tGIT_ERROR_CHECK_ALLOC(repo);'
    if (duplicate.split(allocation).length !== 2) throw new Error('Unexpected repository allocation')
    duplicate = duplicate.replace(allocation, `${allocation}\n\tif ((error = git_repository_set_config(repo, isolated_config)) < 0)\n\t\tgoto cleanup;`)
    repository = `${repository.slice(0, end)}\n\n${duplicate}${repository.slice(end)}`; await writeFile(repositoryPath, repository)
  }
  const headerPath = join(sourceRoot, 'include/git2/repository.h'); let header = await readFile(headerPath, 'utf8')
  if (!header.includes('git_repository_open_holi')) {
    const anchor = 'GIT_EXTERN(int) git_repository_open_ext('
    if (header.split(anchor).length !== 2) throw new Error('Unexpected libgit2 repository.h open_ext declaration')
    header = header.replace(anchor, `GIT_EXTERN(int) git_repository_open_holi(git_repository **out, const char *path, unsigned int flags, const char *ceiling_dirs, git_config *isolated_config);\n${anchor}`); await writeFile(headerPath, header)
  }
}
function run(command,args) { const result=spawnSync(command,args,{cwd:root,stdio:'inherit'}); if(result.error) throw result.error; if(result.status!==0) throw new Error(`${command} exited ${result.status}`) }
async function download(target=url, redirects=0, destination=archive) {
 if(redirects>5) throw new Error('libgit2 archive download exceeded redirect limit')
 const response=await new Promise((resolve,reject)=>{const request=https.get(target,{timeout:30000},res=>{if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.resume();resolve({redirect:new URL(res.headers.location,target).href})}else if(res.statusCode!==200)reject(new Error(`libgit2 download returned HTTP ${res.statusCode}`));else resolve({response:res})});request.setTimeout(30000,()=>request.destroy(new Error('libgit2 download timed out')));request.on('error',reject)})
 if(response.redirect)return download(response.redirect,redirects+1,destination); await pipeline(response.response,createWriteStream(destination))
}
async function checksum(path){return createHash('sha256').update(await readFile(path)).digest('hex')}
await mkdir(generated,{recursive:true})
if((await checksum(archive).catch(()=>null))!==sha256){await rm(archive,{force:true});const temporary=`${archive}.${process.pid}.${randomUUID()}.tmp`;try{await download(url,0,temporary);const digest=await checksum(temporary);if(digest!==sha256)throw new Error(`libgit2 archive SHA-256 mismatch: ${digest}`);await rename(temporary,archive)}finally{await rm(temporary,{force:true})}}
const stamp=join(generated,'build-stamp');const expectedStamp=`${sha256}\n${patchVersion}\n`
if((await readFile(stamp,'utf8').catch(()=>null))!==expectedStamp){await rm(source,{recursive:true,force:true});await rm(build,{recursive:true,force:true});await rm(prefix,{recursive:true,force:true});await mkdir(source,{recursive:true});run('tar',['-xzf',archive,'--strip-components=1','-C',source]);await patchRepository(source);await writeFile(stamp,expectedStamp)}
await rm(build,{recursive:true,force:true});await rm(prefix,{recursive:true,force:true})
const sdk=spawnSync('xcrun',['--sdk',sdkName,'--show-sdk-path'],{encoding:'utf8'});if(sdk.status!==0)throw new Error(`Xcode ${sdkName} SDK unavailable: ${sdk.stderr}`)
run('cmake',['-S',source,'-B',build,'-G','Unix Makefiles','-DCMAKE_SYSTEM_NAME=iOS',`-DCMAKE_OSX_SYSROOT=${sdk.stdout.trim()}`,`-DCMAKE_OSX_ARCHITECTURES=${device?'arm64':'arm64;x86_64'}`,'-DCMAKE_OSX_DEPLOYMENT_TARGET=26.0','-DCMAKE_INSTALL_PREFIX='+prefix,'-DBUILD_SHARED_LIBS=OFF','-DBUILD_TESTS=OFF','-DBUILD_CLI=OFF','-DBUILD_EXAMPLES=OFF','-DUSE_HTTPS=SecureTransport','-DUSE_SSH=OFF','-DUSE_BUNDLED_ZLIB=ON','-DUSE_HTTP_PARSER=builtin','-DREGEX_BACKEND=builtin'])
run('cmake',['--build',build,'--config','Release','--parallel']);run('cmake',['--install',build,'--config','Release'])
const destination=join(root,`App_Resources/iOS/libgit2${device?'/iphoneos':''}`);await mkdir(destination,{recursive:true});await copyFile(join(prefix,'lib/libgit2.a'),join(destination,'libgit2.a'));await cp(join(prefix,'include'),join(destination,'include'),{recursive:true});await copyFile(join(source,'COPYING'),join(destination,'COPYING.txt'));await writeFile(join(destination,'SOURCE.txt'),`libgit2 1.9.7\nSource: ${url}\nSHA-256: ${sha256}\nSDK: ${sdkName}\n`)
console.log(`Built pinned libgit2 ${sha256} for ${sdkName}`)
