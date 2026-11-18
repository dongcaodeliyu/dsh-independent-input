import assert from 'node:assert/strict'
import {AsyncLocalStorage} from 'node:async_hooks'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply} from '../index.js'
let releaseStatus,enteredStatus,enteredBegin
const entered=new Promise(r=>enteredStatus=r),barrier=new Promise(r=>releaseStatus=r)
const beginEntered=new Promise(r=>enteredBegin=r)
const dir=await mkdtemp(join(tmpdir(),'input-session-race-'))
let first=true,owner=null,acquires=0,tool;const acquired=[]
const control={manualPreviewContext:()=>({}),executionId:c=>c?.threadId,
 async status(){const snapshot={protocolVersion:3,owners:owner?[owner]:[],busy:false,canAcquire:true,position:0};if(first){first=false;enteredStatus();await barrier}return snapshot},
 async acquire(c){acquires++;acquired.push(c.threadId);owner={executionId:c.threadId,leaseId:'new-session'}},get owner(){return owner},async claimReminder(){return null}}
const context=new AsyncLocalStorage(),run=context.run.bind(context);let runs=0
context.run=(c,fn)=>run(c,()=>{if(++runs===2)enteredBegin();return fn()})
const engine={context,control,checkRequestCancelled(c){if(c.abortSignal?.aborted)throw new Error('cancelled')},async stop(){},async request(cmd){return {ok:true,sessionState:cmd==='begin'?'active':'finished',paused:false}}}
const dispose=await apply({tools:{register(t){tool=t;return()=>{}}}},{},{engine,defineTool:t=>t,settingsFile:join(dir,'settings.json')})
try{
 const finish=tool.execute({action:'finish',yieldSeconds:600},{threadId:'A'})
 await entered
 const begin=tool.execute({action:'begin'},{threadId:'A'})
 await beginEntered
 await new Promise(r=>setImmediate(r))
 const beforeRelease=acquires
 const other=await tool.execute({action:'begin'},{threadId:'B'});assert.equal(other.meta.ok,true)
 const abort=new AbortController(),cancelled=tool.execute({action:'begin'},{threadId:'A'},{signal:abort.signal}).then(()=>false,()=>true)
 abort.abort()
 releaseStatus()
 const [f,b]=await Promise.all([finish,begin])
 assert.equal(beforeRelease,0,'same-execution begin must not acquire while finish status is pending')
 assert.equal(f.meta.resourceState,'no-held-lane');assert.equal(b.meta.ok,true);assert.equal(owner.executionId,'A')
 assert.equal(await cancelled,true);assert.deepEqual(acquired,['B','A'])
 console.log('PASS registered tool barrier: same-execution begin waits for queued-only finish; new session remains active')
}finally{releaseStatus();dispose();await rm(dir,{recursive:true,force:true})}
