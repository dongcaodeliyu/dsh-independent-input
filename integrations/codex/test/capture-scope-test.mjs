import {fixtureControl} from './transport-fixture-control.mjs'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply} from '../index.js'
import {InputEngine} from '../lib/engine.js'
const dir=await mkdtemp(join(tmpdir(),'capture-scope-')),saved=InputEngine.prototype.request;let calls=[],tool,api,dispose
InputEngine.prototype.request=async function(cmd,args){calls.push(cmd);if(cmd==='status')return {foreground:{hwnd:1}};if(cmd==='winInfo')return {rect:{x:0,y:0,w:100,h:80}};if(cmd==='capture'){await writeFile(args.path,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7J8AAAAASUVORK5CYII=','base64'));return{ok:true,path:args.path,method:'wgc-window',mappingVerified:true,occlusionSafe:true,rect:{x:0,y:0,w:100,h:80}}}if(cmd==='observe')return{ok:true,observationId:'fresh',elements:[{elementId:'virtual',name:'Provider workflow',type:'ControlType.Button',nativeWindowHandle:0,enabled:true,offscreen:false,rect:{x:10,y:10,width:30,height:20}},{elementId:'native-button',type:'ControlType.Button',nativeWindowHandle:8,nativeClass:'Button',enabled:true,offscreen:false}]};if(cmd==='checkObservation')return{ok:true};return{ok:true}}
try{
 const settingsFile=join(dir,'settings.json');await writeFile(settingsFile,JSON.stringify({enabled:true}));dispose=await apply({tools:{register(v){tool=v;return()=>{}}},attachments:{saveImage:async()=>({type:'image',data:'fixture',mimeType:'image/png'})},effect:f=>f(),webServer:{register(v){if(v.path.endsWith('/api'))api=v.handler;return()=>{}}}}, {}, {controlLease:fixtureControl(),defineTool:v=>v,settingsFile,shotsDir:dir})
 calls=[];const c=await tool.execute({action:'capture'});assert(calls.includes('status'));assert(calls.includes('winInfo'));assert(calls.includes('capture'));assert.equal(c.images.length,1);assert.equal(c.meta.evidence.imageEvidence,'attached');assert.equal(c.meta.mappingVerified,true);assert.equal(c.meta.occlusionSafe,true);assert.equal(c.meta.evidence.screenshotContentFreshness,'unverified')
 calls=[];const o=await tool.execute({action:'observe',hwnd:1,includeScreenshot:true});assert.deepEqual(calls,['observe','winInfo','capture','checkObservation']);assert.equal(o.images.length,1);assert.equal(o.meta.evidence.imageEvidence,'attached');assert.equal(o.meta.evidence.screenshotContentFreshness,'unverified');assert.equal(o.meta.elements[0].offscreen,false);assert.deepEqual(o.meta.elements[1].backgroundActions,['click'])
 calls=[];const providerOnly=await tool.execute({action:'observe',hwnd:1});assert.deepEqual(calls,['observe']);assert.equal(providerOnly.images.length,0);assert.equal(providerOnly.meta.evidence.imageEvidence,'none');assert.equal(providerOnly.meta.evidence.uiaVisibility,'provider-reported');assert.equal(providerOnly.meta.elements.length,2)
 for(const [route,expected,commands] of [['hide',409,[]],['show',200,['begin','overlay']],['hide',200,['overlay','finish']]]){calls=[];let body;const res={setHeader(){},end(v){body=JSON.parse(v)}};await api({method:'POST',url:'/dsh-independent-input/api/'+route},res);assert.equal(res.statusCode,expected);assert.equal(body.ok,expected===200);assert.deepEqual(calls,commands)}
 const noAttachmentSettings=join(dir,'no-attachment.json');await writeFile(noAttachmentSettings,'{"enabled":true}');let noAttachmentTool
 const disposeSaved=await apply({tools:{register(value){noAttachmentTool=value;return()=>{}}}},{},{controlLease:fixtureControl(),defineTool:v=>v,settingsFile:noAttachmentSettings,shotsDir:dir})
 try{
  const savedOnly=await noAttachmentTool.execute({action:'observe',hwnd:1,includeScreenshot:true})
  assert.equal(savedOnly.images.length,0);assert.equal(savedOnly.meta.screenshot.attached,false)
  assert.equal(savedOnly.meta.evidence.imageEvidence,'saved-only');assert.equal(savedOnly.meta.evidence.screenshotContentFreshness,'unverified');assert.ok(savedOnly.meta.screenshot.path)
  assert.doesNotMatch(savedOnly.text,/read_image/)
  const captureSaved=await noAttachmentTool.execute({action:'capture',hwnd:1})
  assert.equal(captureSaved.meta.evidence.imageEvidence,'saved-only');assert.ok(captureSaved.meta.path);assert.doesNotMatch(captureSaved.text,/read_image/)
 }finally{disposeSaved()}
 console.log('PASS actual apply/tool capture + observe screenshot/checkObservation + registered API hide/show through fake engine; provider-only/attached/saved-only evidence; no sidecar/window/capture')
}finally{dispose?.();InputEngine.prototype.request=saved;await rm(dir,{recursive:true,force:true})}
