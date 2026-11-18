// Actual C# watcher + named Windows events + coordinator/mutex/Job. Synthetic
// stop payload, no physical keyboard event, UI, held key/button or native input.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {dirname} from 'node:path'
import {rm} from 'node:fs/promises'
import {InputEngine} from '../lib/engine.js'
import {DualControlLease} from '../lib/dual-control-lease.js'
import {startDualCoordinator,dualCall} from '../lib/dual-coordinator.js'
const coordinator=await startDualCoordinator({testNamespace:'shared-pause-'+randomUUID(),onMembers:async()=>{}})
const fixture=fileURLToPath(new URL('./fixtures/shared-pause-backend.ps1',import.meta.url))
const engines=['A','B'].map(id=>new InputEngine({controlLease:new DualControlLease({connection:async()=>coordinator.endpoint}),spawnProcess:(_file,_args,options)=>spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',fixture],options)}))
const context=index=>({threadId:index?'B':'A',name:'owned pause fixture'})
try{
 await Promise.all(engines.map((engine,i)=>engine.request('begin',{},30000,context(i))))
 const original={reason:'control-escape',source:'keyboard-hook',kind:'pause',keyboard:{gesture:'Ctrl+Esc'},utcTimestamp:'2026-01-01T00:00:00.000Z',sessionId:'synthetic-owned-stop',sequence:1}
 await dualCall(coordinator.endpoint,{op:'pause-desktop',identity:{executionId:'A'},stopInfo:original})
 const deadline=Date.now()+5000;while(engines.some(x=>!x.hostPauseReason)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20))
 assert.ok(engines.every(x=>x.hostPauseReason==='control-escape'))
 for(const engine of engines){assert.equal(engine.stops.current.utcTimestamp,original.utcTimestamp);assert.equal(engine.stops.current.source,'keyboard-hook')}
 await engines[0].request('resume',{},30000,context(0));assert.equal(engines[0].hostPauseReason,'');assert.equal(engines[1].hostPauseReason,'control-escape')
 const snapshot=await engines[0].control.status('A');assert.equal(snapshot.owners.find(x=>x.executionId==='B').paused,true)
 await engines[0].request('finish',{},30000,context(0));assert.equal((await engines[1].control.status('B')).occupied,1)
 await engines[1].request('resume',{},30000,context(1));await engines[1].request('finish',{},30000,context(1))
 console.log('PASS actual production C# shared-pause watcher/Windows events: synthetic global stop reaches both engines with original timestamp/source; A resume/finish leaves B paused; independent B resume/finish. No physical hotkey, hooks, UI or application input.')
 await coordinator.close()
}finally{await Promise.allSettled(engines.map(x=>x.stop()));await coordinator.abortForTest().catch(()=>{});await rm(dirname(coordinator.statePath),{recursive:true,force:true})}
