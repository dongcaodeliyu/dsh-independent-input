import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'
import {createInterface} from 'node:readline'
const namespace='queue-'+Date.now();let seq=0;const actors=[]
function actor(name){const p=spawn(process.execPath,['test/control-queue-actor.mjs',namespace,name],{stdio:['pipe','pipe','inherit']});const pending=new Map();createInterface({input:p.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id)});const a={p,call(op,args={}){return new Promise(resolve=>{const id=++seq;pending.set(id,resolve);p.stdin.write(JSON.stringify({id,op,...args})+'\n')})}};actors.push(a);return a}
const A=actor('A'),B=actor('B'),C=actor('C');let count=0;function ok(value){assert.ok(value);count++}
try{
ok(!(await A.call('acquire')).error)
const first=await B.call('request');ok(first.result.position===1);ok((await B.call('request')).result.queue.length===1)
ok((await C.call('request')).result.position===2)
const notice=(await A.call('claim')).result;ok(notice?.leaseId);ok((await A.call('claim')).result===null)
await B.call('cancel');await C.call('cancel');await B.call('request');ok((await A.call('claim')).result===null)
await C.call('request');await A.call('release');ok((await C.call('acquire')).error==='control-busy')
const ready=await B.call('wait',{waitMs:500});ok(ready.result.waitResult==='ready');ok(!(await B.call('acquire')).error)
ok((await B.call('status')).result.ownerProjectName==='项目“测试”😀');ok((await B.call('claim')).result.leaseId!==notice.leaseId);ok((await B.call('claim')).result===null)
const waiting=C.call('wait',{waitMs:12000});ok((await C.call('status')).result.position===1);await B.call('release');ok((await waiting).result.waitResult==='ready')
await C.call('acquire');ok((await C.call('claim')).result===null);await C.call('release')
await A.call('acquire');await B.call('request');await B.call('cancel');ok((await A.call('claim')).result===null);await B.call('request');ok((await A.call('claim')).result?.leaseId);await A.call('pause');await A.call('resume');await A.call('release');await B.call('cancel')
console.log(JSON.stringify({namespace,assertions:count,result:'GREEN',scope:'real Node actors / Windows mutex guardians; no desktop backend'}))
}finally{for(const a of actors)a.p.stdin.end();setTimeout(()=>{for(const a of actors)a.p.kill()},2000).unref()}
