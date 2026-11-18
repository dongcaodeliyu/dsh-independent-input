// Real Windows mutex, Job and self-owned sleepers only. Never real desktop scope.
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {once} from 'node:events'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {readFile,rm} from 'node:fs/promises'
const exec=promisify(execFile),namespace='dual-job-'+randomUUID()
const script=fileURLToPath(new URL('../lib/dual-guardian.ps1',import.meta.url))
const sleepers=[],guards=[]
const sleeper=()=>{const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});sleepers.push(p);return p}
function guardian(pid,extra=[]){const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-CoordinatorPid',String(pid),'-TestNamespace',namespace,...extra],{windowsHide:true,stdio:['pipe','pipe','pipe']});guards.push(p);let buffer='',queue=[],waiters=[];p.stdout.setEncoding('utf8');p.stdout.on('data',s=>{buffer+=s;let i;while((i=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(waiters.length)waiters.shift()(value);else queue.push(value)}});p.stderr.on('data',s=>process.stderr.write(s));return {p,reply:()=>queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),send(value){p.stdin.write(JSON.stringify(value)+'\n');return this.reply()}}}
const exited=p=>p.exitCode!==null?Promise.resolve():Promise.race([once(p,'exit'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('owned process exit deadline')),10000))])
let dir
try{
 const coord=sleeper(),a=sleeper(),b=sleeper(),c=sleeper(),d=sleeper();const g=guardian(coord.pid,['-TestAssignFailureOnce']);const ready=await g.reply();assert.equal(ready.ok,true);dir=join(process.env.LOCALAPPDATA,'dsh-independent-input-control','tests',namespace)
 assert.equal((await g.send({cmd:'bind',pid:a.pid})).reason,'executor-job-bind-failed')
 const pendingGate=JSON.parse(await readFile(join(dir,ready.scope+'.json'),'utf8'));assert.equal(pendingGate.executors[0].assigned,false)
 assert.equal((await g.send({cmd:'bind',pid:a.pid})).ok,true);assert.equal((await g.send({cmd:'bind',pid:b.pid})).ok,true)
 assert.equal((await g.send({cmd:'bind',pid:a.pid})).ok,true)
 assert.equal((await g.send({cmd:'bind',pid:c.pid})).ok,true)
 assert.equal((await g.send({cmd:'bind',pid:d.pid})).reason,'executor-capacity')
 assert.equal((await g.send({cmd:'release'})).reason,'executor-stop-unconfirmed')
 g.p.kill();await exited(g.p);await Promise.all([exited(a),exited(b),exited(c)])
 assert.equal(d.exitCode,null,'unassigned self-owned process must remain alive')
 const gate=JSON.parse(await readFile(join(dir,ready.scope+'.json'),'utf8'));assert.equal(gate.kind,'dual-lane-upgrade-gate');assert.equal(gate.executors.length,3)
 const legacy=fileURLToPath(new URL('../lib/control-lease.ps1',import.meta.url))
 const reply=JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',legacy,'-OwnerJson',JSON.stringify({executionId:'old-test',actorPid:process.pid}),'-TestNamespace',namespace],{windowsHide:true,timeout:10000})).stdout.trim());assert.equal(reply.reason,'control-state-unknown-repair-required')
 const next=guardian(coord.pid);assert.equal((await next.reply()).reason,'old-generation-live-or-unknown');await exited(next.p)
 console.log('PASS real isolated guardian: three Job-bound sleepers, fourth refused, repeat bind idempotent, live release refused; guardian termination stops all three assigned workers only; gate persists and legacy v2 entry refuses; live coordinator blocks recovery')
}finally{
 for(const p of guards)if(p.exitCode===null)p.kill()
 for(const p of sleepers)if(p.exitCode===null)p.kill()
 await Promise.allSettled([...guards,...sleepers].map(exited))
 if(dir)await rm(dir,{recursive:true,force:true})
}
