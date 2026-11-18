import {ControlLease} from '../lib/control-lease.js'
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
const ns='queue-boundary-'+Date.now(), a=new ControlLease({testNamespace:ns}),b=new ControlLease({testNamespace:ns}), c=new ControlLease({testNamespace:ns});const A={threadId:'A'},B={threadId:'B'},C={threadId:'C'};let checks=0
function ok(v){assert.ok(v);checks++}
try{
await a.acquire(A,'begin');const t1=await b.wait(B,{waitMs:0});const t2=await b.wait(B,{waitMs:0});ok(t1.waitResult==='timeout'&&t2.queue[0].sequence===t1.queue[0].sequence);await b.disconnect();ok((await a.status('A')).queue.length===0);await b.request(B)
const requestAbort=new AbortController();const cancelledRequest=b.request(B,{signal:requestAbort.signal});setTimeout(()=>requestAbort.abort(),50);await assert.rejects(cancelledRequest);ok((await a.status('A')).queue.length===0);await b.request(B)
const abort=new AbortController();const waiting=b.wait(B,{signal:abort.signal,waitMs:10000});await new Promise(r=>setTimeout(r,900));const before=Date.now();await c.status('C');ok(Date.now()-before<5000);abort.abort();await assert.rejects(waiting);ok((await a.status('A')).queue.length===0);ok(a.owner.executionId==='A'&&!a.owner.pauseReason)
await b.request(B);await a.pause('escape',{reason:'escape',source:'keyboard-hook',utcTimestamp:'2026-11-16T00:00:00Z'});await assert.rejects(a.release('A'));ok((await b.wait(B,{waitMs:0})).turn==='queued');await assert.rejects(b.acquire(B,'begin'));ok((await b.status('B')).pauseReason==='escape');await a.resume();await a.release('A');await b.cancel(B)
// Only scratch namespace metadata is edited: expiry/dead/reused PID and unknown evidence.
await b.request(B);const dir=join(process.env.LOCALAPPDATA,'dsh-independent-input-control','tests',ns);const {readdir}=await import('node:fs/promises');const file=join(dir,(await readdir(dir)).find(n=>n.endsWith('.queue.json')))
let q=JSON.parse(await readFile(file,'utf8'));q.tickets[0].expiresUtc='2000-01-01T00:00:00Z';await writeFile(file,JSON.stringify(q));ok((await c.request(C)).position===1);await c.cancel(C)
await b.request(B);q=JSON.parse(await readFile(file,'utf8'));q.tickets[0].actor.birth='1';await writeFile(file,JSON.stringify(q));ok((await c.request(C)).position===1);await c.cancel(C)
await b.request(B);q=JSON.parse(await readFile(file,'utf8'));q.tickets[0].actor={pid:process.pid};await writeFile(file,JSON.stringify(q));ok((await c.request(C)).position===2);await b.cancel(B);await c.cancel(C)
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await b.operation('request',B,{actorPid:child.pid});child.kill();await once(child,'exit');ok((await c.request(C)).position===1);await c.cancel(C)
console.log(JSON.stringify({ns,checks,result:'GREEN',scope:'actual isolated guard/queue protocol; no desktop backend'}))
}finally{if(a.owner){await a.resume();await a.release('A')}await b.cancel(B);await c.cancel(C)}
