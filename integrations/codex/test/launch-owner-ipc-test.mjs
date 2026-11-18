// Real isolated coordinator + fixed WinApp; only a no-window owned process.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {startDualCoordinator,dualCall} from '../lib/dual-coordinator.js'
const dir=await mkdtemp(join(tmpdir(),'launch-owned-')),marker=join(dir,'pid.txt'),exe=join(dir,'Owned.exe'),namespace='launch-'+randomUUID(),exec=promisify(execFile)
await writeFile(join(dir,'Owned.cs'),'using System;using System.IO;using System.Diagnostics;using System.Threading;class Own {static void Main(){var p=Process.GetCurrentProcess();File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"pid.txt"),p.Id+"|"+p.StartTime.ToUniversalTime().Ticks);Thread.Sleep(30000);}}')
await exec(join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:winexe','/out:'+exe,join(dir,'Owned.cs')],{windowsHide:true})
const coordinator=await startDualCoordinator({testNamespace:namespace,onMembers:async()=>{}}),identity=id=>({executionId:id,actorPid:process.pid}),call=(id,op,args={})=>dualCall(coordinator.endpoint,{op,identity:identity(id),...args})
let app
try{
 const a=await call('A','acquire'),b=await call('B','acquire');assert(a.ok&&b.ok)
 const ticket=await call('A','launch-start',{leaseId:a.lane.leaseId,launch:{path:exe,x:0,y:0}});assert.equal(ticket.launchState,'pending')
 assert.equal((await call('A','status')).occupied,2)
 assert.equal((await call('B','launch-status',{leaseId:b.lane.leaseId,launchTicket:ticket.launchTicket})).reason,'launch-ticket-not-owned')
 assert.equal((await call('A','launch-status',{leaseId:'wrong',launchTicket:ticket.launchTicket})).reason,'launch-lease-mismatch')
 let result;const deadline=Date.now()+10000
 do{result=await call('A','launch-status',{leaseId:a.lane.leaseId,launchTicket:ticket.launchTicket,details:true});if(result.launchState!=='pending')break;await new Promise(r=>setTimeout(r,30))}while(Date.now()<deadline)
 assert.equal(result.launchState,'accepted');assert.equal(result.result.accepted,true);assert.equal(result.trace.length,3);assert(!JSON.stringify(result).includes(exe));
 while(Date.now()<deadline){try{const [pid,birth]=(await readFile(marker,'utf8')).split('|');if(Number(pid)>0&&/^\d+$/.test(birth)){app={pid:Number(pid),birth};break}}catch{}await new Promise(r=>setTimeout(r,20))}assert(app);assert.equal(result.result.applicationPid,app.pid)
 for(const [id,lane] of [['A',a.lane],['B',b.lane]]){assert((await call(id,'prepare-finish',{leaseId:lane.leaseId})).ok);assert((await call(id,'finish',{leaseId:lane.leaseId})).ok)}
 await coordinator.close()
 const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',`$p=[Diagnostics.Process]::GetProcessById(${app.pid});$p.StartTime.ToUniversalTime().Ticks.ToString()`],{windowsHide:true});assert.equal(stdout.trim(),app.birth)
 console.log('PASS real isolated launch ticket IPC: same exec/lease only; metadata status while pending; one fixed helper accepted own no-UI app; finish/coordinator close leaves app alive; no private path in stages')
}catch(error){console.error('TEST_CONTRACT',error);throw error}finally{
 if(!app){try{const [pid,birth]=(await readFile(marker,'utf8')).split('|');if(Number(pid)>0&&/^\d+$/.test(birth))app={pid:Number(pid),birth}}catch{}}
 if(app){await exec('powershell.exe',['-NoProfile','-Command',`try{$p=[Diagnostics.Process]::GetProcessById(${app.pid});if($p.StartTime.ToUniversalTime().Ticks.ToString()-eq'${app.birth}'){$p.Kill();$p.WaitForExit()}}catch [ArgumentException]{}`],{windowsHide:true})}
 await coordinator.abortForTest().catch(()=>{});await rm(dirname(coordinator.statePath),{recursive:true,force:true});await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100})
}
