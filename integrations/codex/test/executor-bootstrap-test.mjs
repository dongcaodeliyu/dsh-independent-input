// Real PowerShell early sidecar path; never sends a permit to real sidecar.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {fileURLToPath} from 'node:url'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const sidecar=fileURLToPath(new URL('../sidecar.ps1',import.meta.url)),bootstrap=fileURLToPath(new URL('../lib/executor-bootstrap.ps1',import.meta.url))
async function start(file){const proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',file],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DSH_INPUT_STARTUP_PERMIT:'owned-test-permit'}});let output='',errors='';proc.stdout.on('data',s=>output+=s);proc.stderr.on('data',s=>errors+=s);const deadline=Date.now()+10000;while(!output.includes('bootstrap-waiting')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.match(output,/bootstrap-waiting/);return {proc,output:()=>output,errors:()=>errors}}
const temp=await mkdtemp(join(tmpdir(),'dual-bootstrap-'))
try{
 for(const message of [null,{cmd:'__launch',permit:'wrong'}]){
  const child=await start(sidecar);assert.equal(child.output().trim(),'{"event":"bootstrap-waiting"}')
  const done=once(child.proc,'close');if(message)child.proc.stdin.write(JSON.stringify(message)+'\n');child.proc.stdin.end();const [code]=await done;assert.equal(code,73);assert.equal(child.errors(),'');assert.doesNotMatch(child.output(),/"ready"|pause-state/)
 }
 // Positive permit uses a trivial continuation, never the real hook/UI body.
 const fixture=join(temp,'continuation.ps1');await writeFile(fixture,`. '${bootstrap.replaceAll("'","''")}'\nWait-ExecutorPermit\n[Console]::WriteLine('owned-continuation')\n`)
 const child=await start(fixture),done=once(child.proc,'close');child.proc.stdin.end('{"cmd":"__launch","permit":"owned-test-permit"}\n');assert.equal((await done)[0],0);assert.match(child.output(),/owned-continuation/)
 console.log('PASS real early sidecar barrier: no permit/EOF or wrong permit exits before backend ready; only exact permit enters owned non-UI continuation. No real hook/UI/input initialized.')
}finally{await rm(temp,{recursive:true,force:true})}
