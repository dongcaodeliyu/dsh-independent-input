// Two genuinely different frontend processes use the production default
// detached-host wrapper. Isolated namespace + headless UI seam, no app input.
import assert from 'node:assert/strict'
import {fork,execFile} from 'node:child_process'
import {once} from 'node:events'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {dirname} from 'node:path'
import {readFile,rm} from 'node:fs/promises'
const exec=promisify(execFile)
async function verifyDeath(victimId){
const namespace='df-'+randomUUID(),frontends=[]
function frontend(id){const proc=fork(fileURLToPath(new URL('./fixtures/dual-frontend.mjs',import.meta.url)),[namespace,id],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});frontends.push(proc);proc.stderr.on('data',s=>process.stderr.write(s));return proc}
function request(proc,op){const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('frontend reply deadline')),15000);const listener=m=>{if(m.id!==id)return;clearTimeout(timer);proc.off('message',listener);m.error?reject(new Error(m.error)):resolve(m.result)};proc.on('message',listener);proc.send({id,op})})}
function ready(proc){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>done(new Error('frontend ready deadline')),20000);const message=m=>done(null,m),exit=code=>done(new Error('frontend exited before ready: '+code));function done(error,value){clearTimeout(timer);proc.off('message',message);proc.off('exit',exit);error?reject(error):resolve(value)}proc.once('message',message);proc.once('exit',exit)})}
let readyA,readyB
try{
 const a=frontend('A');readyA=await ready(a);assert.equal(readyA.ready,true)
 const b=frontend('B');readyB=await ready(b);assert.equal(readyB.ready,true)
 assert.notEqual(a.pid,b.pid);assert.notEqual(readyA.coordinatorPid,a.pid);assert.notEqual(readyA.coordinatorPid,b.pid);assert.equal(readyA.coordinatorPid,readyB.coordinatorPid)
 const victim=victimId==='A'?a:b,survivor=victimId==='A'?b:a,survivorId=victimId==='A'?'B':'A',survivorReady=victimId==='A'?readyB:readyA
 const statePath=readyA.metadata.replace(/\.json$/,'.v3.json'),victimExit=once(victim,'exit');victim.kill();await victimExit
 // No C request, wait, or status RPC: only inspect the owned persisted file.
 const deadline=Date.now()+8000;let state
 do{state=JSON.parse(await readFile(statePath,'utf8'));if(state.lanes.length===1&&state.lanes[0].executionId===survivorId)break;await new Promise(r=>setTimeout(r,25))}while(Date.now()<deadline)
 assert.equal(state.lanes.length,1);assert.equal(state.lanes[0].executionId,survivorId);assert.equal(state.lanes[0].executor.pid,survivorReady.backendPid);assert.equal(state.lanes[0].monitor,'OWNED-TEST-SCREEN')
 assert.equal(state.halted[victimId].beginRequired,true,'EOF crash must retain fault requirement without consuming slot')
 const status=await request(survivor,'status');assert.equal(status.control.occupied,1);assert.equal(status.control.owners[0].executionId,survivorId);assert.equal(survivor.exitCode,null)
 await request(survivor,'finish');await request(survivor,'exit').catch(()=>{})
 const exitDeadline=Date.now()+8000;let alive=true
 while(Date.now()<exitDeadline){const result=await exec('powershell.exe',['-NoProfile','-Command',`try{[Diagnostics.Process]::GetProcessById(${readyA.coordinatorPid})|Out-Null;'alive'}catch [ArgumentException]{'dead'}`],{windowsHide:true});alive=result.stdout.trim()==='alive';if(!alive)break;await new Promise(r=>setTimeout(r,50))}
 assert.equal(alive,false,'idle detached host must exit')
 console.log('PASS actual production wrapper/two frontend processes/real PS C# fixture: '+victimId+' dies, sibling survives; no-RPC dead-lane/header cleanup; sibling status/finish; idle host exits. No UI/game acceptance.')
}finally{
 for(const proc of frontends)if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done}
 if(readyA)await rm(dirname(readyA.metadata),{recursive:true,force:true})
}
}
await verifyDeath('A');await verifyDeath('B')
