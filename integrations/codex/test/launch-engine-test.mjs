import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {InputEngine} from '../lib/engine.js'
const commands=[],launches=[];let stallPreparation=false
const control={owner:null,executionId:c=>c?.threadId||'A',async acquire(){this.owner||={executionId:'A',leaseId:'lease-A'}},assert(){},async bind(){},async startLaunch(spec){launches.push(spec);return {ok:true,launchState:'pending',launchTicket:'owned-ticket',opened:null}},async pause(){},async release(){this.owner=null}}
function spawnFake(){
 const p=new EventEmitter();p.pid=123;p.exitCode=null;p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdout.setEncoding=()=>{};p.stderr.setEncoding=()=>{}
 p.stdin={write(line){const m=JSON.parse(line);commands.push(m.cmd)
  if(m.cmd==='prepareLaunch'){p.stdout.emit('data',JSON.stringify({event:'launch-preparation',id:m.id,stage:'indicator-enter',callerPid:123,callerBirth:'456',callerThreadId:7,apartment:'STA'})+'\n');if(stallPreparation)return}
  p.stdout.emit('data',JSON.stringify({id:m.id,ok:true,result:m.cmd==='prepareLaunch'?{ok:true,launch:{path:'C:\\owned-fixture.exe',temporaryPath:null,adaptation:{effect:'unverified'}}}:{ok:true,paused:false,elements:[]}})+'\n')
 },end(){setImmediate(()=>{p.exitCode=0;p.emit('exit',0);p.emit('close',0)})}}
 setImmediate(()=>p.stdout.emit('data','{"event":"ready"}\n'));return p
}
const engine=new InputEngine({controlLease:control,spawnProcess:spawnFake})
try{
 const opened=await engine.request('shellOpen',{path:'C:\\owned-fixture.exe',x:10,y:20});assert.equal(opened.launchState,'pending');assert.deepEqual(commands,['prepareLaunch']);assert.equal(launches.length,1);assert.equal(launches[0].x,10)
 const observed=await engine.request('observe',{hwnd:11});assert.equal(observed.ok,true);await engine.request('click',{hwnd:11,x:1,y:1});assert.deepEqual(commands,['prepareLaunch','observe','click'],'pending launch cannot occupy the sidecar input queue')
 const before=launches.length;const abort=new AbortController();abort.abort();await assert.rejects(engine.context.run({threadId:'A',abortSignal:abort.signal},()=>engine.request('shellOpen',{path:'C:\\owned-fixture.exe'})));assert.equal(launches.length,before)
 console.log('PASS real InputEngine seam: one async launch start after prepare, pending permits same-lane observe/click; pre-cancel zero launch; fake backend only')
}finally{await engine.stop()}
stallPreparation=true
const stalled=new InputEngine({controlLease:control,spawnProcess:spawnFake}),before=launches.length
try{await assert.rejects(stalled.request('shellOpen',{path:'C:\\owned-fixture.exe'},15),e=>e.code==='executor-fault'&&e.launchStarted===false&&e.launchPreparation.stage==='indicator-enter'&&e.launchPreparation.callerPid===123);assert.equal(launches.length,before);console.log('PASS preparation timeout preserves exact last safe stage/request id, no helper/native launch; transport seam only')}finally{await stalled.stop()}
