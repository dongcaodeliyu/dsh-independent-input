// Real Windows mutexes + real child processes; no windows or application input.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {writeFile,readFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {ControlLease} from '../lib/control-lease.js'
import {InputEngine} from '../lib/engine.js'
import {apply} from '../index.js'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const namespace='regression-'+randomUUID(),leaseOptions={testNamespace:namespace}
const a=new ControlLease(leaseOptions),b=new ControlLease(leaseOptions),c=new ControlLease(leaseOptions)
const A={threadId:'lease-test-A',rootId:'root-A',name:'租约测试A'},B={threadId:'lease-test-B'}
const initial=await a.status(A.threadId)
if(initial.busy)throw new Error('Another plugin executor owns the desktop; test did not acquire or disturb it')
assert.equal(a.helper,null,'readonly status must not initialize the guard')
const temp=await mkdtemp(join(tmpdir(),'independent-lease-'))
let sleeper,engine,dispose,ownerId=A.threadId
try{
 await a.acquire(A)
 assert.equal((await b.status(B.threadId)).ownerExecutionId,A.threadId)
 await assert.rejects(b.acquire(B),e=>e.code==='control-busy')
 await assert.rejects(a.acquire(B),e=>e.code==='control-busy','same JS lease must isolate executions')
 await assert.rejects(a.release(B.threadId),e=>e.code==='control-busy')
 // Actual tool execute rejects every effect path before sidecar startup, including
 // begin/finish/overlay/config and open/place. Fake requests are not involved.
 let tool,api
 const settingsFile=join(temp,'settings.json');await writeFile(settingsFile,'{"enabled":true}')
 dispose=await apply({tools:{register(v){tool=v;return()=>{}}},effect(fn){fn()},webServer:{register(v){if(v.kind==='prefix'&&v.path.endsWith('/api'))api=v.handler}}},{},{defineTool:v=>v,settingsFile,controlLease:new ControlLease(leaseOptions)})
 for(const action of ['begin','finish','move','overlay','click','type','key','scroll','drag','bounds','place','open','pause','resume']){
  const result=await tool.execute({action,x:1,y:2,cursorSize:75,hwnd:1,path:'C:\\fixture'},B)
  assert.equal(result.meta.reason,'control-busy',action)
 }
 const status=await tool.execute({action:'status'},B)
 assert.equal(status.meta.control.ownerExecutionId,A.threadId)
 let httpBody='';await api({method:'POST',url:'/dsh-independent-input/api/show'},{setHeader(){},end(v){httpBody=v}})
 assert.match(httpBody,/control-busy/,'manual preview participates in the same mutex')
 await a.release(A.threadId)
 await b.acquire(B,'begin');await b.release(B.threadId)
 console.log('PASS real kernel mutex: multi-process exclusion, same-process execution isolation, nonowner finish/hide, all actual tool effect entrances and HTTP show, readonly no helper/UI')
 // A guardian killed while its exact executor is alive must not free control.
 sleeper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})
 await a.acquire(A);await a.bind(sleeper.pid)
 const recordPath=join(process.env.LOCALAPPDATA,'dsh-independent-input-control','tests',namespace,a.owner.scope+'.json')
 const guardian=a.helper;guardian.kill();await once(guardian,'exit');await sleep(50)
 assert.equal((await c.status(B.threadId)).busy,true)
 await assert.rejects(c.acquire(B),e=>e.code==='control-busy')
 sleeper.kill();await once(sleeper,'exit');sleeper=null
 await c.acquire(B);await c.release(B.threadId)
 console.log('PASS guardian crash retains busy for live PID + creation stamp; acquires after exact executor exits')
 // A reused PID with a different creation stamp is not that old executor.
 await a.acquire(A);const stale=JSON.parse(await readFile(recordPath,'utf8'))
 stale.executor={pid:process.pid,birth:'1'}
 await writeFile(recordPath,JSON.stringify(stale))
 const old=a.helper;old.kill();await once(old,'exit');await sleep(50)
 await c.acquire(B);await c.release(B.threadId)
 // Malformed shared state must never be interpreted as a dead owner.
 await writeFile(recordPath,'{broken')
 assert.equal((await c.status(B.threadId)).canAcquire,false)
 await assert.rejects(c.acquire(B),e=>e.control.reason==='control-state-unknown-repair-required')
 await writeFile(recordPath,JSON.stringify({...stale,executor:{pid:process.pid}}))
 assert.equal((await c.status(B.threadId)).canAcquire,false)
 await assert.rejects(c.acquire(B),e=>e.control.reason==='old-executor-state-unknown')
 await writeFile(recordPath,JSON.stringify(stale))
 await c.acquire(B);await c.release(B.threadId)
 console.log('PASS abandoned mutex recovery rejects PID-reuse false positives using creation stamp')
 // Actual InputEngine request + real recorder executor (no PowerShell sidecar).
 const recorder=join(temp,'recorder.cjs')
 await writeFile(recorder,`process.stdout.write('{"event":"ready"}\\n');require('readline').createInterface({input:process.stdin}).on('line',l=>{let m=JSON.parse(l);if(m.cmd==='__interrupt')return;if(m.cmd==='stall')return;process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ok:true,paused:false,sessionState:m.cmd==='finish'?'finished':'active'}})+'\\n')});`)
 let dispatches=0
 engine=new InputEngine({controlLease:new ControlLease(leaseOptions),spawnProcess(){const child=spawn(process.execPath,[recorder],{windowsHide:true,stdio:['pipe','pipe','pipe']});const write=child.stdin.write.bind(child.stdin);child.stdin.write=(...args)=>{dispatches++;return write(...args)};return child}})
 await engine.context.run(A,()=>engine.request('begin'))
 const before=dispatches
 await assert.rejects(engine.context.run(B,()=>engine.request('move',{x:1,y:2})),e=>e.code==='control-busy')
 await assert.rejects(engine.context.run(B,()=>engine.request('finish')),e=>e.code==='control-busy')
 assert.equal(dispatches,before,'nonowner cannot dispatch into shared engine')
 const release=engine.control.release.bind(engine.control)
 let finishes=0
 engine.control.release=async id=>{const count=dispatches;await release(id);assert.equal(dispatches,count,'no queued input dispatched while finish releases the mutex');finishes++}
 await Promise.all([engine.context.run(A,()=>engine.request('finish')),engine.context.run(A,()=>engine.request('begin')),engine.context.run(A,()=>engine.request('move',{x:3,y:4}))])
 assert.equal(finishes,1);assert.equal(engine.control.owner.executionId,A.threadId)
 console.log('PASS actual shared-engine same-owner concurrent finish/begin/move: release remains inside controlled queue; following requests reacquire before dispatch')
 await engine.context.run(A,()=>engine.request('finish'))
 let previewApi;const previewDispose=await apply({tools:{register(){return()=>{}}},effect(fn){fn()},webServer:{register(v){if(v.path.endsWith('/api'))previewApi=v.handler}}},{},{defineTool:v=>v,settingsFile,engine})
 async function preview(route){let body,code;await previewApi({method:'POST',url:'/dsh-independent-input/api/'+route},{setHeader(){},set statusCode(v){code=v},end(v){body=JSON.parse(v)}});return {code,body}}
 assert.equal((await preview('show')).code,200);assert.equal(engine.control.owner.actorKind,'manual-preview');assert.equal(engine.control.owner.rootId,null)
 await assert.rejects(c.acquire(B),e=>e.code==='control-busy')
 await assert.rejects(engine.context.run(engine.control.manualPreviewContext(),()=>engine.request('click',{hwnd:1,x:1,y:2})),e=>e.code==='preview-scope-only')
 assert.equal((await preview('hide')).code,200)
 await engine.context.run(A,()=>engine.request('begin'))
 console.log('PASS actual HTTP preview with real mutex and recorder: distinct internal manual subject, busy exclusion, hide releases only preview, cannot dispatch application input')
 const proc=engine.proc;proc.stdin.end=()=>{};proc.kill=()=>false
 proc.stdout.emit('data',JSON.stringify({event:'pause-state',paused:true,reason:'escape',transportSealed:false})+'\n')
 await engine.control.pause('escape')
 await engine.interrupt('host-cancel')
 assert.equal(engine.proc,proc,'unconfirmed executor is retained')
 await assert.rejects(c.acquire(B),e=>e.code==='control-busy')
 process.kill(proc.pid);await once(proc,'close');const finalGuardian=engine.control.helper,guardClosed=once(finalGuardian,'close');finalGuardian.stdin.end();await guardClosed
 assert.equal((await c.status(B.threadId)).reason,'control-paused')
 await assert.rejects(c.acquire(B),e=>e.control.reason==='control-paused')
 const home=process.env.CODEX_HOME;process.env.CODEX_HOME=join(temp,'different-home')
 try {await c.acquire(B,'resume');assert.equal(c.owner.pauseReason,'escape');await c.resume();await c.release(B.threadId)}finally{if(home===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=home}
 console.log('PASS global physical-Esc event/host-stop survives executor/guardian exit and different CODEX_HOME begin; explicit new trusted execution resume only after exact executor is dead')
 console.log('PASS real InputEngine with recorder executor: other trusted execution cannot dispatch; cancellation with unconfirmed exit retains busy')
}finally{
 sleeper?.kill();dispose?.()
 if(engine?.proc){process.kill(engine.proc.pid)}
 for(const lease of [a,b,c,engine?.control].filter(Boolean)){if(lease.owner){try{if(lease.owner.pauseReason)await lease.resume();await lease.release(lease.owner.executionId)}catch{}}}
 await rm(temp,{recursive:true,force:true})
}
