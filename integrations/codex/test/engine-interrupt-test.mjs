import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {InputEngine} from '../lib/engine.js'
// This file isolates transport fault semantics; real kernel lease behavior is
// covered separately by control-lease-test with actual child processes.
function fakeControl(){return {owner:null,executionId(){return 'transport-fixture'},async acquire(){this.owner||={executionId:'transport-fixture'}},assert(){},async bind(){},async pause(reason){if(this.owner)this.owner.pauseReason=reason},async resume(){if(this.owner)this.owner.pauseReason=null},async release(){this.owner=null},async status(){return {busy:!!this.owner,scope:'transport-unit-fixture',externalOfficialState:'unknown'}}}}
const children=[]
function spawnFake(_file,_args,{env}) {
 const p=new EventEmitter();p.exitCode=null;p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdout.setEncoding=()=>{};p.stderr.setEncoding=()=>{}
 p.focusPolicy=env.DSH_INPUT_FOCUS_POLICY; p.paused=Boolean(env.DSH_INPUT_INITIAL_PAUSE_REASON);p.finished=env.DSH_INPUT_INITIAL_FINISHED==='1';p.commands=[]
 p.send=(id,result)=>p.stdout.emit('data',JSON.stringify({id,ok:true,result})+'\n')
 p.stdin={write(line){const m=JSON.parse(line);p.commands.push(m);if(m.cmd==='__interrupt'){p.paused=true;return}if(m.cmd==='stall'||m.cmd==='hold')return;if(m.cmd==='begin')p.finished=false;if(m.cmd==='resume')p.paused=false;p.send(m.id,{ok:true,paused:p.paused,sessionState:p.finished?'finished':'idle'})},end(){setTimeout(()=>{p.exitCode=0;p.emit('exit',0,null);p.emit('close',0,null)},5)}}
 p.kill=()=>{p.exitCode=1;p.emit('exit',1,null);p.emit('close',1,null)}
 children.push(p);setImmediate(()=>p.stdout.emit('data','{"event":"ready"}\n'));return p
}
const engine=new InputEngine({controlLease:fakeControl(),spawnProcess:spawnFake})
await engine.ensure();await engine.request('status');assert.equal(children[0].focusPolicy,'preserve')
await assert.rejects(engine.request('stall',{},15),e=>e.code==='executor-fault'&&e.partial==='possible')
assert.ok(children[0].commands.some(c=>c.cmd==='__interrupt'))
assert.equal((await engine.request('status')).sessionState,'finished')
await engine.request('begin');assert.equal(engine.faulted,false)
const hold=engine.request('hold',{},2000);await new Promise(r=>setTimeout(r,2))
const current=engine.proc,id=engine.seq
children[0].emit('exit',99,null);children[0].stdout.emit('data',JSON.stringify({id,ok:true,result:{wrongGeneration:true}})+'\n')
assert.equal(engine.proc,current);assert.ok(engine.pending.has(id),'old executor must not clear new pending')
current.send(id,{ok:true});assert.deepEqual(await hold,{ok:true})
const active=engine.request('stall',{},2000);await new Promise(r=>setTimeout(r,2));engine.interrupt('host-cancel')
await assert.rejects(active,e=>e.code==='host-interrupted')
assert.equal((await engine.request('status')).paused,true)
assert.equal((await engine.request('begin')).paused,true,'begin must not clear host cancel latch')
await engine.request('resume');assert.equal(engine.hostPauseReason,'')
engine.proc.paused=true;engine.proc.stdout.emit('data',JSON.stringify({event:'pause-state',paused:true,reason:'escape',transportSealed:false})+'\n')
assert.equal((await engine.request('stall',{},15)).paused,true,'global pause blocks before transport dispatch')
await engine.interrupt('backend-timeout:fixture',{host:false,fault:true})
assert.equal((await engine.request('status')).paused,true,'physical Esc must survive timeout/restart')
assert.equal((await engine.request('begin')).paused,true,'fault begin cannot clear real Esc')
await engine.stop();const count=children.length
await assert.rejects(engine.request('status'),e=>e.code==='host-interrupted');assert.equal(children.length,count)
const blocked=new InputEngine({controlLease:fakeControl(),spawnProcess:(...args)=>{const p=spawnFake(...args);p.stdin.end=()=>{};p.kill=()=>false;return p}})
await blocked.ensure();await blocked.request('status');const blockedChild=blocked.proc
await blocked.interrupt('backend-timeout:test',{host:false,fault:true})
assert.equal(blocked.proc,blockedChild,'unconfirmed kill cannot be called exited')
await assert.rejects(blocked.request('status'),e=>e.code==='executor-stop-unconfirmed')
blockedChild.exitCode=0;blockedChild.emit('exit',0,null);blockedChild.emit('close',0,null)
console.log('PASS: real engine timeout interrupts old executor, fault requires begin, host pause survives restart/begin, old stdout/exit cannot settle new pending, disposed EOF cannot restart')

const drained=new InputEngine({controlLease:fakeControl(),spawnProcess:(...args)=>{const p=spawnFake(...args);p.stdin.end=()=>{};return p}})
await drained.ensure();await drained.request('status');const draining=drained.proc
// Node permits buffered stdio data after exit, before close.
draining.exitCode=0;draining.emit('exit',0,null)
assert.equal(drained.proc,draining)
draining.stdout.emit('data',JSON.stringify({event:'pause-state',paused:true,reason:'escape',transportSealed:true})+'\n')
assert.equal(drained.hostPauseReason,'escape')
draining.emit('close',0,null)
assert.equal((await drained.request('status')).paused,true)
assert.equal((await drained.request('begin')).paused,true)
await drained.stop();drained.proc?.emit('close',0,null)
console.log('PASS: exit -> final physical pause-state -> close drains before replacement; new readonly/begin retain Esc')

// A fresh native stop must win over an older in-flight resume reply.
const racing=new InputEngine({controlLease:fakeControl(),spawnProcess:(...args)=>{const p=spawnFake(...args),write=p.stdin.write.bind(p.stdin);p.stdin.write=line=>{const m=JSON.parse(line);if(m.cmd==='resume')p.stdout.emit('data',JSON.stringify({event:'pause-state',paused:true,reason:'escape',stopInfo:{reason:'escape',source:'keyboard-hook',utcTimestamp:new Date().toISOString(),sessionId:'racing-stop',sequence:2},transportSealed:false})+'\n');return write(line)};return p}})
await racing.ensure();assert.equal((await racing.request('resume')).paused,true)
assert.equal(racing.hostPauseReason,'escape');const sent=racing.proc.commands.length
assert.equal((await racing.request('move',{x:1,y:2})).paused,true);assert.equal(racing.proc.commands.length,sent)
await racing.stop()
console.log('PASS actual engine in-flight resume/new Esc race: new stop wins; global latch blocks next input before transport')
