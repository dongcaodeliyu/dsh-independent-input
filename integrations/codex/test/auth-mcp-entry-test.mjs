// Starts the actual manifest-selected MCP entry; no backend/control/desktop calls.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)),'..')
const manifest=JSON.parse(await readFile(join(root,'.mcp.json'),'utf8'))
const spec=manifest.mcpServers['independent-input'];assert.equal(spec.command,'node')
const temp=await mkdtemp(join(tmpdir(),'auth-mcp-entry-'))
const proc=spawn(process.execPath,spec.args,{cwd:root,env:{...process.env,CODEX_INPUT_DATA_DIR:temp,CODEX_HOME:temp,CODEX_INPUT_ENABLED:'0'},stdio:['pipe','pipe','pipe'],windowsHide:true})
const exit=new Promise(resolve=>proc.once('exit',(code,signal)=>resolve({code,signal})))
let stderr='',id=0;proc.stderr.on('data',c=>stderr+=c)
const pending=new Map(),lines=createInterface({input:proc.stdout})
lines.on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id)})
async function call(method,params){return await new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>reject(Error(`entry timeout ${stderr}`)),10000);pending.set(n,r=>{clearTimeout(t);resolve(r)});proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')})}
try{
 const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'privacy-entry-fixture',version:'1'}});assert.equal(init.result.protocolVersion,'2024-11-05')
 const list=await call('tools/list',{});assert.equal(list.result.tools[0].name,'independent_input')
 const secret='fixture-jsonrpc-secret',url=`https://qa.test/auth/login?key=${secret}`
 const rejected=await call('tools/call',{name:'independent_input',arguments:{action:'status',[url]:1}})
 assert.equal(rejected.result.isError,true);assert(!JSON.stringify(rejected).includes(secret));assert(JSON.stringify(rejected).includes('[REDACTED]'))
 const ordinary='https://shop.test/product?key=sku';const plain=await call('tools/call',{name:'independent_input',arguments:{action:'status',[ordinary]:1}});assert.equal(plain.result.isError,true);assert(JSON.stringify(plain).includes(ordinary))
 console.log('PASS actual .mcp.json entry initialize/tools-list + JSONRPC auth validation exception redaction; ordinary URL/error preserved; disabled isolated state, no backend/control calls')
}finally{proc.stdin.end();let timer;try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('entry did not exit on stdin EOF')),10000)})])}finally{clearTimeout(timer)};lines.close();await rm(temp,{recursive:true,force:true})}
