import assert from 'node:assert/strict'
import {AsyncLocalStorage} from 'node:async_hooks'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply} from '../index.js'
import {DualLaneState} from '../lib/dual-lane-state.js'

const dir=await mkdtemp(join(tmpdir(),'input-resume-feedback-'))
const state=new DualLaneState()
const context=id=>({threadId:id})
const stop={source:'keyboard-hook',reason:'control-escape',keyboard:{gesture:'Ctrl+Esc',injected:false}}
state.acquire({executionId:'A'});state.acquire({executionId:'B'});state.pauseDesktop(stop)
const calls=[]
let immediatelyPause=false,unknownReadback=false,hostDenied=false,explicitResumeFailure=false

const control={
  manualPreviewContext:()=>({actorKind:'manual-preview'}),
  executionId:c=>c?.threadId,
  async acquire(c,intent){
    const id=c.threadId
    const result=state.acquire({executionId:id},intent)
    if(hostDenied)throw Object.assign(new Error('host permission refused'),{code:'permission-refusal',control:await this.status(id)})
    if(!result.ok)throw Object.assign(new Error(result.reason),{code:'control-busy',control:{...await this.status(id),reason:result.reason}})
    this.owner=result.lane
  },
  async status(id){
    if(unknownReadback)return {busy:null,observationError:'missing'}
    const snapshot=state.snapshot(id)
    return {...snapshot,busy:!snapshot.canAcquire,reason:snapshot.turn==='resume-required'?'execution-resume-required':snapshot.desktopPaused?'control-paused':'owned'}
  },
  async claimReminder(){return null},
}
const engine={
  context:new AsyncLocalStorage(),
  control,
  async stop(){},
  async request(cmd){
    const id=this.context.getStore().threadId
    calls.push(cmd)
    if(cmd==='resume'){
      state.resume(id)
      if(immediatelyPause)state.pauseDesktop(stop)
      return {paused:false,sessionState:'active',...(explicitResumeFailure?{ok:false}:{} )}
    }
    assert.equal(cmd,'finish')
    state.finish(id,()=> 'dead')
    return {ok:true,paused:false,sessionState:'finished'}
  },
}
let tool
const dispose=await apply({tools:{register(value){tool=value;return()=>{}}}},{},
  {engine,defineTool:value=>value,settingsFile:join(dir,'absent-settings.json')})
const invoke=(action,id,args={})=>tool.execute({action,...args},context(id))
try{
  for(const [action,args] of [['finish',{}],['finish',{yieldSeconds:60}],['begin',{}]]){
    const blocked=await invoke(action,'A',args)
    assert.equal(blocked.meta.requiredAction,'resume')
    assert.equal(blocked.meta.inputSent,false)
    assert.match(blocked.text,/无需重复请示/)
  }
  const foreign=await invoke('finish','C')
  assert.equal(foreign.meta.requiredAction,undefined)
  assert.match(foreign.text,/等待原执行器/)
  hostDenied=true
  const denied=await invoke('finish','A')
  assert.equal(denied.meta.reason,'permission-refusal')
  assert.equal(denied.meta.requiredAction,undefined)
  hostDenied=false
  state.retire('A',()=> 'dead')
  assert.equal((await invoke('finish','A')).meta.requiredAction,'resume')
  assert.deepEqual(calls,[])

  immediatelyPause=true
  const interrupted=await invoke('resume','A')
  assert.equal(interrupted.meta.ok,false)
  assert.equal(interrupted.meta.paused,true)
  assert.doesNotMatch(interrupted.text,/已恢复/)
  assert.deepEqual(calls,['resume'])

  immediatelyPause=false
  unknownReadback=true
  const unread=await invoke('resume','A')
  assert.equal(unread.meta.reason,'resume-unconfirmed')
  assert.equal(unread.meta.ok,false)
  assert.doesNotMatch(unread.text,/已恢复/)
  unknownReadback=false

  explicitResumeFailure=true
  const failed=await invoke('resume','A')
  assert.equal(failed.meta.ok,false)
  assert.doesNotMatch(failed.text,/已恢复/)
  explicitResumeFailure=false

  const resumed=await invoke('resume','A')
  assert.equal(resumed.meta.ok,true)
  assert.equal(resumed.meta.paused,false)
  assert.match(resumed.text,/本执行器已恢复/)
  assert.match(resumed.text,/其他执行器的暂停仍有效/)
  assert.equal((await invoke('finish','A')).meta.completionScope,'input-session')
  assert.equal(state.lane('A'),undefined)
  assert.equal(state.lane('B').paused,true)
  assert.deepEqual(calls,['resume','resume','resume','resume','finish'])
  console.log('PASS public tool feedback: owning pause, halted identity, foreign/denied isolation, readback-confirmed resume, concurrent stop, unknown readback, explicit finish')
}finally{dispose();await rm(dir,{recursive:true,force:true})}
