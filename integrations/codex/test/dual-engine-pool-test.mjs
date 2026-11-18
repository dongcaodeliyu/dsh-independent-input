// Actual engine/pool/coordinator IPC + real isolated Job child processes;
// protocol-only fixture backend is NOT Windows UIA/native/Host acceptance.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {startDualCoordinator} from '../lib/dual-coordinator.js'
import {ExecutionEnginePool} from '../lib/execution-engine-pool.js'
const namespace='pool-'+randomUUID(),fixture=fileURLToPath(new URL('./fixtures/dual-protocol-backend.cjs',import.meta.url))
const coordinator=await startDualCoordinator({testNamespace:namespace,onMembers:async()=>{},inspectRoot:hwnd=>({ok:true,target:{hwnd,pid:1,birth:'synthetic'}})})
const pool=new ExecutionEnginePool({connection:async()=>coordinator.endpoint,spawnProcess:(_file,_args,options)=>spawn(process.execPath,[fixture],options)})
const run=(id,fn)=>pool.context.run({threadId:id,name:'owned-'+id},fn)
try{
 await run('A',()=>pool.request('windows'));const readonly=pool.engineFor('A').proc.pid
 await run('A',()=>pool.request('begin'));assert.notEqual(pool.engineFor('A').proc.pid,readonly)
 await run('B',()=>pool.request('begin'));assert.notEqual(pool.engineFor('A').proc.pid,pool.engineFor('B').proc.pid)
 const a=await run('A',()=>pool.request('observe',{hwnd:100})),b=await run('B',()=>pool.request('observe',{hwnd:200}))
 assert.notEqual(a.observationId,b.observationId)
 assert.equal((await run('A',()=>pool.request('type',{hwnd:100,observationId:a.observationId,elementId:'owned',text:'owned-marker'}))).ok,true)
 assert.equal((await run('B',()=>pool.request('type',{hwnd:200,observationId:a.observationId,elementId:'owned',text:'owned-marker'}))).ok,false)
 assert.equal((await run('B',()=>pool.request('type',{hwnd:200,observationId:b.observationId,elementId:'owned',text:'owned-marker'}))).ok,true)
 await run('C',()=>pool.request('begin'))
 assert.equal((await pool.control.status('B')).occupied,3)
 await assert.rejects(run('D',()=>pool.request('begin')),e=>e.code==='control-busy')
 await run('D',()=>pool.control.cancel({threadId:'D'}))
 await run('C',()=>pool.request('finish'))
 await run('A',()=>pool.request('finish'));assert.equal(pool.engineFor('A').proc,null);assert.equal((await pool.control.status('B')).occupied,1)
 const active=run('B',()=>pool.request('stall',{},10000));await new Promise(r=>setTimeout(r,30));await pool.cancelRequest({threadId:'A'});assert.ok(pool.engineFor('B').pending.size)
 const stopped=pool.cancelRequest({threadId:'B'});await assert.rejects(active,e=>e.code==='host-interrupted');await stopped
 // Explicitly restore this self-owned synthetic actor, never a real desktop.
 await run('B',()=>pool.request('resume'));await run('B',()=>pool.request('finish'))
 console.log('PASS actual pool/engine/IPC/Job: three execution-isolated backends and observation stores, fourth FIFO, per-lane finish/cancel, readonly promotion. Synthetic protocol target, not native/GUI acceptance.')
 await coordinator.close()
}finally{await pool.stop();await coordinator.abortForTest().catch(()=>{});await rm(dirname(coordinator.statePath),{recursive:true,force:true})}
