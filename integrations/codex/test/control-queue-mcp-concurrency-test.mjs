import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const temporary=await mkdtemp(join(tmpdir(),'queue-mcp-'))
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import assert from 'node:assert/strict'
import {ControlLease} from '../lib/control-lease.js'
const ns='mcp-queue-'+Date.now(),lease=new ControlLease({testNamespace:ns}),A={threadId:'owner-A'};await lease.acquire(A,'begin')
let code=await readFile('scripts/codex-mcp.mjs','utf8');code=code.replace(/from '(\.\.\/[^']+)'/g,(_,p)=>`from '${pathToFileURL(resolve('scripts',p)).href}'`);code=`import {ControlLease} from '${pathToFileURL(resolve('lib/control-lease.js')).href}'\n`+code.replace(/^#![^\n]*\n/,'');code=code.replace('defineTool: value => value,','defineTool: value => value, controlLease:new ControlLease({testNamespace:'+JSON.stringify(ns)+'}),');await writeFile(join(temporary,'isolated-adapter.mjs'),code)
const child=spawn(process.execPath,[join(temporary,'isolated-adapter.mjs')],{env:{...process.env,CODEX_INPUT_DATA_DIR:join(temporary,'data')},stdio:['pipe','pipe','inherit']});let seq=0;const pending=new Map();createInterface({input:child.stdout}).on('line',s=>{const r=JSON.parse(s);pending.get(r.id)?.(r);pending.delete(r.id)})
function send(action,threadId='waiting-B'){const id=++seq;const promise=new Promise(resolve=>pending.set(id,resolve));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'independent_input',_meta:threadId===null?null:{threadId},arguments:{action,waitMs:45000}}})+'\n');return {id,promise}}
const overallDeadline=Date.now()+120000
async function bounded(promise){const remaining=Math.min(30000,overallDeadline-Date.now());assert.ok(remaining>0,'overall protocol deadline');let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('protocol condition deadline')),remaining))])}finally{clearTimeout(timer)}}
async function until(predicate,label){const started=Date.now();await bounded((async()=>{while(!await predicate()){await new Promise(r=>setTimeout(r,100))}})());console.log('Observed protocol condition:',label,Date.now()-started,'ms')}
const meta=r=>JSON.parse(r.result.content.at(-1).text)
const cancelNotification=id=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}})+'\n')
try{
 const missing=await bounded(send('control_request',null).promise);assert.ok(missing.result.isError);assert.ok((await bounded(send('status').promise)).result)
 const abandoned=send('control_request');cancelNotification(abandoned.id)
 await until(async()=>{const s=await lease.status('owner-A');assert.equal(s.ownerExecutionId,'owner-A');assert.equal(s.pauseReason,null);return s.queue.length===0},'cancelled request ticket absent')
 // Start a subsequent queue lifecycle. Assertions below check that the wait
 // remains pending during status and that no ticket remains at completion.
 const request=await bounded(send('control_request').promise);assert.equal(meta(request).control.position,1)
 const wait=send('control_wait');let settled=false;wait.promise.then(()=>settled=true)
 await until(async()=> (await lease.status('owner-A')).queue.length===1,'wait ticket registered')
 const remind=await bounded(send('control_request','owner-A').promise);assert.ok(JSON.stringify(remind).includes('controlReminder'))
 const again=await bounded(send('control_request','owner-A').promise);assert.ok(!JSON.stringify(again).includes('controlReminder'))
 const status=await bounded(send('status').promise);assert.ok(JSON.stringify(status).includes('owner-A'));assert.equal(settled,false,'status must return while original 45s wait is still pending')
 const cancelled=await bounded(send('control_cancel').promise);assert.ok(!cancelled.result.isError)
 const waitResult=meta(await bounded(wait.promise));assert.equal(waitResult.control.waitResult,'cancelled','cancel must wake the original wait, not wait for its timeout')
 const notifiedWait=send('control_wait');await until(async()=> (await lease.status('owner-A')).queue.length===1,'second wait registered');cancelNotification(notifiedWait.id)
 await until(async()=> (await lease.status('owner-A')).queue.length===0,'notification-cancelled wait ticket removed')
 const current=await lease.status('owner-A');assert.equal(current.ownerExecutionId,'owner-A');assert.equal(current.pauseReason,null);assert.equal(current.queue.length,0)
 console.log('GREEN actual MCP: null metadata safe; cancelled request settles before cleanup; status returns during pending wait; cancel wakes wait; notification cancellation removes own ticket without pausing holder; one owner reminder')
}finally{child.stdin.end();await lease.release('owner-A');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await rm(temporary,{recursive:true,force:true})}
