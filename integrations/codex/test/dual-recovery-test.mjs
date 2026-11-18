// Real coordinator process/Job crash and generation recovery, isolated names.
import assert from 'node:assert/strict'
import {fork,spawn} from 'node:child_process'
import {once} from 'node:events'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {dirname} from 'node:path'
import {rm,readFile} from 'node:fs/promises'
import {startDualCoordinator,dualCall} from '../lib/dual-coordinator.js'
const namespace='recovery-'+randomUUID(),children=[]
const host=fork(fileURLToPath(new URL('./fixtures/dual-coordinator-host.mjs',import.meta.url)),[namespace],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']})
const [ready]=await once(host,'message');let recovered
const call=(id,op,args={})=>dualCall(ready.endpoint,{identity:{executionId:id,actorPid:process.pid},op,...args})
try{
 for(const id of ['A','B']){await call(id,'acquire');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});children.push(p);await call(id,'bind',{pid:p.pid})}
 const stop={kind:'pause',source:'host-cancel',reason:'host-cancel',utcTimestamp:'2026-01-01T00:00:00Z'};await call('A','pause',{stopInfo:stop})
 const exits=children.map(p=>once(p,'exit')),hostExit=once(host,'exit');host.kill();await hostExit;await Promise.all(exits)
 const old=JSON.parse(await readFile(ready.statePath,'utf8'));assert.equal(old.lanes.length,2)
 recovered=await startDualCoordinator({testNamespace:namespace,onMembers:async()=>{}})
 assert.equal(recovered.state.data.lanes.length,0)
 assert.equal(recovered.state.data.halted.A.stopInfo.utcTimestamp,stop.utcTimestamp)
 assert.equal(recovered.state.acquire({executionId:'A'}).reason,'execution-resume-required')
 assert.equal(recovered.state.acquire({executionId:'B'}).reason,'execution-begin-required')
 assert.equal(recovered.state.data.halted.B.lastStop.kind,'fault')
 assert.equal(recovered.state.acquire({executionId:'B'},'begin').ok,true);recovered.state.finish('B',()=> 'dead')
 assert.equal(recovered.state.acquire({executionId:'A'},'resume').ok,true);recovered.state.resume('A');recovered.state.finish('A',()=> 'dead')
 await recovered.close()
 console.log('PASS real coordinator crash closes Job workers; new generation recovers only after old processes dead, retires occupancy, preserves A original hoststop/resume requirement, B fault requires begin without fake user pause')
}finally{
 if(host.exitCode===null&&host.signalCode===null)host.kill()
 for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill()
 await recovered?.abortForTest().catch(()=>{})
 await rm(dirname(ready.statePath),{recursive:true,force:true})
}
