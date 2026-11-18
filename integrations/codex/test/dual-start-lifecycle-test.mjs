// Actual engine/coordinator/Job failure timings, owned non-UI protocol worker.
// Actual PowerShell pre-hook barrier is separately executor-bootstrap-test.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {rm} from 'node:fs/promises'
import {InputEngine} from '../lib/engine.js'
import {DualControlLease} from '../lib/dual-control-lease.js'
import {startDualCoordinator} from '../lib/dual-coordinator.js'
const fixture=fileURLToPath(new URL('./fixtures/dual-protocol-backend.cjs',import.meta.url))
for(const phase of ['before-spawn','before-bind','after-bind']){
 const coordinator=await startDualCoordinator({testNamespace:'start-'+randomUUID(),onMembers:async()=>{}}),control=new DualControlLease({connection:async()=>coordinator.endpoint})
 const children=[],writes=[];let waitingResolve;const waiting=new Promise(r=>waitingResolve=r)
 const engine=new InputEngine({controlLease:control,spawnProcess:(_file,_args,options)=>{const p=spawn(process.execPath,[fixture],options);children.push(p);p.stdout.on('data',s=>{if(s.toString().includes('bootstrap-waiting'))waitingResolve()});const write=p.stdin.write.bind(p.stdin);p.stdin.write=(line,...rest)=>{writes.push(JSON.parse(line).cmd);return write(line,...rest)};return p}})
 const context={threadId:'owned-'+phase,name:'owned fixture'}
 try{
  await control.acquire(context,'begin')
  const originalBind=control.bind.bind(control)
  if(phase==='before-spawn')await coordinator.abortForTest()
  else control.bind=async pid=>{if(phase==='before-bind'){await waiting;await coordinator.abortForTest();return originalBind(pid)}const result=await originalBind(pid);await coordinator.abortForTest();return result}
  await assert.rejects(engine.request('begin',{},30000,context))
  if(phase==='before-spawn')assert.equal(children.length,0)
  assert.ok(!writes.includes('begin'),'lost coordinator must not allow an application command')
  const deadline=Date.now()+5000;while(children.some(p=>p.exitCode===null&&p.signalCode===null)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20))
  assert.ok(children.every(p=>p.exitCode!==null||p.signalCode!==null),'unpermitted orphan or assigned worker remained alive')
  console.log('PASS real IPC/Job '+phase+': no application command, owned workers exit; non-UI protocol fixture')
 }finally{await engine.stop();await coordinator.abortForTest().catch(()=>{});await rm(dirname(coordinator.statePath),{recursive:true,force:true})}
}
