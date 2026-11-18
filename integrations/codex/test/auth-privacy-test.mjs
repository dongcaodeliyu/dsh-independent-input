import {mkdtemp,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {AsyncLocalStorage} from 'node:async_hooks'
import {apply} from '../index.js'
import {presentObservation} from '../lib/presentation.js'
import {redactAuthUrls} from '../lib/auth-privacy.js'
const secret='fixture-credential-123', auth=`https://qa.example.test/auth/login?key=${secret}&lang=zh`, ordinary='https://shop.example.test/products?key=sku&code=item'
let tool, response, calls=[]
await apply({tools:{register(t){tool=t}},logger:{info(){}}},{enabled:true},{defineTool:t=>t,settingsFile:new URL('./nonexistent-privacy-settings.json',import.meta.url).pathname,engine:{context:new AsyncLocalStorage(),control:{manualPreviewContext(){return{}},executionId(){return'fixture'}},request:async cmd=>{calls.push(cmd);if(cmd!=='observe')throw Error('capture must never run for sensitive fixture');return response}}})
for(const details of [false,true]) for(const includeScreenshot of [false,true]) {
 response={ok:true,observationId:'fresh',window:{title:auth},nested:{providerMessage:auth},elements:[{elementId:'e1',parentId:'e0',type:'ControlType.Hyperlink',name:auth,value:auth,extra:{url:auth},rect:{x:1,y:2,width:3,height:4},enabled:true,offscreen:false}]}
 const original=JSON.stringify(response);calls=[]
 const out=await tool.execute({action:'observe',hwnd:1,details,includeScreenshot},{})
 assert(!JSON.stringify(out).includes(secret)); assert.equal(JSON.stringify(response),original)
 assert.equal(out.meta.elements[0].elementId,'e1');assert.deepEqual(out.meta.elements[0].rect,response.elements[0].rect)
 assert.deepEqual(calls,['observe']);if(includeScreenshot)assert.equal(out.meta.screenshotSuppressed,'authentication-url')
 assert(!JSON.stringify(presentObservation(response,{details})).includes(secret))
}
response={ok:false,error:`provider failed ${auth}`,nested:{url:auth}};assert(!JSON.stringify(await tool.execute({action:'observe',hwnd:1},{})).includes(secret))
response={ok:true,observationId:'plain',window:{title:'Shop'},elements:[{elementId:'e1',name:ordinary,value:'business code key token',rect:{x:1},enabled:true}]}
const normal=await tool.execute({action:'observe',hwnd:1,details:true},{});assert.equal(normal.meta.elements[0].name,ordinary);assert.equal(normal.meta.elements[0].value,'business code key token')
for(const url of [`https://qa.test/oauth/callback#code=${secret}`,`https://qa.test/?access_token=${secret}`,`https://qa.test/login?%6bey=${secret}`])assert(!redactAuthUrls(url).includes(secret))
console.log('PASS actual registered tool result: compact/details, nested/error bypass, no capture before suppression; internal signatures and ordinary URLs/IDs/geometry preserved')

const unicode='普通中文😀 https://shop.test/items?key=sku&code=item';assert.equal(redactAuthUrls(unicode),unicode);assert(!redactAuthUrls('登录 http://qa.test/auth/login?key='+secret+'&label=中文😀').includes(secret));console.log('PASS Unicode/non-auth business URL remains exact; HTTP authentication URL redacted')

const temp=await mkdtemp(join(tmpdir(),'auth-capture-path-')),path=join(temp,'not-created','fixture.png');let captureTool
await apply({tools:{register(t){captureTool=t}},logger:{info(){}}},{enabled:true},{defineTool:t=>t,settingsFile:join(temp,'absent.json'),engine:{context:new AsyncLocalStorage(),control:{manualPreviewContext(){return{}},executionId(){return'fixture'}},request:async cmd=>cmd==='winInfo'?{rect:{x:0,y:0,w:100,h:100}}:{ok:false,reason:'authentication-url-screenshot-suppressed'}}})
try{const denied=await captureTool.execute({action:'capture',hwnd:1,path},{});assert.equal(denied.meta.ok,false);assert.equal(denied.meta.path,undefined);await assert.rejects(access(join(temp,'not-created')));console.log('PASS actual public capture rejection creates no parent directory/PNG and returns no path')}finally{await rm(temp,{recursive:true,force:true})}
