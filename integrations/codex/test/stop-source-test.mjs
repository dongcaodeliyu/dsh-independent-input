import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {InputEngine} from '../lib/engine.js'
import {ControlLease} from '../lib/control-lease.js'
import {StopTracker,stopText} from '../lib/stop-info.js'
import {presentStatus} from '../lib/presentation.js'
const owner={executionId:'test-exec',rootId:'test-root',name:'测试主聊天 "引号" 🙂'}
const legacy=new StopTracker().record('escape',owner);assert.equal(legacy.source,'unknown');assert.equal(legacy.utcTimestamp,null)
const tracker=new StopTracker()
const esc={reason:'escape',source:'keyboard-hook',kind:'pause',utcTimestamp:new Date().toISOString(),sessionId:'native-test',sequence:1,ownerExecutionId:owner.executionId,ownerRootId:owner.rootId,ownerName:owner.name,keyboard:{vkCode:27,scanCode:1,flags:0,injected:false,eventType:256}}
tracker.record('escape',owner,esc);assert.equal(tracker.record('transport-eof',owner),esc)
assert.equal(tracker.record('host-cancel',owner),esc)
tracker.resume();assert.equal(tracker.current,null);assert.equal(tracker.lastStop,esc)
const second=tracker.record('host-cancel',owner);assert.notEqual(second.sessionId,esc.sessionId)
const fault=new StopTracker();const timeout=fault.record('backend-timeout:click',owner,null,{fault:true})
assert.equal(timeout.source,'backend-timeout');assert.equal(timeout.kind,'fault');assert.equal(fault.current,null)
assert.doesNotMatch(stopText(timeout),/Esc/);assert.match(stopText(esc),/来源未能确认/)
const compact=presentStatus({paused:true,stopInfo:esc,control:{stopInfo:esc,lastStop:esc}},256)
assert.equal(compact.stopInfo.source,'keyboard-hook');assert.equal(compact.stopInfo.keyboard,undefined);assert.equal(compact.control.stopInfo.ownerExecutionId,undefined)
assert.deepEqual(presentStatus({stopInfo:esc},256,true).stopInfo.keyboard,esc.keyboard)
const opts={testNamespace:'stop-source-'+randomUUID()},a=new ControlLease(opts),b=new ControlLease(opts)
try{
 await a.acquire({threadId:owner.executionId,rootId:owner.rootId,name:owner.name})
 const engine=new InputEngine({controlLease:a});engine.onData(JSON.stringify({event:'pause-state',paused:true,reason:'escape',stopInfo:esc,transportSealed:false})+'\n');
 await a.pause('escape',esc);assert.deepEqual(engine.stops.current,esc);await engine.interrupt('host-cancel');
 assert.deepEqual(engine.stops.current,esc);await a.pause('transport-eof',{...esc,reason:'transport-eof',source:'transport-eof',utcTimestamp:new Date(Date.now()+1000).toISOString()})
 const helper=a.helper,closed=once(helper,'close');helper.stdin.end();await closed
 const previousHome=process.env.CODEX_HOME;process.env.CODEX_HOME='C:\\isolated-stop-source-fixture'
 try{
  const state=await b.status('new-exec');assert.equal(state.ownerName,owner.name);assert.equal(state.stopInfo.ownerName,owner.name);assert.deepEqual(state.stopInfo,esc);assert.equal(state.pauseReason,'escape')
  await assert.rejects(b.acquire({threadId:'new-exec'}),e=>e.control.reason==='control-paused')
  await b.acquire({threadId:'new-exec',name:'继续的聊天'},'resume');assert.deepEqual(b.owner.stopInfo,esc)
  await b.resume();assert.equal(b.owner.stopInfo,null);assert.deepEqual(b.owner.lastStop,esc)
  await b.release('new-exec');const resumed=await b.status('new-exec');assert.equal(resumed.busy,false);assert.equal(resumed.stopInfo,null);assert.deepEqual(resumed.lastStop,esc)
 }finally{if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome}
 console.log('PASS actual tracker + real guardian: hostcancel/timeout/EOF distinct; cross-HOME Esc source/time/owner roundtrip and preservation; explicit resume/current clear/history retained; default compact/details keyboard')
}finally{for(const lease of [a,b])if(lease.owner){await lease.resume();await lease.release(lease.owner.executionId)}}
