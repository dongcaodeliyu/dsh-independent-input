import {spawn} from 'node:child_process'
import {createServer,createConnection} from 'node:net'
import {writeFile,rename,unlink} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {EventEmitter} from 'node:events'
import {DualLaneState} from './dual-lane-state.js'
import {SharedHeaderHost} from './shared-header-host.js'
import {launchExecutor} from './executor-transport.js'
import {LaunchTickets} from './launch-tickets.js'
import {dualControlPaths,readDualPersistence} from './dual-persistence.js'
const guardianScript=fileURLToPath(new URL('./dual-guardian.ps1',import.meta.url))
const runtimeVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
class Guardian {
  constructor(testNamespace,stateStamp){
    this.waiters=[];this.lines=[];this.tail=Promise.resolve();this.closed=false
    this.proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',guardianScript,'-CoordinatorPid',String(process.pid),'-StateStamp',stateStamp,...(testNamespace?['-TestNamespace',testNamespace]:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']})
    let buffer='';this.proc.stdout.setEncoding('utf8');this.proc.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const value=JSON.parse(line);if(this.waiters.length)this.waiters.shift().resolve(value);else this.lines.push(value)}catch(e){this.fail(e)}}})
    this.proc.stderr.on('data',()=>this.fail(new Error('guardian-stderr')))
    this.proc.on('error',e=>this.fail(e));this.proc.on('close',()=>this.fail(new Error('guardian-lost')));this.proc.stdin.on('error',()=>{})
  }
  fail(error){this.closed=true;for(const waiter of this.waiters.splice(0))waiter.reject(error);try{this.proc.stdin.end()}catch{};this.onLost?.(error)}
  reply(){if(this.lines.length)return Promise.resolve(this.lines.shift());if(this.closed)return Promise.reject(new Error('guardian-lost'));return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}))}
  call(message){const next=this.tail.then(async()=>{if(this.closed)throw new Error('guardian-lost');this.proc.stdin.write(JSON.stringify(message)+'\n');return this.reply()});this.tail=next.catch(()=>{});return next}
}
export async function startDualCoordinator({testNamespace=null,stateOptions={},onMembers=null,inspectRoot=null,settingsFile='',beforeStateWrite=null,testBackend=false}={}){
  if(testBackend&&!testNamespace)throw new Error('test backend requires isolated namespace')
  if(inspectRoot&&!testNamespace)throw new Error('internal-test-root-seam-only')
  if(beforeStateWrite&&!testNamespace)throw new Error('internal-test-storage-seam-only')
  const preflight=await readDualPersistence((await dualControlPaths(testNamespace)).metadata)
  const launches=new LaunchTickets(),guardian=new Guardian(testNamespace,preflight.stamp),ready=await guardian.reply()
  if(!ready.ok){guardian.proc.stdin.end();throw Object.assign(new Error(ready.reason+(ready.stage?' stage='+ready.stage+' type='+ready.errorType+'/'+ready.innerType+' native='+ready.nativeError:'')),{code:ready.reason})}
  const old=preflight.record
  let state
  try{
    if(ready.gate.recoveryPaused&&old?.generation!==ready.gate.recoveredGeneration)throw new Error('dual-state-generation-mismatch')
    if(!ready.gate.recoveryPaused&&old.lanes?.length)throw new Error('dual-state-orphaned-active-lanes')
    state=new DualLaneState(old,stateOptions)
  }catch(error){guardian.proc.stdin.end();throw error}
  if(ready.gate.recoveryPaused){
    // Recovery requires every old executor dead (guardian already checked).
    // Preserve each stopped execution, retire stale slot occupancy, never clear
    // desktop stop/authorization merely because a process is gone.
    state.recoverDeadGeneration()
  }
  state.data.generation=ready.gate.generation
  const endpoint=String.raw`\\.\pipe\dsh-dual-`+randomUUID(),events=new EventEmitter(),sockets=new Set()
  let tail=Promise.resolve(),renderTail=Promise.resolve(),closing=false,lost=false,idleTimer=null,shutdownPromise=null,maintenance=null
  const createdAt=Date.now();let acceptedWork=false
  const headerHost=new SharedHeaderHost({guardian,settingsFile,onStop:stopInfo=>surfaceStop(stopInfo),onFault:info=>surfaceFault(info)})
  const renderMembers=onMembers||(()=>headerHost.update(state.screenIndicators(),state.data.lanes.length>0,state.data.lanes.some(x=>!x.paused)))
  const saveState=async()=>{if(beforeStateWrite)await beforeStateWrite(state.data);const tmp=ready.statePath+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(state.data),'utf8');await rename(tmp,ready.statePath);events.emit('changed')}
  const persist=async()=>{await saveState();await renderMembers(state.screenMembers())}
  const renderLatest=()=>{const next=renderTail.then(()=>renderMembers(state.screenMembers()));renderTail=next.catch(()=>{});return next}
  const serialize=fn=>{const next=tail.then(fn);tail=next.catch(()=>{});return next}
  guardian.onLost=()=>{lost=true;launches.cancelAll('coordinator-guardian-lost');for(const socket of sockets)socket.destroy();events.emit('changed')}
  async function life(identity){return (await guardian.call({cmd:'life',identity})).state}
  async function signalPaused(){for(const lane of state.data.lanes)if((lane.paused||lane.controllerFault)&&lane.pauseEvent)await guardian.call({cmd:'signal-pause',name:lane.pauseEvent})}
  async function controllerFaultLocked(info,originalStopInfo=null){
    await launches.cancelAll('controller-fault')
    state.data.controllerFault=info
    for(const lane of state.data.lanes){lane.controllerFault=info;lane.faulted=true;lane.lastTransition=info;if(!lane.paused)lane.lastStop=info}
    state.changed()
    try{await saveState()}catch{info.storageFault=true}
    try{await signalPaused()}catch{info.signalFault=true}
    // Job termination is independent of disk/UI success and affects only the
    // executors already assigned by this guardian. Gate remains fail-closed.
    try{const result=await guardian.call({cmd:'controller-fault',stopInfo:info,originalStopInfo});if(!result.ok||!result.terminationRequested)info.stopUnconfirmed=true;if(!result.metadataPersisted)info.storageFault=true}catch{info.stopUnconfirmed=true}
    try{await saveState()}catch{info.storageFault=true}
  }
  async function surfaceFault(info){return serialize(()=>controllerFaultLocked(info))}
  async function surfaceStop(stopInfo){
    await serialize(async()=>{
      if(!state.data.lanes.length)return
      state.pauseDesktop(stopInfo);await launches.cancelAll('desktop-stop');let storageFailure=false,signalFailure=false
      try{await saveState()}catch{storageFailure=true}
      try{await signalPaused()}catch{signalFailure=true}
      if(storageFailure||signalFailure)await controllerFaultLocked({kind:'fault',source:'backend-controller',reason:storageFailure?'backend-controller-storage-fault':'backend-controller-stop-delivery-fault',utcTimestamp:new Date().toISOString(),storageFault:storageFailure},stopInfo)
    })
    try{await renderLatest()}catch{await surfaceFault({kind:'fault',source:'backend-controller',reason:'backend-controller-render-fault',utcTimestamp:new Date().toISOString()})}
  }
  async function prune(skipRetire=null,includeTicketActors=true){
    const identities=[...(includeTicketActors?state.data.tickets.map(x=>x.actor):[]),...state.data.lanes.map(x=>x.executor||x.actor).filter(Boolean)],states=new Map()
    for(const identity of identities){const key=JSON.stringify(identity);if(!states.has(key))states.set(key,await life(identity))}
    state.prune(x=>states.get(JSON.stringify(x))||'unknown')
    for(const lane of [...state.data.lanes])if(lane.executionId!==skipRetire&&(!lane.executor&&(lane.paused&&!lane.resuming||states.get(JSON.stringify(lane.actor))==='dead')||lane.executor&&states.get(JSON.stringify(lane.executor))==='dead')){
      if(lane.finishing&&!lane.paused)state.finish(lane.executionId,()=> 'dead',lane.finishing.leaseId)
      else state.retire(lane.executionId,()=> 'dead',!lane.executor&&states.get(JSON.stringify(lane.actor))==='dead')
      await launches.cancel(lane.executionId,'executor-ended')
    }
  }
  async function operation(message){
    if(lost||closing)throw new Error('coordinator-unavailable')
    if(message.op==='hello')return {ok:true,protocolVersion:3,runtimeVersion,coordinatorPid:process.pid,generation:ready.gate.generation}
    const identity={...(message.identity||{})},id=identity.executionId
    if(!id)throw new Error('trusted-execution-required')
    if(message.op!=='status')acceptedWork=true
    if(message.op!=='status'&&identity.actorPid){const actor=await guardian.call({cmd:'identity',pid:identity.actorPid});if(!actor.ok)throw new Error('actor-identity-unavailable');identity.actor=actor.identity}
    if(message.op!=='status')await prune(message.op==='finish'?id:null)
    let result
    switch(message.op){
      case 'status':return {...state.snapshot(id),coordinatorRuntimeVersion:runtimeVersion,sharedHeaders:headerHost.lastDiagnostics||[]}
      case 'launch-start':{
        const lane=state.require(id)
        if(lane.leaseId!==message.leaseId)throw new Error('launch-lease-mismatch')
        if(lane.paused||lane.finishing||lane.controllerFault||state.data.desktopStop)throw new Error('launch-control-stopped')
        return {ok:true,...await launches.start(lane,message.launch)}
      }
      case 'launch-status':{
        const lane=state.require(id);if(lane.leaseId!==message.leaseId)throw new Error('launch-lease-mismatch')
        return {ok:true,...launches.status(lane,message.launchTicket,{details:message.details===true})}
      }
      case 'request':result=state.request(identity);break
      case 'cancel':result=state.cancel(id);break
      case 'acquire':result={...state.acquire(identity,message.intent),statePath:ready.statePath};break
      case 'launch-executor':{
        const lane=state.require(id);if(lane.executor&&await life(lane.executor)!=='dead')return {ok:false,reason:'previous-executor-live-or-unknown'}
        const descriptor=await launchExecutor({script:fileURLToPath(new URL(testBackend?'../test/fixtures/shared-pause-backend.ps1':'../sidecar.ps1',import.meta.url)),env:{...process.env,...message.environment}})
        result={ok:true,...descriptor};break
      }
      case 'bind':{
        const lane=state.require(id),candidate=await guardian.call({cmd:'identity',pid:message.pid});if(!candidate.ok)return candidate
        const previousState=lane.executor?await life(lane.executor):'dead'
        state.checkExecutor(id,candidate.identity,()=>previousState)
        const bound=await guardian.call({cmd:'bind',pid:message.pid});if(!bound.ok)return bound
        state.bindExecutor(id,bound.executor,()=>previousState);state.lane(id).pauseEvent=message.pauseEvent||null;result={...bound,statePath:ready.statePath};break
      }
      case 'reserve':{
        const root=inspectRoot?await inspectRoot(message.hwnd):await guardian.call({cmd:'root',hwnd:message.hwnd});if(!root.ok)return root
        result=state.reserveRoot(id,root.target);break
      }
      case 'assert-target':{
        const root=inspectRoot?await inspectRoot(message.hwnd):await guardian.call({cmd:'root',hwnd:message.hwnd});if(!root.ok)return root
        state.assertTarget(id,root.target);result={ok:true};break
      }
      case 'pause':state.pause(id,message.stopInfo);await launches.cancel(id,'execution-stop');result={ok:true};break
      case 'fault':{const lane=state.require(id);await launches.cancel(id,'execution-fault');if(!lane.paused)lane.lastStop=message.stopInfo;lane.lastTransition=message.stopInfo;lane.faulted=true;state.changed();result={ok:true};break}
      case 'pause-desktop':state.require(id);state.pauseDesktop(message.stopInfo);await launches.cancelAll('desktop-stop');result={ok:true};break
      case 'resume':state.resume(id);result={ok:true};break
      case 'prepare-finish':{if(!message.leaseId)return {ok:false,reason:'finish-lease-required'};result=state.prepareFinish(id,message.leaseId,message.resourceYield);if(result.ok)await launches.cancel(id,'input-session-finish');break}
      case 'finish':{if(!message.leaseId)return {ok:false,reason:'finish-lease-required'};const receipt=state.data.completed[id];if(receipt?.leaseId===message.leaseId)return {...receipt,idempotent:true};const lane=state.require(id);if(lane.paused)return {ok:false,reason:'lane-paused'};if(lane.finishing?.leaseId!==message.leaseId)return {ok:false,reason:'finish-intent-required'};const executorState=lane.executor?await life(lane.executor):'dead';result=state.finish(id,()=>executorState,message.leaseId);break}
      case 'monitor':{const lane=state.require(id);if(lane.paused&&message.device)return {ok:false,reason:'lane-paused'};state.setMonitor(id,message.device,Number.isFinite(message.x)&&Number.isFinite(message.y)?{x:message.x,y:message.y}:null);result={ok:true};break}
      case 'claim':result={notice:state.claimReminder(id)};break
      case 'delivered':state.delivered(id,message.leaseId);result={ok:true};break
      default:throw new Error('unsupported-control-operation')
    }
    await saveState();if(['pause','pause-desktop'].includes(message.op))await signalPaused()
    if(['finish','cancel'].includes(message.op)&&idleEligible()){clearTimeout(idleTimer);idleTimer=setTimeout(()=>shutdown(true).catch(()=>{}),50)}
    return result
  }
  async function wait(message,socket){
    const deadline=Date.now()+Math.max(0,Math.min(45000,message.waitMs??45000))
    await serialize(()=>operation({...message,op:'request'}))
    while(!socket.destroyed){
      await serialize(async()=>{const revision=state.data.revision;await prune();if(revision!==state.data.revision){await saveState();renderLatest().catch(()=>{})}})
      const snapshot=await serialize(()=>operation({...message,op:'status'}))
      if(snapshot.turn==='owned'||snapshot.turn==='ready')return {...snapshot,waitResult:'ready'}
      if(!snapshot.position)return {...snapshot,waitResult:'cancelled'}
      const remaining=deadline-Date.now();if(remaining<=0)return {...snapshot,waitResult:'timeout'}
      await new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);events.off('changed',done);socket.off('close',done);resolve()};events.once('changed',done);socket.once('close',done);timer=setTimeout(done,Math.min(250,remaining))})
    }
    await serialize(()=>operation({...message,op:'cancel'})).catch(()=>{})
    return {ok:false,reason:'request-cancelled'}
  }
  const server=createServer(socket=>{sockets.add(socket);let buffer='';socket.setEncoding('utf8');socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>65536){socket.destroy();return};const i=buffer.indexOf('\n');if(i<0)return;socket.removeAllListeners('data');let message;try{message=JSON.parse(buffer.slice(0,i))}catch{socket.end(JSON.stringify({ok:false,reason:'invalid-control-json'})+'\n');return}
      if(!['hello','status'].includes(message.op)&&message.clientRuntimeVersion!==runtimeVersion){socket.end(JSON.stringify({ok:false,reason:'coordinator-client-runtime-mismatch',inputSent:false})+'\n');return}
      const run=message.op==='wait'?wait(message,socket):serialize(()=>operation(message)).then(async value=>{
        if(['acquire','pause','pause-desktop','resume','finish','monitor'].includes(message.op)){
          try{await renderLatest()}catch(error){
            if(message.op==='finish'&&value.ok)return value
            if(message.op==='acquire'&&value?.ok&&!value.reentered)await serialize(async()=>{const lane=state.lane(message.identity.executionId);if(lane?.leaseId===value.lane.leaseId&&!lane.executor){if(lane.paused)state.data.halted[lane.executionId]={...state.identity(lane),stopInfo:lane.stopInfo,lastStop:lane.lastStop,desktopStopped:!!state.data.desktopStop};state.data.lanes=state.data.lanes.filter(x=>x!==lane);state.changed();await saveState()}})
            throw error
          }
        }
        if(message.op==='monitor'&&message.device&&state.lane(message.identity.executionId)?.paused)return {ok:false,reason:'lane-paused',inputSent:false}
        if(message.op==='acquire'&&value.ok&&['begin','resume'].includes(message.intent)&&state.data.controllerFault)await serialize(async()=>{state.data.controllerFault=null;state.changed();await saveState()})
        return value
      })
      run.then(value=>{if(!socket.destroyed)socket.end(JSON.stringify(value)+'\n')},error=>{if(!socket.destroyed)socket.end(JSON.stringify({ok:false,reason:error.message,inputSent:false})+'\n')})
    })})
  function idleEligible(){return !state.data.lanes.length&&!state.data.tickets.length&&!state.data.desktopStop&&!Object.values(state.data.halted).some(x=>!x.beginRequired)}
  function guardianClosed(){return guardian.proc.exitCode!==null||guardian.proc.signalCode?Promise.resolve():new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('guardian-close-unconfirmed')),5000);guardian.proc.once('close',()=>{clearTimeout(timer);resolve()})})}
  async function shutdown(ifIdle=false){
    if(shutdownPromise)return shutdownPromise
    shutdownPromise=(async()=>{
      const stopped=await serialize(async()=>{const revision=state.data.revision;await prune();if(revision!==state.data.revision){await saveState();await renderLatest()};if(ifIdle&&state.headerNotices.size)return false;if(!idleEligible()){if(ifIdle)return false;throw new Error('coordinator-has-active-or-paused-lanes')};await headerHost.close();const result=await guardian.call({cmd:'release'});if(!result.ok)throw new Error(result.reason);closing=true;const closed=guardianClosed();guardian.proc.stdin.end();await closed;return true})
      if(!stopped)return
      clearTimeout(idleTimer);clearInterval(maintenance);for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))
      if(!Object.keys(state.data.halted).length)await unlink(ready.statePath).catch(()=>{})
    })().finally(()=>{if(!closing)shutdownPromise=null})
    return shutdownPromise
  }
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve)});await persist()}catch(error){guardian.proc.stdin.end();for(const socket of sockets)socket.destroy();server.close();throw error}
  const published=await guardian.call({cmd:'publish-endpoint',endpoint})
  if(!published.ok){guardian.proc.stdin.end();await new Promise(resolve=>server.close(resolve));throw new Error(published.reason)}
  let maintenancePending=false
  maintenance=setInterval(()=>{if(maintenancePending||closing||lost)return;maintenancePending=true;serialize(async()=>{const revision=state.data.revision;await prune(null,false);const noticeExpired=state.expireHeaderNotices();if(revision!==state.data.revision)await saveState();if(revision!==state.data.revision||noticeExpired)renderLatest().catch(()=>{});if(!state.headerNotices.size&&idleEligible()&&(acceptedWork||Date.now()-createdAt>5000)){clearTimeout(idleTimer);idleTimer=setTimeout(()=>shutdown(true).catch(()=>{}),50)}}).catch(()=>{}).finally(()=>{maintenancePending=false})},250)
  maintenance.unref()
  return {endpoint,state,guardianPid:guardian.proc.pid,scope:ready.scope,statePath:ready.statePath,close:()=>shutdown(),...(testNamespace?{surfaceStopForTest:surfaceStop,surfaceFaultForTest:surfaceFault}:{}),async abortForTest(){if(!testNamespace)throw new Error('internal-test-only');clearTimeout(idleTimer);clearInterval(maintenance);const closed=guardianClosed();guardian.proc.kill();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await closed}}
}
export function dualCall(endpoint,message,{signal}={}){
  return new Promise((resolve,reject)=>{const socket=createConnection(endpoint);let buffer='';const abort=()=>socket.destroy(Object.assign(new Error('request-cancelled'),{code:'request-cancelled'}));socket.setEncoding('utf8');socket.on('connect',()=>{if(signal?.aborted){abort();return}socket.write(JSON.stringify({...message,clientRuntimeVersion:runtimeVersion})+'\n')});socket.on('data',data=>{buffer+=data;const i=buffer.indexOf('\n');if(i>=0){try{resolve(JSON.parse(buffer.slice(0,i)))}catch(e){reject(e)}socket.end()}});socket.on('error',reject);socket.on('close',()=>{signal?.removeEventListener('abort',abort);if(!buffer.includes('\n'))reject(new Error('control-connection-closed'))});signal?.addEventListener('abort',abort,{once:true})})
}
