import assert from 'node:assert/strict'
import {DualLaneState} from '../lib/dual-lane-state.js'
const cases=[{tickets:[7]},{halted:{A:false}},{halted:{A:{executionId:'A',beginRequired:true,stopInfo:{kind:'pause',reason:'control-escape'}}}}]
let failures=0
for(const record of cases){const description=JSON.stringify(record);let rejected=false;try{const state=new DualLaneState(record);state.prune(()=> 'unknown');state.recoverDeadGeneration();state.acquire({executionId:'A'},'begin')}catch(error){rejected=error.message==='dual-state-unknown'}if(!rejected){console.log('RED malformed record admitted',description);failures++}}
assert.equal(failures,0,'malformed persisted queue/stop state must be rejected before prune/recovery')
for(const phase of ['fresh','lane','queue','paused','retired-pause','retired-fault','resuming','finished','recovered']){
 const state=new DualLaneState(),a={executionId:'A',actor:{pid:1,birth:'owned'}},b={executionId:'B',actor:{pid:2,birth:'owned'}}
 if(phase!=='fresh')state.acquire(a)
 if(phase==='queue'){state.acquire(b);state.request({executionId:'C'})}
 if(['paused','retired-pause','resuming'].includes(phase)){state.pause('A',{kind:'pause',reason:'control-escape',source:'keyboard-hook'});if(phase!=='paused')state.retire('A',()=> 'dead');if(phase==='resuming')state.acquire(a,'resume')}
 if(phase==='retired-fault'){state.bindExecutor('A',{pid:1,birth:'owned'});state.retire('A',()=> 'dead')}
 if(phase==='finished')state.finish('A',()=> 'dead')
 if(phase==='recovered')state.recoverDeadGeneration()
 assert.doesNotThrow(()=>new DualLaneState(JSON.parse(JSON.stringify(state.data))),phase)
}
console.log('PASS persistent schema: three corruption RED cases refuse before prune; actual mutator fresh/lane/queue/pause/fault/resume/finish/recovery records retained')
