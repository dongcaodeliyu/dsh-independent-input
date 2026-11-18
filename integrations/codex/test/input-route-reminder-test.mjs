import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const entry=fileURLToPath(new URL('../scripts/input-route-reminder.mjs',import.meta.url))
function run(input){
 const result=spawnSync(process.execPath,[entry],{input,encoding:'utf8',timeout:5000,windowsHide:true})
 assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'')
 assert.equal(result.stdout.trim().split('\n').length,1)
 return JSON.parse(result.stdout)
}
const prompts=['打开Windows测试窗口','独立输入','使用多鼠标，不要抢我鼠标','现在只问状态，不操作','“删除文件”只是引用','这次明确使用官方CUA','请用浏览器连接器查网页']
for(const prompt of prompts){
 const result=run(JSON.stringify({hook_event_name:'UserPromptSubmit',prompt}))
 const text=result.hookSpecificOutput.additionalContext
 assert.match(text,/若本轮确需已获用户授权/);assert.match(text,/不授予输入权限/)
 assert.match(text,/用户后续明确改选/);assert.match(text,/不静默回退原生/)
 assert.match(text,/不热加载工具/);assert.match(text,/专门连接器/);assert.ok(text.length<1000)
}
assert.deepEqual(run('{invalid'),{})
assert.deepEqual(run(JSON.stringify({hook_event_name:'PreToolUse',prompt:'点击'})),{})
assert.deepEqual(run(JSON.stringify({hook_event_name:'UserPromptSubmit',transcript:[{prompt:'点击'}]})),{})
console.log('PASS: conditional Windows default reminder; no intent classifier/authority inference; latest user choice/connectors/stop; real JSON command')
