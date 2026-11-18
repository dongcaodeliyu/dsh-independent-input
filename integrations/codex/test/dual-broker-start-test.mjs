// Actual detached coordinator and real PowerShell bootstrap/C# fixture.
// No hooks, Forms or app input. Only owned isolated host PIDs are terminated.
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {dualConnection} from '../lib/dual-connection.js'
import {DualControlLease} from '../lib/dual-control-lease.js'
for(const phase of ['before-bind','after-bind']){
 const connection=dualConnection({testNamespace:'bs-'+randomUUID(),headlessTest:true}),lease=new DualControlLease({connection});let proc,descriptor
 try{
  await lease.acquire({threadId:'OWNED'},'begin');descriptor=connection.local()
  proc=await lease.spawnExecutor(lease.executorEnvironment());let output='';proc.stdout.setEncoding('utf8');proc.stdout.on('data',chunk=>output+=chunk)
  const waiting=Date.now()+5000;while(!output.includes('bootstrap-waiting')&&Date.now()<waiting)await new Promise(r=>setTimeout(r,10));assert.match(output,/bootstrap-waiting/);assert.doesNotMatch(output,/"event":"ready"/)
  if(phase==='after-bind'){await lease.bind(proc.pid);proc.stdin.write(JSON.stringify({cmd:'__launch',permit:lease.startupPermit})+'\n');const deadline=Date.now()+10000;while(!output.includes('"event":"ready"')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.match(output,/"event":"ready"/)}
  const closed=once(proc,'close');process.kill(descriptor.gate.coordinator.pid)
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('owned executor survived coordinator loss')),5000))])
 }finally{if(proc&&proc.exitCode===null&&proc.signalCode===null)proc.kill();if(descriptor)await rm(dirname(descriptor.metadata),{recursive:true,force:true})}
}
console.log('PASS real PS broker startup: no initialization before Job/permit; coordinator death before bind and after bind+permit closes owned executor. No physical hook/UI/input acceptance.')
