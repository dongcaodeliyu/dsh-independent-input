import {mkdtemp,access,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import {apply} from '../index.js'
let tool,fail=false,denyCapture=false;const secret='fixture-credential-123',url=`https://qa.test/auth/login?key=${secret}`
await apply({tools:{register(t){tool=t}},logger:{info(){}}},{enabled:true},{defineTool:t=>t,engine:{request:async()=>{if(denyCapture)return {ok:false,reason:"authentication-url-screenshot-suppressed"};if(fail)throw Object.assign(new Error(`stopped ${url} https://shop.test/products?key=sku`),{code:'user-stopped'});return {ok:true,windows:[{hwnd:1,title:url}],foreground:{title:url}}}}})
const result=await tool.execute({action:'windows'})
assert(!JSON.stringify(result).includes(secret),'upstream public windows result leaks authentication URL secret')
console.log('PASS upstream real registered tool result auth URL redacted')

fail=true;const rejected=await tool.execute({action:'windows'});assert.equal(rejected.meta.ok,false);assert(!JSON.stringify(rejected).includes(secret));assert(rejected.text.includes('https://shop.test/products?key=sku'));
await assert.rejects(tool.execute({get action(){throw Object.freeze(Object.assign(new Error(url),{code:'user-stopped'}))}}),e=>e.code==='user-stopped'&&!e.message.includes(secret));
console.log('PASS upstream supported failure and outer frozen throw preserve rejection and ordinary URL')

const temp=await mkdtemp(join(tmpdir(),'upstream-auth-path-'));denyCapture=true;const path=join(temp,'absent-parent','fixture.png')
try{const denied=await tool.execute({action:'capture',rect:'full',path});assert.equal(denied.meta.ok,false);assert.equal(denied.meta.path,undefined);await assert.rejects(access(join(temp,'absent-parent')));console.log('PASS upstream actual capture rejection creates no parent/PNG and returns no path')}finally{await rm(temp,{recursive:true,force:true})}
