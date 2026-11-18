import {fixtureControl} from './transport-fixture-control.mjs'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply} from '../index.js'
import {InputEngine} from '../lib/engine.js'
const dir=await mkdtemp(join(tmpdir(),'window-owner-')),original=InputEngine.prototype.request
const monitors=[{device:'MAIN',primary:true,bounds:{x:0,y:0,width:1920,height:1080},workArea:{x:0,y:0,width:1920,height:1040}},{device:'SIDE',primary:false,bounds:{x:1920,y:0,width:1920,height:1080},workArea:{x:1920,y:0,width:1920,height:1040}}]
let calls=[],opened=false,owner='existing',controlCount=0
InputEngine.prototype.request=async function(cmd,args,timeout,context){calls.push({cmd,args,context});
 if(cmd==='status')return{paused:false,sessionState:'active',monitors,foreground:{hwnd:99}}
 if(cmd==='windows')return{monitors,windows:[{hwnd:1,pid:7},...(opened?[{hwnd:10,pid:42}]:[])]}
 if(cmd==='winInfo')return{visible:true,iconic:false,maximized:false,topLevel:true,pid:42,outerBounds:{x:0,y:0,width:800,height:600}}
 if(cmd==='shellOpen'||cmd==='bounds'){owner=context?.caption||'会话未提供';controlCount++;if(cmd==='shellOpen'){opened=true;return{ok:true,opened:true,pid:42}}return{ok:true,outerBounds:args}}
 return {ok:true}
}
let dispose
try{
 const settingsFile=join(dir,'settings.json'),file=join(dir,'input.txt');await writeFile(settingsFile,JSON.stringify({enabled:true}));await writeFile(file,'fixture')
 let tool;dispose=await apply({tools:{register(v){tool=v;return()=>{}}}}, {}, {controlLease:fixtureControl(),defineTool:v=>v,settingsFile})
 await tool.execute({action:'status'},{caption:'B'});assert.equal(owner,'existing');assert.equal(controlCount,0)
 calls=[];const placed=await tool.execute({action:'place',hwnd:123},{caption:'A'});assert.equal(placed.meta.placementConfirmed,true);assert.equal(owner,'A');assert(calls.some(c=>c.cmd==='bounds'));assert(calls.every(c=>c.context?.caption==='A'))
 await tool.execute({action:'windows'},{caption:'B'});assert.equal(owner,'A')
 calls=[];const launched=await tool.execute({action:'open',path:file},{caption:'B'});assert.equal(launched.meta.placementConfirmed,true);assert.equal(owner,'B');assert(calls.some(c=>c.cmd==='shellOpen'));assert(calls.every(c=>c.context?.caption==='B'))
 console.log('PASS actual index -> real window-actions -> fake engine: place/open preserve per-request caption; internal readonly requests do not commit owner; no shell/native actions')
}finally{dispose?.();InputEngine.prototype.request=original;await rm(dir,{recursive:true,force:true})}
