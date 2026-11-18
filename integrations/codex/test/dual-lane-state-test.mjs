import assert from 'node:assert/strict'
import {DualLaneState} from '../lib/dual-lane-state.js'
let time=0,counter=0
const state=new DualLaneState({}, {now:()=>time,id:()=>String(++counter)})
const actor=id=>({executionId:id,name:'owned-'+id,actor:{pid:1,birth:'owned'}})
const A=actor('A'),B=actor('B'),C=actor('C'),D=actor('D'),E=actor('E')
assert.equal(state.acquire(A).ok,true);assert.equal(state.acquire(B).ok,true);assert.equal(state.acquire(E).ok,true)
const lease=state.lane('A').leaseId;assert.equal(state.acquire(A).lane.leaseId,lease)
assert.equal(state.acquire(C).ok,false);assert.equal(state.snapshot('C').position,1)
assert.equal(state.acquire(D).ok,false);assert.equal(state.snapshot('D').position,2)
assert.ok(state.claimReminder('A'));state.delivered('A',lease);assert.equal(state.claimReminder('A'),null)
state.cancel('C');state.cancel('D');state.request(C);assert.equal(state.claimReminder('A'),null)
const root={hwnd:100,pid:1,birth:'generation'}
assert.equal(state.reserveRoot('A',root).ok,true);assert.equal(state.reserveRoot('B',root).reason,'target-root-busy')
assert.equal(state.reserveRoot('B',{...root,hwnd:200}).ok,true)
state.setMonitor('A','DISPLAY1');state.setMonitor('B','DISPLAY1');assert.equal(state.screenMembers().DISPLAY1.length,2)
state.setMonitor('A','DISPLAY2');assert.equal(state.screenMembers().DISPLAY1.length,1);assert.equal(state.screenMembers().DISPLAY2.length,1)
state.pause('A',{source:'host-cancel'});assert.equal(state.lane('B').paused,false);state.resume('A')
const stop={source:'keyboard-hook',keyName:'Ctrl+Esc',sessionId:'owned-global-stop',sequence:1}
state.pauseDesktop(stop);assert.equal(state.lane('A').paused,true);assert.equal(state.lane('B').paused,true)
state.resume('A');assert.equal(state.pauseDesktop(stop),false);assert.equal(state.lane('A').paused,false);assert.equal(state.lane('B').paused,true);assert.equal(state.acquire(D).reason,'desktop-paused');state.resume('B');state.resume('E');assert.equal(state.pauseDesktop(stop),false);assert.equal(state.data.desktopStop,null)
state.bindExecutor('A',{pid:1,birth:'generation'});assert.equal(state.finish('A',()=> 'unknown').ok,false);assert.equal(state.finish('A',()=> 'alive').ok,false)
assert.equal(state.finish('A',()=> 'dead').ok,true);assert.equal(state.lane('B').executionId,'B');assert.equal(state.snapshot('C').turn,'ready')
assert.equal(state.acquire(D).reason,'control-queue-turn');assert.equal(state.acquire(C).ok,true)
assert.ok(state.claimReminder('B'));assert.equal(state.claimReminder('B'),null)
state.cancel('D');assert.equal(state.claimReminder('C'),null);state.request(D);state.cancel('D');assert.equal(state.claimReminder('C'),null);state.request(D);assert.ok(state.claimReminder('C'))
time=120001;state.prune(()=> 'unknown');assert.equal(state.data.tickets.length,0);assert.equal(state.data.lanes.length,3)
assert.throws(()=>state.assertTarget('B',{...root,hwnd:999}),/target-reservation-mismatch/)
console.log('PASS pure v3 model: three slots, FIFO, root reservation, per-lease reminder, lane/desktop pause, dead-only finish, monitor membership; not native/host acceptance')
