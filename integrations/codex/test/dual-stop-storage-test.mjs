// Actual C# watcher + named events + real Job. One internal save failure;
// synthetic stop payload, never installs hooks or sends app input.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {dirname} from 'node:path'
import {readFile,rm} from 'node:fs/promises'
import {InputEngine} from '../lib/engine.js'
import {DualControlLease} from '../lib/dual-control-lease.js'
import {startDualCoordinator,dualCall} from '../lib/dual-coordinator.js'
let failNext=false
const coordinator=await startDualCoordinator({testNamespace:'stop-storage-'+randomUUID(),onMembers:async()=>{},beforeStateWrite:()=>{if(failNext){failNext=false;throw new Error('owned injected write failure')}}})
const fixture=fileURLToPath(new URL('./fixtures/shared-pause-backend.ps1',import.meta.url))
const engines=['A','B'].map(id=>new InputEngine({controlLease:new DualControlLease({connection:async()=>coordinator.endpoint}),spawnProcess:(_file,_args,options)=>spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',fixture],options)}))
const context=i=>({threadId:i?'B':'A',name:'owned storage fixture'})
try{
 await Promise.all(engines.map((engine,i)=>engine.request('begin',{},30000,context(i))))
 const closed=engines.map(engine=>once(engine.proc,'close'))
 const original={reason:'control-escape',kind:'pause',source:'keyboard-hook',keyboard:{gesture:'Ctrl+Esc'},utcTimestamp:'2026-01-01T00:00:00Z',sessionId:'owned-stop-storage',sequence:1}
 failNext=true;await coordinator.surfaceStopForTest(original);await Promise.all(closed)
 assert.ok(engines.every(x=>x.proc===null));assert.equal(coordinator.state.data.desktopStop.utcTimestamp,original.utcTimestamp);assert.equal(coordinator.state.data.controllerFault.storageFault,true)
 const gate=JSON.parse(await readFile(coordinator.statePath.replace('.v3.json','.json'),'utf8'));assert.equal(gate.originalStopInfo.utcTimestamp,original.utcTimestamp);assert.equal(gate.controllerFault.storageFault,true)
 const denied=await dualCall(coordinator.endpoint,{identity:{executionId:'C',actorPid:process.pid},op:'acquire',intent:'begin'});assert.equal(denied.ok,false)
 assert.ok(coordinator.state.data.controllerFault,'failure must not silently restore input')
 await engines[0].request('resume',{},30000,context(0));await engines[0].request('finish',{},30000,context(0))
 assert.ok(coordinator.state.data.desktopStop,'A explicit resume must not clear B original pause')
 await engines[1].request('resume',{},30000,context(1));await engines[1].request('finish',{},30000,context(1));await coordinator.close()
 console.log('PASS actual C# event/real Job stop with first state-save failure: both workers stop despite failed write; original source/time preserved in gate, storage fault explicit, no automatic reenable, per-execution resume only. Synthetic stop, no physical hooks/UI/input.')
}finally{await Promise.allSettled(engines.map(x=>x.stop()));await coordinator.abortForTest().catch(()=>{});await rm(dirname(coordinator.statePath),{recursive:true,force:true})}
