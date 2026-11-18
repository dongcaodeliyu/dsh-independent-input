// Real named-pipe/mutex/Job control plane; root seam is synthetic, no windows.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {rm,readFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {startDualCoordinator,dualCall} from '../lib/dual-coordinator.js'
const namespace='dual-ipc-'+randomUUID(),workers=[]
const actor=executionId=>({executionId,name:'owned-'+executionId,actorPid:process.pid})
const root=hwnd=>({ok:true,target:{hwnd,pid:1,birth:'synthetic-root-generation'}})
let holdRender=false,releaseRender,enteredRender
const renderEntered=new Promise(resolve=>enteredRender=resolve)
const coordinator=await startDualCoordinator({testNamespace:namespace,inspectRoot:root,onMembers:async()=>{if(holdRender){enteredRender();await new Promise(resolve=>releaseRender=()=>{holdRender=false;resolve()})}}})
const leases=new Map()
const call=async(id,op,args={},options={})=>{if(op==='finish'){await call(id,'prepare-finish');args={leaseId:leases.get(id),...args}};if(op==='prepare-finish')args={leaseId:leases.get(id),...args};const result=await dualCall(coordinator.endpoint,{identity:actor(id),op,...args},options);if(op==='acquire'&&result.ok)leases.set(id,result.lane.leaseId);return result}
async function worker(){const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});workers.push(p);return p}
async function stop(p){if(p.exitCode===null&&p.signalCode===null){const done=once(p,'exit');p.kill();await done}}
try{
 assert.equal((await call('A','acquire')).ok,true);assert.equal((await call('B','acquire')).ok,true)
 const a=await worker(),b=await worker();assert.equal((await call('A','bind',{pid:a.pid})).ok,true);assert.equal((await call('B','bind',{pid:b.pid})).ok,true)
 assert.equal((await call('B','bind',{pid:a.pid})).reason,'executor-owned-by-another-lane')
 const unassigned=await worker();assert.equal((await call('A','bind',{pid:unassigned.pid})).reason,'previous-executor-live-or-unknown');await stop(unassigned)
 assert.equal((await call('E','acquire')).ok,true);const e=await worker();assert.equal((await call('E','bind',{pid:e.pid})).ok,true)
 assert.equal((await call('C','acquire')).ok,false);assert.equal((await call('C','status')).position,1)
 assert.equal((await call('E','reserve',{hwnd:300})).ok,true)
 assert.ok((await call('A','claim')).notice);assert.equal((await call('A','claim')).notice,null)
 assert.equal((await call('A','reserve',{hwnd:100})).ok,true);assert.equal((await call('B','reserve',{hwnd:200})).ok,true)
 assert.equal((await call('A','reserve',{hwnd:200})).reason,'target-root-busy')
 // Conflict released A's old root; B can switch to it, then A can bind B's old
 // root without holding X while waiting for Y.
 assert.equal((await call('B','reserve',{hwnd:100})).ok,true);assert.equal((await call('A','reserve',{hwnd:200})).ok,true)
 holdRender=true
 const blockedMonitor=call('A','monitor',{device:'owned-test-display',x:10,y:20});await renderEntered
 const desktopStop=call('A','pause-desktop',{stopInfo:{source:'keyboard-hook',reason:'owned-synthetic-stop',keyboard:{gesture:'Ctrl+Esc'}}})
 const stopDeadline=Date.now()+3000;let pausedSnapshot
 do{pausedSnapshot=await call('A','status');if(pausedSnapshot.desktopPaused)break;await new Promise(r=>setTimeout(r,10))}while(Date.now()<stopDeadline)
 assert.equal(pausedSnapshot.desktopPaused,true,'header render wait blocked stop metadata/status')
 releaseRender();assert.equal((await blockedMonitor).reason,'lane-paused');await desktopStop
 assert.equal((await call('E','status')).owners.find(x=>x.executionId==='E').paused,true)
 await call('A','resume');await call('B','resume');await call('E','resume')
 await call('E','prepare-finish');await stop(e);await call('E','finish')
 await call('A','pause',{stopInfo:{source:'host-cancel'}});assert.equal((await call('B','status')).owners.find(x=>x.executionId==='B').paused,false)
 assert.equal((await call('A','finish')).reason,'lane-paused')
 await stop(a);await call('C','request') // maintenance retires exact dead A
 assert.equal((await call('C','status')).occupied,1)
 assert.equal((await call('A','acquire')).reason,'execution-resume-required')
 assert.equal((await call('C','acquire')).ok,true)
 await call('C','finish')
 assert.equal((await call('A','acquire',{intent:'resume'})).ok,true);await call('A','resume');await call('A','finish')
 const abort=new AbortController();await call('C','request');await call('D','request')
 const pending=call('D','wait',{waitMs:45000},{signal:abort.signal});await call('D','status');abort.abort();await assert.rejects(pending)
 const deadline=Date.now()+5000;while((await call('D','status')).position&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));assert.equal((await call('D','status')).position,0)
 await call('C','cancel')
 // A normal finish intent is durable before executor EOF. A concurrent wait
 // may prune the dead worker first; finish must return that exact receipt.
 await call('B','prepare-finish');const finishingLease=leases.get('B');await stop(b)
 await call('C','request');await call('D','request');const handed=await call('D','wait',{waitMs:100});assert.equal(handed.owners.some(x=>x.executionId==='B'),false)
 const receipt=await dualCall(coordinator.endpoint,{identity:actor('B'),op:'finish',leaseId:finishingLease});assert.equal(receipt.ok,true);assert.equal(receipt.leaseId,finishingLease);assert.equal(receipt.completed,true)
 await call('C','cancel');await call('D','cancel')
 assert.equal((await call('F','acquire')).ok,true);const failed=await worker();await call('F','bind',{pid:failed.pid});await stop(failed)
 await call('G','request');assert.equal((await call('F','acquire')).reason,'execution-begin-required');assert.equal((await call('F','acquire',{intent:'resume'})).reason,'execution-begin-required')
 await call('G','cancel');assert.equal((await call('F','acquire',{intent:'begin'})).ok,true);assert.equal(coordinator.state.lane('F').paused,false);assert.equal(coordinator.state.lane('F').lastStop.kind,'fault');await call('F','finish')
 assert.equal((await call('B','status')).occupied,0)
 const unboundActor=await worker();assert.equal((await dualCall(coordinator.endpoint,{op:'acquire',identity:{executionId:'UNBOUND',actorPid:unboundActor.pid}})).ok,true);await stop(unboundActor)
 const retirementDeadline=Date.now()+3000;let durable
 do{durable=JSON.parse(await readFile(coordinator.statePath,'utf8'));if(!durable.lanes.some(x=>x.executionId==='UNBOUND'))break;await new Promise(r=>setTimeout(r,25))}while(Date.now()<retirementDeadline)
 assert.equal(durable.lanes.some(x=>x.executionId==='UNBOUND'),false,'confirmed dead unbound actor must retire without another RPC');assert.equal(durable.halted.UNBOUND.beginRequired,true)
 console.log('PASS real isolated IPC+Job: three workers/fourth FIFO, same-root conflict releases old reservation, once reminder, hoststop isolated, dead paused lane retired with resume requirement, wait cancellation does not block status; synthetic root seam is not HWND/GUI acceptance')
 await coordinator.close()
}finally{
 for(const p of workers)await stop(p)
 if(!coordinator.guardianPid){}else await coordinator.abortForTest().catch(()=>{})
 await rm(dirname(coordinator.statePath),{recursive:true,force:true})
}
