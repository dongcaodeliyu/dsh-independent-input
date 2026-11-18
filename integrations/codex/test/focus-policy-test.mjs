import {fixtureControl} from './transport-fixture-control.mjs'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply} from '../index.js'
import {InputEngine} from '../lib/engine.js'
const dir=await mkdtemp(join(tmpdir(),'input-focus-policy-'))
const original=InputEngine.prototype.request
let calls=[],state={paused:false,sessionState:'active'},statusFailure=false
InputEngine.prototype.request=async function(cmd,args){calls.push({cmd,args,policy:this.focusPolicy});if(cmd==='status'){if(statusFailure)throw new Error('status transport unavailable');return {...state}};return {ok:true,via:args.mode==='uia'?'uia-element':'message-hwnd',mayActivate:args.mode==='uia'}}
try {
 for(const policy of [undefined,'preserve','invalid','allow-activation']) {
  const settingsFile=join(dir,'settings.json');await writeFile(settingsFile,JSON.stringify({enabled:true,...(policy ? {focusPolicy:policy}:{})}))
  let tool;const dispose=await apply({tools:{register(v){tool=v;return()=>{}}}}, {}, {controlLease:fixtureControl(),defineTool:v=>v,settingsFile})
  try {
   for(const action of ['click','type','key','scroll','drag']) {
    for(const variant of [{},{windowObservationId:'fresh-geometry'},...(['click','type'].includes(action)?[{observationId:'fresh',elementId:'e29'}]:[])]) {
     calls=[]
     const r=await tool.execute({action,hwnd:172628422,x:2943,y:295,text:'offline',keys:'enter',mode:'uia',focusPolicy:'allow-activation',...variant})
     if(policy==='allow-activation'){assert.equal(calls.length,1);assert.equal(r.meta.mayActivate,true)}
     else {assert.equal(calls.filter(c=>c.cmd!=='status').length,0,'mode/extra argument cannot grant activation');assert.equal(calls[0].cmd,'status','stop precedence must be read only');assert.equal(r.meta.reason,'focus-policy-preserve');assert.equal(r.meta.inputSent,false);assert.equal(r.meta.providerCalled,false)}
    }
   }
   if(policy!=='allow-activation') {
    for(const stopped of [{paused:true,sessionState:'active',pauseReason:'escape'},{paused:false,sessionState:'finished'}]) {
     state=stopped;calls=[];const r=await tool.execute({action:'click',hwnd:1,mode:'uia',x:1,y:1})
     assert.equal(r.meta.reason,stopped.sessionState==='finished'?'session-finished':'paused');assert.equal(calls.filter(c=>c.cmd!=='status').length,0)
    }
    state={paused:false,sessionState:'active'};statusFailure=true;calls=[]
    const failed=await tool.execute({action:'type',hwnd:1,mode:'uia',text:'blocked'})
    assert.equal(failed.meta.ok,false);assert.notEqual(failed.meta.reason,'focus-policy-preserve');assert.equal(calls.filter(c=>c.cmd!=='status').length,0)
    statusFailure=false
   }
   for(const mode of ['auto','message']){calls=[];const r=await tool.execute({action:'click',hwnd:1,x:1,y:1,mode});assert.equal(calls.length,1);assert.equal(r.meta.ok,true)}
   for(const invalid of [{action:'type',hwnd:1,mode:'value',text:'fixture'},{action:'type',hwnd:1,mode:'value',text:'fixture',observationId:'fresh',elementId:'e1',x:0,y:0},{action:'key',hwnd:1,keys:'enter',x:0}]){calls=[];const denied=await tool.execute(invalid);assert.equal(denied.meta.ok,false);assert.equal(calls.length,0,'invalid narrow contract must not dispatch')}
   calls=[];await tool.execute({action:'type',hwnd:1,mode:'value',text:'fixture',observationId:'fresh',elementId:'e1'});assert.equal(calls.length,1);assert.equal(calls[0].args.mode,'value');assert.equal(calls[0].args.observationId,'fresh')
   calls=[];await tool.execute({action:'key',hwnd:1,keys:'enter',x:12,y:34,windowObservationId:'fresh'});assert.equal(calls.length,1);assert.equal(calls[0].args.x,12);assert.equal(calls[0].args.y,34)
   calls=[];await tool.execute({action:'observe',hwnd:1,mode:'uia'});assert.equal(calls[0].cmd,'observe','readonly UIA remains available');assert.equal(calls[0].policy,policy==='allow-activation'?'allow-activation':'preserve')
  }finally{dispose()}
 }
 console.log('PASS: actual index default/preserve/invalid policy blocks uia before dispatch; semantic/coordinate/window-guard variants covered; per-action grant ignored; only persistent allow-activation enables provider; auto/message/readonly kept; fake engine, no game/UI')
}finally{InputEngine.prototype.request=original;await rm(dir,{recursive:true,force:true})}
