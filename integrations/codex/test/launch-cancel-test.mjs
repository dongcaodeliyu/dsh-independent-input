import assert from 'node:assert/strict'
import {LaunchTickets,acceptLaunchStage} from '../lib/launch-tickets.js'
const registry=new LaunchTickets(),ended=[]
function ticket(id,pid){return {id:'ticket-'+id,executionId:id,leaseId:'lease-'+id,state:'pending',lastStage:'native-enter',nativeEntered:true,helper:{pid,birth:null},trace:[],proc:{pid,stdin:{end(){ended.push(id)}}}}}
const a=ticket('A',123),b=ticket('B',124);registry.byExecution.set('A',a);registry.byExecution.set('B',b)
assert.throws(()=>registry.status({executionId:'B',leaseId:'lease-B'},a.id),/not-owned/)
assert.throws(()=>registry.status({executionId:'A',leaseId:'new-lease'},a.id),/not-owned/)
await registry.cancel('A','host-cancel');assert.deepEqual(ended,['A']);assert.equal(b.state,'pending');assert.equal(a.state,'unknown')
const repeated=await registry.start({executionId:'A',leaseId:'lease-A'},{path:'not-dispatched',x:0,y:0});assert.equal(repeated.launchTicket,a.id);assert.equal(repeated.reason,'prior-launch-unknown-no-retry');assert.deepEqual(ended,['A'])
// A late successful native return after cancellation is evidence of possible
// acceptance, not proof cancellation retracted the OS launch.
a.trace=[];a.helper.birth=null
for(const stage of ['received','native-enter','native-return'])acceptLaunchStage(a,{stage,helperPid:123,helperBirth:'456',data:{accepted:true,applicationPid:999}})
assert.equal(a.state,'unknown');assert.equal(registry.status({executionId:'A',leaseId:'lease-A'},a.id).opened,true)
await registry.cancelAll('desktop-stop');assert.deepEqual(ended,['A','B']);await registry.cancelAll();assert.deepEqual(ended,['A','B'])
console.log('PASS ticket cancellation contract: own-only vs desktop-all; unknown does not retry; late acceptance remains uncertain/no OS-retract claim; no processes/input in this test')
