import assert from 'node:assert/strict'
import {openOnMonitor,placeWindow} from '../lib/window-actions.js'
const monitors=[{device:'MAIN',primary:true,bounds:{x:0,y:0,width:2560,height:1600},workArea:{x:0,y:0,width:2560,height:1528}},{device:'SIDE',primary:false,bounds:{x:2560,y:0,width:1920,height:1080},workArea:{x:2560,y:0,width:1920,height:1020}}]
function fixture({pid=42,existingPid=7,count=1,pauseAt=0,returnedBounds=null,failAfterLaunch=false}={}) {
 const calls=[];let statuses=0,opened=false
 return {calls,async request(cmd,args){calls.push({cmd,args});
  if(cmd==='status'&&opened&&failAfterLaunch)throw new Error('downstream disconnected')
  if(cmd==='status')return {paused:++statuses===pauseAt,sessionState:'active',monitors,foreground:{hwnd:99}}
  if(cmd==='windows')return {monitors,windows:[{hwnd:1,pid:existingPid},...(opened?Array.from({length:count},(_,i)=>({hwnd:10+i,pid:42})):[])]}
  if(cmd==='shellOpen'){opened=true;return{ok:true,opened:true,pid}}
  if(cmd==='winInfo')return{visible:true,iconic:false,maximized:false,topLevel:true,pid:42,outerBounds:{x:0,y:0,width:800,height:600}}
  if(cmd==='bounds')return{ok:true,outerBounds:returnedBounds || args}
  throw Error('unexpected '+cmd)
 }}
}
let e=fixture();let r=await openOnMonitor(e,'C:\\fixture.txt','secondary',{wait:async()=>{}})
assert.equal(r.placementConfirmed,true);assert.equal(r.actualMonitor,'SIDE');assert.equal(e.calls.filter(x=>x.cmd==='shellOpen').length,1);assert.equal(e.calls.find(x=>x.cmd==='bounds').args.hwnd,10);assert.equal(e.calls.find(x=>x.cmd==='bounds').args.expectedPid,42)
for(const setup of [{pid:0},{existingPid:42},{count:2},{count:0}]) {
 e=fixture(setup);r=await openOnMonitor(e,'C:\\fixture.txt','secondary',{wait:async()=>{},polls:2});assert.equal(r.reason,'opened-but-placement-unconfirmed');assert.equal(e.calls.some(x=>x.cmd==='bounds'),false)
}
for(const pauseAt of [1,2,3]) {e=fixture({pauseAt});r=await openOnMonitor(e,'C:\\fixture.txt','secondary',{wait:async()=>{}});assert.equal(r.paused,true);assert.equal(e.calls.some(x=>x.cmd==='bounds'),false);if(pauseAt===1)assert.equal(e.calls.some(x=>x.cmd==='shellOpen'),false)}
e=fixture();r=await placeWindow(e,123,'secondary');assert.equal(r.wasMoved,true);assert.equal(e.calls.find(x=>x.cmd==='bounds').args.hwnd,123)
console.log('PASS: actual open/place orchestration; unique returned-PID new window only; shared/no-PID/multiple/no-window unconfirmed without move; pause pre/post launch/discovery blocks continuation; one launch only')

e=fixture({returnedBounds:{x:2400,y:0,width:2000,height:600}});r=await openOnMonitor(e,'C:\\fixture.txt','secondary',{wait:async()=>{}})
assert.equal(r.actualMonitor,'SIDE');assert.equal(r.placementConfirmed,false,'center on secondary must not confirm a window spanning primary');assert.equal(r.wasMoved,true)
e=fixture({returnedBounds:{x:0,y:0,width:800,height:600}});r=await placeWindow(e,123,'secondary');assert.equal(r.wasMoved,false,'SetWindowPos success is not actual motion')
e=fixture({failAfterLaunch:true});r=await openOnMonitor(e,'C:\\fixture.txt','secondary',{wait:async()=>{}});assert.equal(r.opened,true);assert.equal(r.launchAttempted,true);assert.equal(r.placementConfirmed,false);assert.equal(r.failedStage,'post-launch-status');assert.equal(e.calls.filter(x=>x.cmd==='shellOpen').length,1)
console.log('PASS: full actual outer-rect containment, actual movement comparison, and post-launch failure preserves opened=true/no retry')
e=fixture();const originalRequest=e.request;e.request=async(cmd,args)=>cmd==='shellOpen'?(e.calls.push({cmd,args}),{ok:true,opened:null,launchTicket:'owned-pending',launchState:'pending'}):originalRequest(cmd,args)
r=await openOnMonitor(e,'C:\\fixture.txt','secondary',{wait:async()=>{throw new Error('pending must not poll/block input queue')}})
assert.equal(r.launchState,'pending');assert.equal(r.opened,null);assert.equal(r.ok,true);assert.equal(e.calls.filter(x=>x.cmd==='shellOpen').length,1);assert(!e.calls.some(x=>x.cmd==='bounds'))
console.log('PASS async pending launch is one request, no automatic discovery/move/retry; caller retains lane for observe/dialog action')
