import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
const temp=await mkdtemp(join(tmpdir(),'input-cancel-test-'))
const original=await readFile(new URL('../scripts/codex-mcp.mjs',import.meta.url),'utf8')
const realIndex=new URL('../index.js',import.meta.url).href
const stub=join(temp,'stub.mjs'),script=join(temp,'mcp.mjs')
await writeFile(stub,`import {appendFileSync} from 'node:fs';import {apply as realApply} from ${JSON.stringify(realIndex)};
export async function apply(ctx,config,runtime){let release;const record=v=>appendFileSync(process.env.TEST_RECORD,JSON.stringify(v)+'\\n');const done=await realApply({...ctx,tools:{register(tool){return ctx.tools.register({...tool,async execute(args){record({execute:args.text});if(args.text==='block')return await new Promise(resolve=>{release=()=>resolve({text:'partial',meta:{ok:false,paused:true,partial:'possible'}})});return {text:'ok',meta:{ok:true}}}})}}},config,runtime);const dispose=()=>{record({dispose:true});release?.();done()};dispose.interrupt=reason=>{record({interrupt:reason});release?.()};return dispose}`)
await writeFile(script,original.replace("from '../lib/session-source.js'",`from ${JSON.stringify(new URL('../lib/session-source.js',import.meta.url).href)}`).replace("from '../index.js'",`from ${JSON.stringify(pathToFileURL(stub).href)}`))
function launch(label){const record=join(temp,label+'.jsonl');const p=spawn(process.execPath,[script],{env:{...process.env,TEST_RECORD:record},stdio:['pipe','pipe','pipe'],windowsHide:true});const replies=[];let errors='';p.stderr.on('data',d=>errors+=d);createInterface({input:p.stdout}).on('line',l=>replies.push(JSON.parse(l)));return {p,record,replies,send:v=>p.stdin.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n'),errors:()=>errors}}
async function until(predicate){for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,5))}throw Error('test deadline')}
async function events(t){try{return(await readFile(t.record,'utf8')).trim().split('\n').map(JSON.parse)}catch{return[]}}
const call=(id,text)=>({id,method:'tools/call',params:{name:'independent_input',arguments:{action:'type',hwnd:1,text}}})
try {
 const t=launch('cancel');t.send({id:'init',method:'initialize',params:{protocolVersion:'2025-11-25'}});await until(()=>t.replies.some(r=>r.id==='init'))
 t.send(call(0,'block'));t.send(call('queued','queued'));await until(async()=> (await events(t)).some(e=>e.execute==='block'))
 t.send({method:'notifications/cancelled',params:{requestId:'unknown'}})
 t.send({method:'notifications/cancelled',params:{requestId:'queued'}})
 assert.equal((await events(t)).filter(e=>e.interrupt).length,0)
 t.send({method:'notifications/cancelled',params:{requestId:0}})
 t.send({id:'barrier',method:'ping'});await until(()=>t.replies.some(r=>r.id==='barrier'))
 assert.equal((await events(t)).some(e=>e.execute==='queued'),false)
 assert.equal(t.replies.some(r=>r.id===0||r.id==='queued'),false,'MCP cancellation SHOULD suppress original request response')
 t.send(call('active-string','block'));await until(async()=> (await events(t)).filter(e=>e.execute==='block').length===2)
 t.send({method:'notifications/cancelled',params:{requestId:0}});await new Promise(r=>setTimeout(r,20))
 assert.equal((await events(t)).filter(e=>e.interrupt).length,1,'completed old cancel must not pause new request')
 t.send({method:'notifications/cancelled',params:{requestId:'active-string'}});t.send({id:'barrier2',method:'ping'});await until(()=>t.replies.some(r=>r.id==='barrier2'))
 assert.equal(t.replies.some(r=>r.id==='active-string'),false)
 t.p.stdin.end();await new Promise(r=>t.p.once('exit',r));assert.equal(t.p.exitCode,0,t.errors())
 const e=launch('eof');e.send(call(7,'block'));e.send(call(8,'queued'));await until(async()=> (await events(e)).some(v=>v.execute==='block'));e.p.stdin.end();await new Promise(r=>e.p.once('exit',r))
 assert.equal(e.p.exitCode,0,e.errors());assert.equal((await events(e)).some(v=>v.dispose),true);assert.equal((await events(e)).some(v=>v.execute==='queued'),false);assert.equal(e.replies.length,0)
 console.log('PASS: actual MCP queue active/queued cancel, id0/string, unknown/completed cancel isolation, no notification or cancelled-original response, EOF immediate dispose/no queued action; fake executor, no sidecar')
} finally {await rm(temp,{recursive:true,force:true})}
