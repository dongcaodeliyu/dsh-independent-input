import assert from 'node:assert/strict'
import {AsyncLocalStorage} from 'node:async_hooks'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
const {apply}=await import(process.argv[2]?pathToFileURL(resolve(process.argv[2])):new URL('../index.js',import.meta.url))
import {DualLaneState} from '../lib/dual-lane-state.js'
const dir=await mkdtemp(join(tmpdir(),'input-yield-')),state=new DualLaneState(),calls=[]
state.acquire({executionId:'A'});state.acquire({executionId:'B'});state.request({executionId:'C'})
const control={manualPreviewContext(){return {actorKind:'manual-preview'}},owner:{executionId:'A',leaseId:state.lane('A').leaseId},executionId:c=>c?.threadId,async acquire(){},async status(id){return {...state.snapshot(id),busy:!state.snapshot(id).canAcquire}},async cancel(c){state.cancel(c.threadId);return state.snapshot(c.threadId)},async claimReminder(){return null},async delivered(){}}
const engine={context:new AsyncLocalStorage(),control,async stop(){},async request(cmd){calls.push(cmd);if(cmd==='begin'){const acquired=state.acquire({executionId:'A'});if(!acquired.ok)return {ok:false,reason:acquired.reason};control.owner=acquired.lane;return {ok:true,sessionState:'active',paused:false}}if(cmd==='finish'){state.finish('A',()=> 'dead');return {ok:true,sessionState:'finished',paused:false}}return {ok:true}}}
let tool;const dispose=await apply({tools:{register(t){tool=t;return()=>{}}}},{},{engine,defineTool:t=>t,settingsFile:join(dir,'absent-settings.json')})
try{
 const before=Date.now(),[result,concurrent]=await Promise.all([tool.execute({action:'finish',yieldSeconds:600},{threadId:'A'}),tool.execute({action:'finish',yieldSeconds:600},{threadId:'A'})]);assert.equal(concurrent.meta.resourceYield.untilUtc,result.meta.resourceYield.untilUtc);assert.equal(calls.filter(x=>x==='finish').length,1)
 assert.equal(result.meta.completionScope,'input-session');assert.equal(result.meta.resourceYield.requestedSeconds,600);assert(Date.parse(result.meta.resourceYield.untilUtc)>=before+600000);assert.equal(result.meta.resourceYield.continuation,'same-active-executor');assert.equal(result.meta.resourceYield.taskPauseRequested,false)
 const firstDeadline=result.meta.resourceYield.untilUtc,firstCalls=calls.length
 const repeated=await tool.execute({action:'finish',yieldSeconds:600},{threadId:'A'});assert.equal(repeated.meta.resourceYield.untilUtc,firstDeadline);assert.equal(calls.length,firstCalls)
 const realNow=Date.now;try{Date.now=()=>Date.parse(firstDeadline)+1000;const expired=await tool.execute({action:'finish',yieldSeconds:600},{threadId:'A'});assert.equal(expired.meta.resourceYield.untilUtc,firstDeadline);assert.equal(calls.length,firstCalls)}finally{Date.now=realNow}
 assert.equal(state.lane('A'),undefined);assert(state.lane('B'));assert.equal(state.ticket('C').executionId,'C');assert(!calls.some(x=>/pause|resume|goal/.test(x)))
 assert.equal((await tool.execute({action:'finish',yieldSeconds:-1},{threadId:'A'})).meta.reason,'invalid-resource-yield')
 // C explicitly cancels its own fixture ticket; finish/yield above did not.
 const beforeQueuedYield=calls.length;const queued=await tool.execute({action:'finish',yieldSeconds:600},{threadId:'C'});assert.equal(queued.meta.resourceState,'no-held-lane');assert.equal(state.ticket('C'),undefined);assert(state.lane('B'));assert.equal(calls.length,beforeQueuedYield);await tool.execute({action:'begin'},{threadId:'A'})
 const currentNow=Date.now;try{Date.now=()=>Date.parse(firstDeadline)+1000;const next=await tool.execute({action:'finish',yieldSeconds:600},{threadId:'A'});assert(Date.parse(next.meta.resourceYield.untilUtc)>Date.parse(firstDeadline))}finally{Date.now=currentNow}

 console.log('PASS actual registered finish/yield result: input-session scope, bounded deadline guidance, no goal/pause/resume calls; sibling and foreign FIFO retained. Model/host continuation not simulated as accepted.')
}finally{dispose();await rm(dir,{recursive:true,force:true})}
