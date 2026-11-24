export type PtyHostLaunch = { file: string; args: string[]; cwd: string }

/** Keep the PTY host's protocol implementation embedded in the owned Node root. */
const bootstrap = String.raw`
const pty=require(process.argv[1]), MAX=1024*1024; let buffer=Buffer.alloc(0), terminal, ready=false;
function emit(x){process.stdout.write(JSON.stringify(x)+'\n')}
function fail(message){emit({type:'error',message});if(terminal)terminal.kill();else process.exitCode=1}
function frame(line){let x;try{x=JSON.parse(line)}catch{return fail('invalid JSON')}
if(!ready){if(!x||typeof x.file!=='string'||!Array.isArray(x.args)||typeof x.cwd!=='string'||!x.env||!Number.isInteger(x.cols)||!Number.isInteger(x.rows))return fail('invalid startup');try{terminal=pty.spawn(x.file,x.args,{cwd:x.cwd,env:x.env,cols:x.cols,rows:x.rows,useConpty:true});terminal.onData(data=>emit({type:'data',data:Buffer.from(data).toString('base64')}));terminal.onExit(result=>emit({type:'exit',...result}));ready=true;emit({type:'ready',pid:terminal.pid})}catch{return fail('PTY spawn failed')}return}
try{if(x.type==='input')terminal.write(x.data);else if(x.type==='resize')terminal.resize(x.cols,x.rows);else if(x.type==='close')terminal.kill();else fail('invalid command')}catch{return fail('PTY command failed')}}
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>MAX)return fail('frame too large');let n;while((n=buffer.indexOf(10))>=0){frame(buffer.subarray(0,n).toString());buffer=buffer.subarray(n+1)}})
`

export function ownedPtyHostPlan(
  nodeImage: string,
  nodePtyModule: string,
  native: PtyHostLaunch,
): PtyHostLaunch {
  return { file: nodeImage, args: ['-e', bootstrap, nodePtyModule], cwd: native.cwd }
}
