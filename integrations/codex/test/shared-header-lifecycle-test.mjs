// Actual SharedHeaderHost control flow, thin transport only; no hooks/UI.
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {SharedHeaderHost} from '../lib/shared-header-host.js'
let bindResolve,spawnResolve,permitResolve,readyRelease,spawnCount=0
const spawned=new Promise(r=>spawnResolve=r),permit=new Promise(r=>permitResolve=r),commands=[],faults=[]
function fakeSpawn(){spawnCount++;const p=new EventEmitter();p.pid=100;p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdout.setEncoding=()=>{};p.stdin=new EventEmitter();p.stdin.write=line=>{const m=JSON.parse(line);commands.push(m.cmd);if(m.cmd==='__launch'){readyRelease=()=>p.stdout.emit('data','{"event":"ready"}\n');permitResolve();return}queueMicrotask(()=>{p.stdout.emit('data',JSON.stringify({id:m.id,ok:true,result:{ok:true,escapeHookRegistered:true}})+'\n');if(m.cmd==='shutdown')p.emit('close',0)})};p.stdin.end=()=>{};p.kill=()=>p.emit('close',1);spawnResolve(p);return p}
const host=new SharedHeaderHost({guardian:{call:()=>new Promise(r=>bindResolve=r)},spawnProcess:fakeSpawn,onFault:x=>faults.push(x)})
const one=host.update({},true);await spawned
const two=host.update({},true),closed=host.close();assert.deepEqual(commands,[])
bindResolve({ok:true});await permit;assert.deepEqual(commands,['__launch'])
readyRelease();await Promise.all([one,two,closed]);assert.equal(spawnCount,1);assert.deepEqual(commands,['__launch','status','sharedHeaders','sharedHeaders','shutdown']);assert.equal(faults.length,0)
const abnormal=new SharedHeaderHost({guardian:{call:async()=>({ok:true})},spawnProcess:()=>{const p=fakeSpawn();const original=p.stdin.write;p.stdin.write=line=>{original(line);if(JSON.parse(line).cmd==='__launch')queueMicrotask(()=>readyRelease())};return p},onFault:x=>faults.push(x)})
await abnormal.update({},true);abnormal.proc.kill();assert.equal(faults.length,1);assert.equal(faults[0].kind,'fault');assert.equal(faults[0].source,'backend-exit');await abnormal.close()
console.log('PASS actual header lifecycle: delayed bind/ready concurrent update+close share one spawn, permit before every command, normal shutdown no fault; healthy unexpected loss notifies controller-surface fault. Fake transport, no UI/hooks.')
