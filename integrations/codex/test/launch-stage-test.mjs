import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {fileURLToPath} from 'node:url'
import {acceptLaunchStage} from '../lib/launch-tickets.js'
const fresh=()=>({proc:{pid:123},helper:{pid:123,birth:null},trace:[]})
const event={stage:'received',helperPid:123,helperBirth:'456',utc:'2026-11-18T00:00:00Z',ticks:1,frequency:10000000,threadId:7,apartment:'STA',path:'MUST-NOT-RECORD'}
for(const invalid of [{helperPid:124},{helperBirth:'unknown'},{stage:'native-return'}]){const t=fresh();assert.throws(()=>acceptLaunchStage(t,{...event,...invalid}));assert.equal(t.trace.length,0);assert.equal(t.helper.birth,null)}
const t=fresh();acceptLaunchStage(t,event);assert(!JSON.stringify(t).includes('MUST-NOT-RECORD'));assert.throws(()=>acceptLaunchStage(t,{...event,stage:'native-enter',helperBirth:'999'}));assert.equal(t.trace.length,1)
acceptLaunchStage(t,{...event,stage:'native-enter'});acceptLaunchStage(t,{...event,stage:'native-return',data:{accepted:true,applicationPid:789,applicationBirth:'999',private:'MUST-NOT-RECORD'}});assert.equal(t.state,'accepted');assert(!JSON.stringify(t).includes('MUST-NOT-RECORD'))
// The real fixed WinApp is created with inherited OS pipes, then EOF before a
// request. No ShellExecute or UI/input occurs in this check.
const proc=spawn(fileURLToPath(new URL('../native/bin/launch-helper.exe',import.meta.url)),[],{detached:true,windowsHide:true,stdio:['pipe','pipe','ignore']})
let output='';proc.stdout.on('data',s=>output+=s)
const timer=setTimeout(()=>{proc.kill();throw new Error('own helper EOF did not exit')},3000)
proc.stdin.end();const [code]=await once(proc,'close');clearTimeout(timer);assert.equal(code,5);assert.equal(output,'')
console.log('PASS bound-child stage identity/order, metadata projection, and actual fixed WinApp EOF before request; zero launch/input')
