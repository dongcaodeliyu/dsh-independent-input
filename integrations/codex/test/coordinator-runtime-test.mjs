import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {mkdir,writeFile,rm} from 'node:fs/promises'
import {createServer} from 'node:net'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {requireCoordinatorRuntime,dualConnection} from '../lib/dual-connection.js'
import {dualCall} from '../lib/dual-coordinator.js'
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url)))
assert.throws(()=>requireCoordinatorRuntime({}),e=>e.code==='coordinator-runtime-mismatch')
assert.throws(()=>requireCoordinatorRuntime({runtimeVersion:'old-fixture'}),e=>e.code==='coordinator-runtime-mismatch')
assert.doesNotThrow(()=>requireCoordinatorRuntime({runtimeVersion:version}))
const namespace='runtime-'+randomUUID(),endpoint=String.raw`\\.\pipe\dsh-dual-`+randomUUID();let reportedVersion
const server=createServer(socket=>{socket.setEncoding('utf8');socket.once('data',line=>{const q=JSON.parse(line);socket.end(JSON.stringify(q.op==='hello'?{ok:true,...(reportedVersion?{runtimeVersion:reportedVersion}:{})}:{ok:true,fixture:'readonly'})+'\n')})})
await new Promise(r=>server.listen(endpoint,r))
const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-Command',"@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;session=[Diagnostics.Process]::GetCurrentProcess().SessionId;local=[Environment]::GetFolderPath('LocalApplicationData')}|ConvertTo-Json -Compress"],{windowsHide:true})
const native=JSON.parse(stdout),directory=join(native.local,'dsh-independent-input-control','tests',namespace)
try{
 await mkdir(directory,{recursive:true});await writeFile(join(directory,`test-${namespace}-dsh-independent-input-${native.sid}-${native.session}.json`),JSON.stringify({protocolVersion:3,kind:'dual-lane-upgrade-gate',endpoint}))
 const connection=dualConnection({testNamespace:namespace})
 assert.equal((await dualCall(await connection({readonly:true}),{op:'status'})).fixture,'readonly')
 await assert.rejects(connection(),e=>e.code==='coordinator-runtime-mismatch')
 reportedVersion='old-fixture';await assert.rejects(connection(),e=>e.code==='coordinator-runtime-mismatch')
 reportedVersion=version;assert.equal(await connection(),endpoint)
 console.log('PASS actual default connection + isolated named-pipe/metadata seam: readonly observes old host; missing/different version rejects controlled reuse, matching version connects; no input backend/coordinator spawn')
}finally{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true})}
