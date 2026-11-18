import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {AsyncLocalStorage} from 'node:async_hooks'
import {apply} from '../index.js'
import {InputEngine} from '../lib/engine.js'
import {presentControl,presentObservation} from '../lib/presentation.js'
const dir=await mkdtemp(join(tmpdir(),'control-contract-'));let tool,acquires=0,requests=0,cancels=0,pauses=0,spawns=0,resolveAcquire
const control={owner:{executionId:'A'},executionId:c=>c?.threadId,async acquire(c){acquires++;await new Promise(r=>resolveAcquire=r);this.owner={executionId:c.threadId}},async status(){return {busy:true,ownerExecutionId:this.owner?.executionId}},async request(){requests++;return raw},async wait(){requests++;return raw},async cancel(){cancels++;return raw},async claimReminder(){return null},async pause(){pauses++},async disconnect(){},manualPreviewContext(){return {threadId:'preview'}}}
const raw={owner:{executionId:'A',rootId:'root',name:'主聊天',projectName:'项目',pid:999,birth:'private',stopInfo:{reason:'escape',source:'keyboard-hook',keyboard:{vkCode:27},sequence:9}},queue:[{executionId:'B',name:'排队',projectName:'项目二',position:1,sequence:4,ticketId:'internal'}],position:1,turn:'queued',waitResult:'timeout',lastStop:{reason:'escape',source:'keyboard-hook',sequence:9}}
const settingsFile=join(dir,'settings.json');await writeFile(settingsFile,'{"enabled":false}')
const engine=new InputEngine({controlLease:control,spawnProcess(){spawns++;throw new Error('must not start')}})
const dispose=await apply({tools:{register(t){tool=t;return()=>{}}}},{},{defineTool:v=>v,settingsFile,engine})
try{
for(const action of ['control_request','control_wait']){const result=await tool.execute({action},{threadId:'B'});assert.equal(result.meta.reason,'disabled')}
assert.equal(requests,0);assert.equal(control.owner.executionId,'A');assert.equal((await tool.execute({action:'control_cancel'},{threadId:'B'})).meta.ok,true);assert.equal(cancels,1)
const small=presentControl(raw);assert.equal(small.ownerExecutionId,'A');assert.equal(small.ownerProjectName,'项目');assert.equal(small.owner,undefined);assert.equal(small.lastStop.sequence,undefined);assert.equal(small.queue[0].ticketId,undefined);assert.equal(presentControl(raw,true),raw)
dispose.cancelRequest({threadId:'B'});assert.equal(pauses,0);dispose.cancelRequest({threadId:'A'});await new Promise(r=>setImmediate(r));assert.equal(pauses,1)
// Actual engine cancellation while acquire is unresolved; no backend is started.
engine.hostPauseReason=null;const abort=new AbortController();const pending=engine.context.run({threadId:'B',abortSignal:abort.signal},()=>engine.request('type',{hwnd:1,text:'fixture'}));await new Promise(r=>setImmediate(r));abort.abort();resolveAcquire();await assert.rejects(pending,e=>e.code==='host-interrupted');assert.equal(spawns,0);assert.equal(pauses,2)
// Actual tool wrapper must also stop a request cancelled during its outer acquire.
await writeFile(settingsFile,'{"enabled":true}');let tool2,startAcquire,grantAcquire,paused2=0
const started=new Promise(r=>startAcquire=r),control2={...control,owner:null,async acquire(c){startAcquire();await new Promise(r=>grantAcquire=r);this.owner={executionId:c.threadId}},async pause(){paused2++}}
const engine2=new InputEngine({controlLease:control2,spawnProcess(){spawns++;throw new Error('must not start')}})
const dispose2=await apply({tools:{register(t){tool2=t;return()=>{}}}},{},{defineTool:v=>v,settingsFile,engine:engine2})
const abort2=new AbortController(),late=tool2.execute({action:'begin'},{threadId:'C'},{signal:abort2.signal});await started;abort2.abort();grantAcquire();assert.equal((await late).meta.reason,'host-interrupted');assert.equal(paused2,1);assert.equal(spawns,0);dispose2()
const edit={type:'ControlType.Edit',enabled:true,offscreen:false,patterns:['Value'],nativeWindowHandle:0,password:false,state:{readonly:false}}
const project=e=>presentObservation({elements:[e]}).elements[0]
assert.equal(project(edit).valueWrite,'foreground-root-under-preserve');assert.deepEqual(project(edit).backgroundActions,[]);for(const change of [{offscreen:true},{enabled:false},{password:true},{nativePassword:true},{nativeReadOnly:true},{state:{readonly:true}},{type:'ControlType.Button'},{patterns:[]}])assert.equal(project({...edit,...change}).valueWrite,undefined)
assert.deepEqual(project({...edit,nativeWindowHandle:1,nativeClass:'Edit'}).backgroundActions,['type']);assert.equal(control.owner.executionId,'B')
console.log('PASS actual index disabled request/wait gate + cancel cleanup; compact/full control projections; trusted-owner cancellation isolation; real engine cancelled acquire starts no backend; Value capability/native compatibility')
}finally{dispose();await rm(dir,{recursive:true,force:true})}
