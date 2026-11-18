// Actual engine seams, thin transport recorder. No backend/native/UI startup.
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {InputEngine} from '../lib/engine.js'
const children=[],order=[]
const control={supportsDual:true,requiresExecutorExit:true,owner:null,startupPermit:null,executionId:c=>c.threadId||'A',async acquire(){this.owner||={executionId:'A'}},assert(){assert.ok(this.owner)},executorEnvironment(){this.startupPermit=this.owner?'owned-permit':null;return {DSH_INPUT_READONLY:this.owner?'0':'1',DSH_INPUT_STARTUP_PERMIT:this.startupPermit||''}},async bind(pid){order.push('bind:'+pid)},async release(){order.push('release');this.owner=null},async status(){return {busy:!!this.owner}},async pause(){}}
function spawnFake(_file,_args,{env}){
 const p=new EventEmitter();p.pid=100+children.length;p.exitCode=null;p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdout.setEncoding=p.stderr.setEncoding=()=>{};p.env=env;p.commands=[]
 p.stdin={on(){},write(line){const message=JSON.parse(line);p.commands.push(message.cmd);order.push(message.cmd+':'+p.pid)
  if(message.cmd==='__launch'){assert.ok(order.includes('bind:'+p.pid));setImmediate(()=>p.stdout.emit('data','{"event":"ready"}\n'));return}
  if(message.cmd==='shutdown'){setImmediate(()=>{p.exitCode=0;p.emit('exit',0);p.emit('close',0)});return}
  setImmediate(()=>p.stdout.emit('data',JSON.stringify({id:message.id,ok:true,result:{ok:true,paused:false,sessionState:message.cmd==='finish'?'finished':'active'}})+'\n'))
 },end(){p.kill()}}
 p.kill=()=>{if(p.exitCode!==null)return;p.exitCode=1;p.emit('exit',1);p.emit('close',1)}
 children.push(p);if(env.DSH_INPUT_READONLY==='1')setImmediate(()=>p.stdout.emit('data','{"event":"ready"}\n'));return p
}
const engine=new InputEngine({controlLease:control,spawnProcess:spawnFake})
await engine.request('windows');await engine.request('observe',{hwnd:1})
assert.equal(children.length,1);assert.equal(children[0].env.DSH_INPUT_READONLY,'1');assert.ok(!order.some(x=>x.startsWith('bind:')))
await engine.request('begin',{},30000,{threadId:'A'})
assert.equal(children.length,2);assert.ok(children[0].commands.includes('shutdown'));assert.equal(children[1].env.DSH_INPUT_READONLY,'0')
assert.ok(order.indexOf('bind:101')<order.indexOf('__launch:101'));assert.ok(order.indexOf('__launch:101')<order.indexOf('begin:101'))
await engine.request('finish',{},30000,{threadId:'A'});assert.equal(children[1].exitCode,0);assert.equal(control.owner,null);assert.ok(order.indexOf('shutdown:101')<order.indexOf('release'))
console.log('PASS actual engine readonly windows/observe -> begin replaces non-promotable readonly process, bind-before-permit-before-input; finish exits exact backend before lease release. Thin fake transport, not GUI/OS acceptance.')
