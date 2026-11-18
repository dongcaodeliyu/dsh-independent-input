import {fixtureControl} from './transport-fixture-control.mjs'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {apply} from '../index.js'
import {InputEngine} from '../lib/engine.js'
const original=InputEngine.prototype.request
InputEngine.prototype.request=async()=>({ok:false,paused:true,reason:'paused-partial',partial:'possible'})
let tool
const dispose=await apply({tools:{register(v){tool=v;return()=>{}}}}, {}, {controlLease:fixtureControl(),defineTool:v=>v,settingsFile:fileURLToPath(new URL('./absent-result-settings.json',import.meta.url))})
try {
 const result=await tool.execute({action:'type',hwnd:1,text:'not-sent-by-test'})
 assert.match(result.text,/可能已部分完成/);assert.doesNotMatch(result.text,/动作没有执行/)
 const unknown=await tool.execute({action:'nonexistent'})
 assert.equal(unknown.meta.reason,'unknown-action')
 console.log('PASS: actual partial result formatter never claims zero effect; unknown action returns explicit error; fake engine only')
} finally {dispose();InputEngine.prototype.request=original}
