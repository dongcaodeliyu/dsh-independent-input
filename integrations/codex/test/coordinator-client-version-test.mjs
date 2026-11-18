import assert from 'node:assert/strict'
import {createConnection} from 'node:net'
import {randomUUID} from 'node:crypto'
import {readFile,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {startDualCoordinator,dualCall} from '../lib/dual-coordinator.js'
const namespace='wire-version-'+randomUUID(),coordinator=await startDualCoordinator({testNamespace:namespace,onMembers:async()=>{}})
const identity={executionId:'OWNED',actorPid:process.pid},call=(op,args={})=>dualCall(coordinator.endpoint,{op,identity,...args})
const raw=message=>new Promise((resolve,reject)=>{const p=createConnection(coordinator.endpoint);let b='';p.setEncoding('utf8');p.on('error',reject);p.on('connect',()=>p.write(JSON.stringify(message)+'\n'));p.on('data',s=>{b+=s;if(b.includes('\n')){resolve(JSON.parse(b));p.end()}})})
try{
 let acquired=await call('acquire');assert(acquired.ok)
 const before=await readFile(coordinator.statePath,'utf8')
 for(const op of ['acquire','finish','wait','pause','pause-desktop','monitor','launch-start'])for(const version of [undefined,'old-runtime']){
  const result=await raw({op,identity,leaseId:acquired.lane.leaseId,...(version?{clientRuntimeVersion:version}:{})});assert.equal(result.reason,'coordinator-client-runtime-mismatch');assert.equal(result.inputSent,false);assert.equal(await readFile(coordinator.statePath,'utf8'),before)
 }
 assert.equal((await raw({op:'status',identity})).occupied,1);assert.equal((await raw({op:'hello'})).protocolVersion,3)
 assert((await call('pause',{stopInfo:{reason:'host-cancel',source:'host-cancel'}})).ok);assert.equal((await call('status')).owners[0].paused,true);acquired=await call('acquire',{intent:'resume'});assert(acquired.ok);assert((await call('resume')).ok)
 assert((await call('pause-desktop',{stopInfo:{reason:'control-escape',source:'keyboard-hook'}})).ok);assert.equal((await call('status')).desktopPaused,true);acquired=await call('acquire',{intent:'resume'});assert(acquired.ok);assert((await call('resume')).ok)
 assert((await call('prepare-finish',{leaseId:acquired.lane.leaseId})).ok);assert((await call('finish',{leaseId:acquired.lane.leaseId})).ok);await coordinator.close()
 console.log('PASS real isolated coordinator wire: unstamped/wrong-version writers rejected before mutation, old readonly allowed; new acquire/finish and single/global pause/resume accepted; metadata-only, no physical hook/input')
}finally{await coordinator.abortForTest().catch(()=>{});await rm(dirname(coordinator.statePath),{recursive:true,force:true})}
