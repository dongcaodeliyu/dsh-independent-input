import {fixtureControl} from './transport-fixture-control.mjs'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply} from '../index.js'
import {InputEngine} from '../lib/engine.js'
const dir=await mkdtemp(join(tmpdir(),'overlay-batch-')),methods=['request','setCursorMode','setCursorSize','setCursorState'],saved=Object.fromEntries(methods.map(k=>[k,InputEngine.prototype[k]])),engines=new Set();let calls=[],tool,dispose,failOverlay=false
InputEngine.prototype.request=async function(cmd,args,timeout,context){engines.add(this);calls.push({cmd,args,context});return {ok:!(failOverlay&&cmd==='overlay'),visible:!(failOverlay&&cmd==='overlay'),...(failOverlay&&cmd==='overlay'?{reason:'overlay-position-failed'}:{}),cursorSize:this.cursorSize,cursorState:this.cursorState}}
for(const key of methods.slice(1))InputEngine.prototype[key]=async function(...args){engines.add(this);this.ready=true;this.proc={exitCode:null};return saved[key].call(this,...args)}
try{
 const settingsFile=join(dir,'settings.json');await writeFile(settingsFile,JSON.stringify({enabled:true}));dispose=await apply({tools:{register(v){tool=v;return()=>{}}}}, {}, {controlLease:fixtureControl(),defineTool:v=>v,settingsFile})
 for(const state of ['text','link']){calls=[];await tool.execute({action:'overlay',show:true,x:400,y:300,cursorSize:40,cursorState:state},{caption:'A'});assert.equal(calls.length,1,'same showing request must not separately layout old anchor');assert.equal(calls[0].cmd,'overlay');assert.equal(calls[0].args.cursorState,state);assert.equal(calls[0].args.cursorSize,40);assert.equal(calls[0].context.caption,'A')}
 calls=[];await tool.execute({action:'overlay',cursorState:'text'});assert.deepEqual(calls.map(c=>c.cmd),['setCursorStyle'],'configuration alone must not show')
 failOverlay=true;calls=[];const failure=await tool.execute({action:'overlay',show:true,x:400,y:300,cursorSize:40,cursorMode:'clean',cursorState:'link'});assert.equal(failure.meta.ok,false);assert.equal(failure.meta.visible,false);assert.match(failure.text,/失败/);assert.equal(calls.length,1)
 console.log('PASS actual index+actual engine setters/fake transport: same show state/size/target one request, text/link preserved, config-only no show')
}finally{for(const e of engines){e.proc=null;e.ready=false}dispose?.();for(const k of methods)InputEngine.prototype[k]=saved[k];await rm(dir,{recursive:true,force:true})}
