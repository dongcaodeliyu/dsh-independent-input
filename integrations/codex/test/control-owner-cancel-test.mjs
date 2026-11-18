// Actual stdio cancellation dispatcher + actual apply disposer with a thin engine
// recorder. No guardian, windows, desktop backend or global namespace.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import assert from 'node:assert/strict'
const dir=await mkdtemp(join(tmpdir(),'adapter-owner-cancel-')),log=join(dir,'interrupt.jsonl'),script=join(dir,'adapter.mjs');let code=await readFile('scripts/codex-mcp.mjs','utf8');code=code.replace(/^#![^\n]*\n/,'').replace(/from '(\.\.\/[^']+)'/g,(_,p)=>`from '${pathToFileURL(resolve('scripts',p)).href}'`)
code=`import {AsyncLocalStorage} from 'node:async_hooks'\nimport {appendFileSync} from 'node:fs'\nconst engineRecorder={context:new AsyncLocalStorage(),control:{owner:{executionId:'A'},executionId:c=>c?.threadId,manualPreviewContext:()=>({threadId:'preview'}),async disconnect(){},async release(){},async cancel(){}},interrupt(reason){appendFileSync(${JSON.stringify(log)},JSON.stringify({reason})+'\\n')},async stop(){}}\n`+code
code=code.replace('defineTool: value => value,','defineTool: value => value, engine:engineRecorder,')
code=code.replace('const actions =',`const originalExecute=tool.execute;tool.execute=async(args,ctx,options)=>{if(['observe','status'].includes(args.action)){await new Promise(r=>setTimeout(r,800));throw new Error('recorder read completed')}return originalExecute(args,ctx,options)};\nconst actions =`)
await writeFile(script,code);const p=spawn(process.execPath,[script],{env:{...process.env,CODEX_INPUT_DATA_DIR:dir},stdio:['pipe','pipe','inherit']});const answers=new Map();createInterface({input:p.stdout}).on('line',s=>{const a=JSON.parse(s);answers.get(a.id)?.(a)})
const send=value=>p.stdin.write(JSON.stringify(value)+'\n');const call=(id,action,threadId)=>send({jsonrpc:'2.0',id,method:'tools/call',params:{name:'independent_input',_meta:{threadId},arguments:{action,hwnd:1}}});const cancel=id=>send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}});const sleep=ms=>new Promise(r=>setTimeout(r,ms))
try{send({jsonrpc:'2.0',id:0,method:'ping'});await new Promise(r=>answers.set(0,r));call(1,'observe','B');await sleep(120);cancel(1);await sleep(1000);assert.equal(await readFile(log,'utf8').catch(()=>''),'');call(2,'status','A');await sleep(120);cancel(2);await sleep(1000);assert.deepEqual((await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),[{reason:'host-cancel'}]);console.log('PASS actual multi-source MCP dispatcher: foreign observe cancellation does not interrupt A; A status cancellation interrupts A despite fast lane; no desktop backend')}
finally{p.stdin.end();await new Promise(r=>p.once('exit',r));await rm(dir,{recursive:true,force:true})}
