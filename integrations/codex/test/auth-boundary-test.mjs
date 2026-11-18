import assert from 'node:assert/strict'
import {AsyncLocalStorage} from 'node:async_hooks'
import {apply} from '../index.js'
const secret='fixture-rejection-secret',auth=`https://qa.test/auth/login?key=${secret}`,plain='https://shop.test/products?key=sku'
let tool;let mode='queue';let seen
const error=()=>Object.assign(new Error(`stop ${auth} ${plain}`),{code:'user-stopped',control:{reason:'user-stopped',ownerName:auth,paused:true}})
const engine={context:{run(context,fn){seen=context;if(mode==='outer')throw error();return fn()}},control:{manualPreviewContext(){return{}},executionId(){return'fixture'},async request(){throw error()},async acquire(){throw error()},async status(){return{} }},async request(){throw error()}}
await apply({tools:{register(t){tool=t}},logger:{info(){}}},{enabled:true},{defineTool:t=>t,engine,settingsFile:new URL('./absent-settings.json',import.meta.url).pathname})
for(const action of ['control_request','begin','observe']){
 const args={action,hwnd:1},original=JSON.stringify(args),r=await tool.execute(args,{})
 assert(!JSON.stringify(r).includes(secret),`${action} leaked authentication URL`)
 assert.equal(r.meta.ok,false);assert.equal(r.meta.reason,'user-stopped');assert(r.text.includes(plain));assert.equal(JSON.stringify(args),original)
}
mode='outer';await assert.rejects(tool.execute({action:'observe',hwnd:1},{}),e=>e.code==='user-stopped'&&!e.message.includes(secret)&&e.message.includes(plain))
console.log('PASS registered tool queue/acquire/execute/outer throw privacy; denial code and ordinary URL preserved')
