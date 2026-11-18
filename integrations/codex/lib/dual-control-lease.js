import {connectExecutor} from './executor-transport.js'
import {randomUUID} from 'node:crypto'
import {ControlLease} from './control-lease.js'
import {dualCall} from './dual-coordinator.js'
import {laneCapacity} from './dual-lane-state.js'
// Per-execution client. Coordinator connection is an internal capability, never
// a tool/model parameter. Each InputEngine receives a distinct instance.
export class DualControlLease extends ControlLease {
  constructor({connection,...options}={}){super(options);if(!connection)throw new Error('coordinator-connection-required');this.connection=connection;this.startupPermit=null;this.requiresExecutorExit=true;this.supportsDual=true}
  async invoke(op,context={},args={},options={}){
    const readonly=['status','cancel','claim','delivered'].includes(op),message={op,identity:this.identity(context),...args}
    const endpoint=await this.connection({readonly})
    this.endpoint=endpoint
    try{return await dualCall(endpoint,message,options)}catch(error){
      if(readonly||!['ECONNREFUSED','ENOENT'].includes(error.code))throw error
      // Re-enter only the guardian's dead-generation recovery gate. Never retry
      // an application input; this operation is control metadata only.
      return dualCall(await this.connection({recover:true}),message,options)
    }
  }
  describeSnapshot(snapshot,id){
    const own=snapshot.owners?.find(x=>x.executionId===id),first=own||snapshot.owners?.[0]||snapshot.ownStop||snapshot.stoppedExecutions?.[0]||null
    const reason=snapshot.turn==='resume-required'?'execution-resume-required':snapshot.turn==='begin-required'?'controller-fault-begin-required':snapshot.turn==='finishing'?'lane-finishing':own?'owned':snapshot.desktopPaused?'control-paused':snapshot.canAcquire?(snapshot.position?'queue-ready':'available'):snapshot.position?'control-queue-turn':'control-busy'
    return {...this.describe(first,id,reason),...snapshot,busy:!snapshot.canAcquire,reason,owner:first,ownerExecutionId:first?.executionId||null,ownerRootId:first?.rootId||null,ownerName:first?.name||null,ownerProjectName:first?.projectName||null,leaseId:own?.leaseId||null,externalOfficialState:'unknown'}
  }
  async status(id){
    try{return this.describeSnapshot(await this.invoke('status',{threadId:id||'readonly-status'}),id)}catch(error){
      if(['ENOENT','ECONNREFUSED'].includes(error.code)&&this.connection.inspectRecovery){
        try{const snapshot=await this.connection.inspectRecovery(id);return {...this.describeSnapshot(snapshot,id),reason:snapshot.canAcquire?'coordinator-recovery-required':snapshot.desktopPaused?'control-paused-recovery-required':snapshot.turn==='resume-required'?'execution-resume-required':'control-queue-recovery-required'}}catch{error={code:'coordinator-generation-live-or-unknown'}}
      }
      if(error.code==='coordinator-not-started'||error.message==='coordinator-not-started')return {...this.describe(null,id),protocolVersion:3,capacity:laneCapacity,occupied:0,availableSlots:laneCapacity,owners:[],queue:[],position:0,turn:'not-queued'}
      if(error.code==='legacy-control-record'){
        try{
          // Reuse the existing read-only PID/birth + queue observer. This takes
          // no input lease and performs no migration; guardian remains the
          // authority under the legacy mutex when an actual begin is requested.
          const result=await super.operation('status',{threadId:id}),unknown=result.state==='unknown',available=result.state==='available'
          const migrationState=unknown?'legacy-unknown':result.state==='paused'?'legacy-paused':!available?'legacy-live':result.queue?.length?'legacy-queue-present':'legacy-dead-upgrade-ready'
          return {...this.describe(result.owner,id,unknown?'control-state-unknown':available?(result.canAcquire?'legacy-upgrade-ready':'legacy-queue-turn'):result.state==='paused'?'control-paused':'legacy-control-busy'),busy:unknown?null:!result.canAcquire,canAcquire:result.canAcquire,protocolVersion:3,capacity:laneCapacity,occupied:available?0:unknown?null:1,availableSlots:available?laneCapacity:0,owners:result.owner?[result.owner]:[],owner:result.owner,lastStop:result.lastStop||null,queue:result.queue,position:result.position,turn:result.turn,queueVersion:result.queueVersion,migrationState,...(unknown?{observationError:'legacy-state-unknown'}:{})}
        }catch(cause){error=cause}
      }
      return {...this.describe(null,id,'control-observation-unavailable'),observationError:typeof error.code==='string'?error.code:'control-status-read-failed'}
    }
  }
  async acquire(context={},intent=null){
    const id=this.executionId(context);if(!id)throw Object.assign(new Error('trusted-execution-required'),{code:'trusted-execution-required'})
    const result=await this.invoke('acquire',context,{intent})
    if(!result.ok){const error=this.busy(result.control?.owners?.[0],id,result.reason);error.control=this.describeSnapshot(result.control||await this.invoke('status',context),id);throw error}
    this.owner={...result.lane,pauseReason:result.lane.paused?(result.lane.stopInfo?.reason||'paused'):null};this.statePath=result.statePath;this.trustedContext=context;return this.describeSnapshot(await this.invoke('status',context),id)
  }
  executorEnvironment(){if(!this.owner){this.startupPermit=null;return {DSH_INPUT_READONLY:'1',DSH_INPUT_STARTUP_PERMIT:''}};this.assert(this.owner.executionId);this.startupPermit=randomUUID();this.pauseEvent='Local\\dsh-dual-pause-'+randomUUID();return {DSH_INPUT_READONLY:'0',DSH_INPUT_STARTUP_PERMIT:this.startupPermit,DSH_INPUT_EXTERNAL_HEADERS:'1',DSH_INPUT_COORDINATOR_PIPE:this.endpoint,DSH_INPUT_EXECUTION_ID:this.owner.executionId,DSH_INPUT_SHARED_STOP_FILE:this.statePath,DSH_INPUT_PAUSE_EVENT:this.pauseEvent}}
  assert(id){if(!this.owner||this.owner.executionId!==id)throw this.busy(this.owner,id)}
  async spawnExecutor(environment){const result=await this.invoke('launch-executor',this.trustedContext,{environment:Object.fromEntries(Object.entries(environment).filter(([key])=>key.startsWith('DSH_INPUT_')||key==='CODEX_HOME'))});if(!result.ok)throw new Error(result.reason);return connectExecutor(result)}
  async bind(pid){this.assert(this.owner?.executionId);const result=await this.invoke('bind',this.trustedContext,{pid,pauseEvent:this.pauseEvent});if(!result.ok)throw Object.assign(new Error(result.reason),{code:result.reason,nativeError:result.nativeError,errorType:result.errorType,innerType:result.innerType});this.boundPid=result.executor;return result}
  async reserve(hwnd){const result=await this.invoke('reserve',this.trustedContext,{hwnd});if(!result.ok)throw Object.assign(new Error(result.reason),{code:result.reason,control:result});return result.target}
  async assertTarget(hwnd){const result=await this.invoke('assert-target',this.trustedContext,{hwnd});if(!result.ok)throw Object.assign(new Error(result.reason),{code:result.reason});return result}
  async request(context,{signal}={}){if(signal?.aborted)throw new Error('request-cancelled');let result;try{result=await this.invoke('request',context)}finally{if(signal?.aborted)await this.cancel(context)}if(signal?.aborted)throw new Error('request-cancelled');this.tickets.set(this.executionId(context),context);return this.describeSnapshot(result,this.executionId(context))}
  async wait(context,{waitMs=45000,signal}={}){this.tickets.set(this.executionId(context),context);try{return this.describeSnapshot(await this.invoke('wait',context,{waitMs},{signal}),this.executionId(context))}catch(error){await this.cancel(context);throw error}}
  async cancel(context){const result=await this.invoke('cancel',context);this.tickets.delete(this.executionId(context));return this.describeSnapshot(result,this.executionId(context))}
  async disconnect(){await Promise.allSettled([...this.tickets.values()].map(x=>this.cancel(x)));this.tickets.clear()}
  async pause(reason,stopInfo){if(!this.owner)return;const desktop=stopInfo?.source==='keyboard-hook'&&stopInfo?.keyboard?.gesture==='Ctrl+Esc'||stopInfo?.source==='keyboard-hotkey';const result=await this.invoke(desktop?'pause-desktop':'pause',this.trustedContext,{stopInfo:stopInfo||{reason,source:'host-cancel'}});if(!result.ok)throw new Error(result.reason);this.owner.pauseReason=reason;this.owner.stopInfo=stopInfo}
  async resume(){const result=await this.invoke('resume',this.trustedContext);if(!result.ok)throw new Error(result.reason);this.owner.pauseReason=null;this.owner.stopInfo=null}
  async recordFault(stopInfo){if(this.owner)return this.invoke('fault',this.trustedContext,{stopInfo})}
  async claimReminder(context){return (await this.invoke('claim',context)).notice}
  async delivered(context,leaseId){return this.invoke('delivered',context,{leaseId})}
  async startLaunch(launch){this.assert(this.owner?.executionId);return this.invoke('launch-start',this.trustedContext,{leaseId:this.owner.leaseId,launch})}
  async launchStatus(launchTicket,details=false){this.assert(this.owner?.executionId);return this.invoke('launch-status',this.trustedContext,{leaseId:this.owner.leaseId,launchTicket,details})}
  async prepareFinish(resourceYield=false){const result=await this.invoke('prepare-finish',this.trustedContext,{leaseId:this.owner.leaseId,resourceYield});if(!result.ok)throw Object.assign(new Error(result.reason),{code:result.reason})}
  async release(id){this.assert(id);const result=await this.invoke('finish',this.trustedContext,{leaseId:this.owner.leaseId});if(!result.ok)throw Object.assign(new Error(result.reason),{code:result.reason});this.owner=null;this.boundPid=null;this.startupPermit=null}
}
