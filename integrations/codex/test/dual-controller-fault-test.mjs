// Real isolated Job workers. Surface-loss callback is injected internally;
// physical hotkey/GUI remains untested here.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {dirname} from 'node:path'
import {rm} from 'node:fs/promises'
import {startDualCoordinator,dualCall} from '../lib/dual-coordinator.js'
const coordinator=await startDualCoordinator({testNamespace:'surface-loss-'+randomUUID(),onMembers:async()=>{}}),workers=[]
const leases=new Map()
const call=async(id,op,args={})=>{if(op==='finish'){await call(id,'prepare-finish');args={leaseId:leases.get(id),...args}};if(op==='prepare-finish')args={leaseId:leases.get(id),...args};const result=await dualCall(coordinator.endpoint,{identity:{executionId:id,actorPid:process.pid},op,...args});if(op==='acquire'&&result.ok)leases.set(id,result.lane.leaseId);return result}
try{
 for(const id of ['A','B']){await call(id,'acquire',{intent:'begin'});const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});workers.push(p);await call(id,'bind',{pid:p.pid})}
 const exits=workers.map(p=>once(p,'exit'))
 await coordinator.surfaceFaultForTest({kind:'fault',source:'backend-exit',reason:'backend-controller-surface-exit',utcTimestamp:new Date().toISOString()});await Promise.all(exits)
 const status=await call('A','status');assert.equal(status.controllerFault.kind,'fault');assert.equal(status.desktopPaused,false)
 assert.equal((await call('A','acquire')).reason,'controller-fault-begin-required')
 assert.ok(Object.values(coordinator.state.data.halted).every(x=>x.beginRequired&&!x.stopInfo))
 // Healthy surface callback seam + explicit begin only, not automatic handoff.
 assert.equal((await call('A','acquire',{intent:'begin'})).ok,true);await call('A','finish');await coordinator.close()
 console.log('PASS real Job surface-loss: both own workers exit, controller fault remains visible and blocks implicit input, no fake user pause, explicit begin+healthy projection required; no UI/hotkey test')
}finally{for(const p of workers)if(p.exitCode===null&&p.signalCode===null)p.kill();await coordinator.abortForTest().catch(()=>{});await rm(dirname(coordinator.statePath),{recursive:true,force:true})}
