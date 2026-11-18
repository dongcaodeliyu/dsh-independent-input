// Actual isolated guardian protocol. The copied teardown sleeps AFTER releasing
// kernel+state mutexes, making the live-guardian exit window deterministic.
import {spawn,execFile} from 'node:child_process'
import {createInterface} from 'node:readline'
import {readFile,writeFile,mkdtemp,copyFile,readdir,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import assert from 'node:assert/strict'
const dir=await mkdtemp(join(tmpdir(),'queue-wakeup-')), ns='wakeup-'+randomUUID();const script=join(dir,'control-lease.ps1')
await copyFile('lib/control-state.ps1',join(dir,'control-state.ps1'))
let guardian=await readFile('lib/control-lease.ps1','utf8');guardian=guardian.replace('$mutex.Dispose();$stateMutex.Dispose()',"if($released){[Threading.Thread]::Sleep(1500)}; $mutex.Dispose();$stateMutex.Dispose()")
await writeFile(script,guardian)
const ctx=id=>({executionId:id,name:id,actorPid:process.pid,intent:'begin'}),args=(op,id,ms=6000)=>['-NoProfile','-NonInteractive','-File',script,'-TestNamespace',ns,'-Operation',op,'-OwnerJson',JSON.stringify(ctx(id)),'-WaitMs',String(ms)]
const operation=(op,id,ms)=>new Promise((yes,no)=>{const p=execFile('powershell.exe',args(op,id,ms),{windowsHide:true},(e,out)=>e?no(e):yes(JSON.parse(out)));p.stdin.end()})
let owner;const replies=[];const lines=[]
function next(){return new Promise(resolve=>{if(lines.length)resolve(lines.shift());else replies.push(resolve)})}
function cmd(value){const answer=next();owner.stdin.write(JSON.stringify(value)+'\n');return answer}
try{
owner=spawn('powershell.exe',args('acquire','A'),{windowsHide:true,stdio:['pipe','pipe','inherit']});createInterface({input:owner.stdout}).on('line',line=>{const v=JSON.parse(line);if(replies.length)replies.shift()(v);else lines.push(v)})
assert.equal((await next()).ok,true);await cmd({cmd:'pause',reason:'escape',stopInfo:{reason:'escape',source:'keyboard-hook'}});await cmd({cmd:'resume'})
const wait=operation('wait','B');await new Promise(r=>setTimeout(r,1000));const start=Date.now();await cmd({cmd:'release'});owner.stdin.end();const ready=await wait;const releaseMs=Date.now()-start;assert.equal(ready.waitResult,'ready');console.log(JSON.stringify({case:'lastStop-release-live-guardian',releaseMs}));assert.ok(releaseMs<3500,'ready must not wait full request deadline after guardian exits')
if(owner.exitCode===null)await once(owner,'close');owner=null;await operation('cancel','B')
// Head death produces no queue write/event. A waiting C must notice internally.
const sleeper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const old=ctx('B');old.actorPid=sleeper.pid
await new Promise((yes,no)=>{const p=execFile('powershell.exe',[...args('request','B').slice(0,-4),'-OwnerJson',JSON.stringify(old)],{windowsHide:true},(e)=>e?no(e):yes());p.stdin.end()})
let waiting=operation('wait','C');await new Promise(r=>setTimeout(r,1000));let at=Date.now();sleeper.kill();await once(sleeper,'exit');let result=await waiting;assert.equal(result.turn,'ready');assert.ok(Date.now()-at<2500);console.log('PASS pending wait notices confirmed-dead head without a queue event');await operation('cancel','C')
await operation('request','B');const folder=join(process.env.LOCALAPPDATA,'dsh-independent-input-control','tests',ns);const qpath=join(folder,(await readdir(folder)).find(f=>f.endsWith('.queue.json')));const q=JSON.parse(await readFile(qpath,'utf8'));q.tickets[0].expiresUtc=new Date(Date.now()+2200).toISOString();await writeFile(qpath,JSON.stringify(q));at=Date.now();result=await operation('wait','C');assert.equal(result.turn,'ready');assert.ok(Date.now()-at<4500);console.log('PASS pending wait notices expired head before wait deadline');await operation('cancel','C')
console.log('GREEN actual isolated wakeup protocol; no input backend/UI')
}finally{if(owner){owner.stdin.end();if(owner.exitCode===null)await once(owner,'close')}await rm(dir,{recursive:true,force:true})}
