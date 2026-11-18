import assert from 'node:assert/strict'
import {DualLaneState} from '../lib/dual-lane-state.js'
import {DualControlLease} from '../lib/dual-control-lease.js'
const state=new DualLaneState(),client=new DualControlLease({connection:async()=>{throw Error('no IPC in consumer test')}})
state.acquire({executionId:'A'})
let view=client.describeSnapshot(state.snapshot('B'),'B');assert.equal(view.occupied,1);assert.equal(view.availableSlots,1);assert.equal(view.busy,false);assert.equal(view.canAcquire,true)
state.acquire({executionId:'B'});state.request({executionId:'C'});state.request({executionId:'D'})
view=client.describeSnapshot(state.snapshot('C'),'C');assert.equal(view.busy,true);assert.equal(view.position,1)
state.finish('A',()=> 'dead');assert.equal(client.describeSnapshot(state.snapshot('D'),'D').busy,true);assert.equal(client.describeSnapshot(state.snapshot('C'),'C').busy,false)
state.pause('B',{reason:'owned-stop'});view=client.describeSnapshot(state.snapshot('B'),'B');assert.equal(view.busy,true);assert.equal(view.canAcquire,false);assert.equal(view.reason,'execution-resume-required');assert.equal(state.acquire({executionId:'B'}).ok,false)
console.log('PASS actual v3 public consumer: second slot admitted, full third waits, FIFO prevents bypass, own paused refuses ordinary begin. Pure state/client contract.')
