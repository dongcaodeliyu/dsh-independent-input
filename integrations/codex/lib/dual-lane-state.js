// Pure protocol state. Native lifetime, durable writes and trusted identity are
// supplied by the coordinator; this module never starts input or clears a pause.
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
export const laneCapacity=JSON.parse(readFileSync(new URL('./dual-capacity.json',import.meta.url),'utf8')).laneCapacity
const isDesktopGesture=info=>(info?.source==='keyboard-hook'&&info.reason==='control-escape'&&info.keyboard?.gesture==='Ctrl+Esc'&&info.keyboard.injected===false)||(info?.source==='keyboard-hotkey'&&info.reason==='hotkey')
const headerNoticeMs=2000
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const text=value=>typeof value==='string'&&value.length>0
const stop=value=>object(value)&&Object.keys(value).length>0
function assertRecord(data){
  const reject=()=>{throw new Error('dual-state-unknown')}
  if(data.protocolVersion!==3||!Array.isArray(data.lanes)||data.lanes.length>laneCapacity||!Array.isArray(data.tickets)||!object(data.halted)||!object(data.completed)||!Number.isSafeInteger(data.nextSequence)||data.nextSequence<1||!Number.isSafeInteger(data.revision)||data.revision<0)reject()
  for(const key of ['desktopStop','lastDesktopStop','controllerFault'])if(data[key]!=null&&!stop(data[key]))reject()
  const lanes=new Set(),tickets=new Set()
  for(const lane of data.lanes){
    if(!object(lane)||!text(lane.executionId)||!text(lane.leaseId)||!text(lane.laneId)||typeof lane.paused!=='boolean'||lanes.has(lane.executionId))reject()
    lanes.add(lane.executionId)
    if(lane.paused?!stop(lane.stopInfo):lane.stopInfo!=null)reject()
    if(lane.resuming!==undefined&&(typeof lane.resuming!=='boolean'||lane.resuming&&!lane.paused))reject()
    if(lane.finishing!=null&&(!object(lane.finishing)||lane.finishing.leaseId!==lane.leaseId||lane.paused))reject()
    for(const key of ['lastStop','lastTransition','controllerFault'])if(lane[key]!=null&&!stop(lane[key]))reject()
  }
  let sequence=0
  for(const ticket of data.tickets){
    if(!object(ticket)||!text(ticket.executionId)||!text(ticket.ticketId)||!Number.isSafeInteger(ticket.sequence)||ticket.sequence<=sequence||!Number.isFinite(ticket.expiresAt)||ticket.expiresAt<=0||tickets.has(ticket.executionId)||lanes.has(ticket.executionId)||!Object.hasOwn(ticket,'actor')||ticket.actor!==null&&!object(ticket.actor))reject()
    tickets.add(ticket.executionId);sequence=ticket.sequence
  }
  if(sequence>=data.nextSequence)reject()
  for(const [id,halted] of Object.entries(data.halted)){
    if(!object(halted)||!text(id)||halted.executionId!==id||halted.beginRequired!==undefined&&typeof halted.beginRequired!=='boolean'||halted.desktopStopped!==undefined&&typeof halted.desktopStopped!=='boolean')reject()
    // Fault retirement permits begin; an actual stop must retain resume authority.
    if(halted.beginRequired===true?(halted.stopInfo!=null||halted.desktopStopped===true):!stop(halted.stopInfo))reject()
    if(halted.lastStop!=null&&(!stop(halted.lastStop)||halted.beginRequired===true&&halted.lastStop.kind==='pause'))reject()
  }
  for(const receipt of Object.values(data.completed))if(!object(receipt)||receipt.ok!==true||receipt.completed!==true||!text(receipt.leaseId))reject()
}
export class DualLaneState {
  constructor(record={}, {now=()=>Date.now(),id=()=>randomUUID()}={}){
    if(!object(record))throw new Error('dual-state-unknown')
    this.now=now;this.id=id
    this.headerNotices=new Map()
    this.finishYields=new Set()
    this.data={protocolVersion:3,nextSequence:1,revision:0,lanes:[],tickets:[],desktopStop:null,halted:{},completed:{},...record}
    assertRecord(this.data)
  }
  changed(){this.data.revision++;return this.data}
  recoverDeadGeneration(){
    for(const lane of this.data.lanes)this.data.halted[lane.executionId]=lane.paused?{...this.identity(lane),stopInfo:lane.stopInfo,lastStop:lane.lastStop,desktopStopped:!!this.data.desktopStop}:{...this.identity(lane),beginRequired:true,stopInfo:null,lastStop:{kind:'fault',source:'backend-exit',reason:'coordinator-lost',utcTimestamp:null,detectedUtc:new Date().toISOString()},desktopStopped:false}
    this.data.lanes=[];this.changed()
  }
  lane(executionId){return this.data.lanes.find(x=>x.executionId===executionId)}
  ticket(executionId){return this.data.tickets.find(x=>x.executionId===executionId)}
  identity(identity){
    if(!identity?.executionId)throw new Error('trusted-execution-required')
    return Object.fromEntries(['executionId','rootId','name','projectId','projectName','projectPath','projectSource','actorKind','actor'].map(k=>[k,identity[k]??null]))
  }
  prune(processState){
    assertRecord(this.data)
    const before=this.data.tickets.length
    this.data.tickets=this.data.tickets.filter(x=>processState(x.actor)!=='dead'&&x.expiresAt>this.now())
    if(before!==this.data.tickets.length)this.changed()
    // Held lanes never expire. A dead executor is not authorization to clear a
    // pause; coordinator recovery separately confirms all process identities.
  }
  request(identity){
    const safe=this.identity(identity),existing=this.ticket(safe.executionId)
    if(this.lane(safe.executionId))return this.snapshot(safe.executionId)
    if(existing){existing.expiresAt=this.now()+120000;this.changed();return this.snapshot(safe.executionId)}
    this.data.tickets.push({...safe,ticketId:this.id(),sequence:this.data.nextSequence++,expiresAt:this.now()+120000})
    this.changed();return this.snapshot(safe.executionId)
  }
  cancel(executionId){this.data.tickets=this.data.tickets.filter(x=>x.executionId!==executionId);this.changed();return this.snapshot(executionId)}
  acquire(identity,intent=null){
    const safe=this.identity(identity),existing=this.lane(safe.executionId)
    if(existing){if(existing.finishing)return {ok:false,reason:'lane-finishing',control:this.snapshot(safe.executionId)};if(existing.paused&&intent!=='resume')return {ok:false,reason:'execution-resume-required',control:this.snapshot(safe.executionId)};if(existing.controllerFault&&intent!=='begin'&&!(existing.paused&&intent==='resume'))return {ok:false,reason:'controller-fault-begin-required',control:this.snapshot(safe.executionId)};return {ok:true,lane:existing,reentered:true}}
    if(this.data.controllerFault&&!['begin','resume'].includes(intent))return {ok:false,reason:'controller-fault-begin-required',control:this.snapshot(safe.executionId)}
    const halted=this.data.halted[safe.executionId]
    if(halted&&intent!==(halted.beginRequired?'begin':'resume'))return {ok:false,reason:halted.beginRequired?'execution-begin-required':'execution-resume-required',control:this.snapshot(safe.executionId)}
    if(this.data.desktopStop&&!(halted&&intent==='resume'))return {ok:false,reason:'desktop-paused',control:this.snapshot(safe.executionId)}
    if(this.data.lanes.length>=laneCapacity){this.request(identity);return {ok:false,reason:'control-busy',control:this.snapshot(safe.executionId)}}
    if(this.data.tickets.length&&this.data.tickets[0].executionId!==safe.executionId){this.request(identity);return {ok:false,reason:'control-queue-turn',control:this.snapshot(safe.executionId)}}
    const lane={...safe,laneId:this.id(),leaseId:this.id(),executor:null,target:null,paused:false,stopInfo:null,lastStop:null,monitor:null,reminderClaimed:false,reminderStatus:'not-needed'}
    if(halted){lane.paused=!halted.beginRequired;lane.resuming=!halted.beginRequired;lane.stopInfo=halted.stopInfo;lane.lastStop=halted.lastStop;delete this.data.halted[safe.executionId]}
    this.data.lanes.push(lane);this.data.tickets=this.data.tickets.filter(x=>x.executionId!==safe.executionId);this.changed()
    this.clearHeaderNotices(safe.executionId)
    return {ok:true,lane,reentered:false}
  }
  checkExecutor(executionId,executor,processState=()=> 'unknown'){
    const lane=this.require(executionId);if(!executor?.pid||!executor.birth)throw new Error('executor-identity-required')
    const same=value=>value?.pid===executor.pid&&value?.birth===executor.birth
    if(this.data.lanes.some(x=>x!==lane&&same(x.executor)))throw new Error('executor-owned-by-another-lane')
    if(lane.executor&&!same(lane.executor)&&processState(lane.executor)!=='dead')throw new Error('previous-executor-live-or-unknown')
    return lane
  }
  bindExecutor(executionId,executor,processState){const lane=this.checkExecutor(executionId,executor,processState);lane.executor={pid:executor.pid,birth:executor.birth};this.changed()}
  require(executionId){const lane=this.lane(executionId);if(!lane)throw new Error('not-lane-owner');return lane}
  reserveRoot(executionId,target){
    const lane=this.require(executionId)
    if(lane.paused)return {ok:false,reason:'lane-paused'}
    if(!target?.hwnd||!target.pid||!target.birth)throw new Error('root-identity-required')
    // A HWND cannot be held twice, even if an incoming caller reports a
    // different generation. The old holder must explicitly finish/switch first.
    if(this.data.lanes.some(x=>x!==lane&&x.target?.hwnd===target.hwnd)){lane.target=null;this.changed();return {ok:false,reason:'target-root-busy',reservationReleased:true,freshObservationRequired:true,ownerExecutionId:this.data.lanes.find(x=>x!==lane&&x.target?.hwnd===target.hwnd).executionId}}
    lane.target={hwnd:target.hwnd,pid:target.pid,birth:target.birth};this.changed();return {ok:true,target:lane.target}
  }
  assertTarget(executionId,target){const lane=this.require(executionId);if(lane.paused)throw new Error('lane-paused');if(!lane.target||['hwnd','pid','birth'].some(k=>lane.target[k]!==target?.[k]))throw new Error('target-reservation-mismatch');return lane}
  claimReminder(executionId){const lane=this.require(executionId);if(lane.reminderClaimed||!this.data.tickets.length)return null;lane.reminderClaimed=true;lane.reminderStatus='unknown';this.changed();return {leaseId:lane.leaseId,delivery:'unknown',text:'做完本次桌面任务请finish，后面有排队；无需中断当前任务。'}}
  delivered(executionId,leaseId){const lane=this.require(executionId);if(lane.leaseId===leaseId&&lane.reminderClaimed){lane.reminderStatus='delivered-to-tool';this.changed()}}
  pause(executionId,stopInfo){const lane=this.require(executionId);this.finishYields.delete(lane.leaseId);lane.resuming=false;lane.finishing=null;if(!lane.paused){lane.paused=true;lane.stopInfo=stopInfo;lane.lastStop=stopInfo}this.changed()}
  pauseDesktop(stopInfo){
    const previous=this.data.lastDesktopStop||this.data.desktopStop
    if(previous&&stopInfo?.sessionId&&previous.sessionId===stopInfo.sessionId&&Number.isFinite(stopInfo.sequence)&&stopInfo.sequence<=previous.sequence)return false
    this.data.lastDesktopStop=stopInfo
    if(!this.data.desktopStop)this.data.desktopStop=stopInfo
    for(const lane of this.data.lanes){this.finishYields.delete(lane.leaseId);lane.resuming=false;lane.finishing=null;if(!lane.paused){lane.paused=true;lane.stopInfo={...stopInfo,ownerExecutionId:lane.executionId,ownerRootId:lane.rootId,ownerName:lane.name};lane.lastStop=lane.stopInfo}if(isDesktopGesture(stopInfo))this.noteHeader(lane,'user-stopped')}
    this.changed()
    return true
  }
  resume(executionId){
    const lane=this.require(executionId);lane.paused=false;lane.resuming=false;lane.stopInfo=null
    this.clearHeaderNotices(executionId)
    // Each original holder must independently resume. New acquire remains
    // blocked until all affected holders have resumed; never resume a sibling.
    if(this.data.desktopStop&&!this.data.lanes.some(x=>x.paused)&&!Object.values(this.data.halted).some(x=>x.desktopStopped))this.data.desktopStop=null
    this.changed()
  }
  prepareFinish(executionId,leaseId,resourceYield=false){
    if(this.data.completed[executionId]?.leaseId===leaseId)return {...this.data.completed[executionId],idempotent:true}
    const lane=this.require(executionId)
    if(lane.leaseId!==leaseId)return {ok:false,reason:'finish-lease-mismatch'}
    if(lane.paused)return {ok:false,reason:'lane-paused'}
    if(resourceYield===true)this.finishYields.add(leaseId)
    lane.finishing={leaseId};this.changed();return {ok:true,leaseId}
  }
  finish(executionId,executorState,leaseId=this.lane(executionId)?.leaseId){
    if(this.data.completed[executionId]?.leaseId===leaseId)return {...this.data.completed[executionId],idempotent:true}
    const lane=this.require(executionId)
    if(lane.leaseId!==leaseId)return {ok:false,reason:'finish-lease-mismatch'}
    if(lane.paused)return {ok:false,reason:'lane-paused'}
    if(lane.executor&&executorState(lane.executor)!=='dead')return {ok:false,reason:'executor-stop-unconfirmed'}
    this.data.tickets=this.data.tickets.filter(x=>x.executionId!==executionId);this.data.lanes=this.data.lanes.filter(x=>x!==lane);this.data.completed[executionId]={ok:true,leaseId,completed:true};this.changed()
    const yielded=this.finishYields.delete(leaseId)
    if(lane.finishing&&lane.actorKind!=='manual-preview'&&!this.data.lanes.some(other=>other.monitor===lane.monitor))
      this.noteHeader(lane,yielded?'yielded':'finished')
    return this.data.completed[executionId]
  }
  retire(executionId,executorState,unboundActorDead=false){
    const lane=this.require(executionId)
    if(lane.executor?executorState(lane.executor)!=='dead':!lane.paused&&!unboundActorDead)return {ok:false,reason:'executor-stop-unconfirmed'}
    const stoppedIdentity=this.identity(lane)
    if(lane.paused)this.data.halted[executionId]={...stoppedIdentity,stopInfo:lane.stopInfo,lastStop:lane.lastStop,desktopStopped:!!this.data.desktopStop}
    else this.data.halted[executionId]={...stoppedIdentity,beginRequired:true,stopInfo:null,lastStop:lane.controllerFault||{kind:'fault',source:'backend-exit',reason:'backend-exit',utcTimestamp:new Date(this.now()).toISOString(),timeMeaning:'observed-dead',ownerExecutionId:executionId},desktopStopped:false}
    this.data.lanes=this.data.lanes.filter(x=>x!==lane);this.changed();return {ok:true,retired:true,resumeRequired:lane.paused}
  }
  setMonitor(executionId,device,point=null){const lane=this.require(executionId);lane.monitor=device||null;lane.headerPoint=point;if(device&&!lane.paused)this.headerNotices.delete(device);this.changed();return this.screenMembers()}
  screenMembers(){const screens={};for(const lane of this.data.lanes)if(lane.monitor)(screens[lane.monitor]??=[]).push({laneId:lane.laneId,executionId:lane.executionId,name:lane.name,paused:lane.paused,point:lane.headerPoint});return screens}
  noteHeader(lane,indicator){
    if(lane.monitor&&lane.headerPoint)this.headerNotices.set(lane.monitor,{point:lane.headerPoint,executionId:lane.executionId,indicator,expiresAt:this.now()+headerNoticeMs})
  }
  clearHeaderNotices(executionId){
    for(const [device,notice] of this.headerNotices)if(notice.executionId===executionId)this.headerNotices.delete(device)
    const device=this.lane(executionId)?.monitor
    if(device)this.headerNotices.delete(device)
  }
  expireHeaderNotices(){
    let changed=false
    for(const [device,notice] of this.headerNotices)if(notice.expiresAt<=this.now()){this.headerNotices.delete(device);changed=true}
    return changed
  }
  screenIndicators(){
    const screens=this.screenMembers()
    for(const [device,lanes] of Object.entries(screens)){
      for(const lane of lanes){
        const stop=this.lane(lane.executionId).stopInfo
        if(lane.paused&&(isDesktopGesture(stop)||this.headerNotices.get(device)?.indicator==='user-stopped'))lane.indicator='user-stopped'
      }
    }
    for(const [device,notice] of this.headerNotices)if(!screens[device])screens[device]=[{point:notice.point,paused:true,indicator:notice.indicator,notice:true}]
    return screens
  }
  snapshot(executionId){
    const lane=this.lane(executionId),index=this.data.tickets.findIndex(x=>x.executionId===executionId),head=index===0
    const ownStop=this.data.halted[executionId]||null,stoppedExecutions=Object.entries(this.data.halted).filter(([id,value])=>id===executionId||value.desktopStopped).map(([id,value])=>({...value,executionId:id,requiredAction:value.beginRequired?'begin':'resume'}))
    const ready=!lane&&!this.data.desktopStop&&this.data.lanes.length<laneCapacity&&(head||this.data.tickets.length===0)
    return {protocolVersion:3,capacity:laneCapacity,occupied:this.data.lanes.length,availableSlots:laneCapacity-this.data.lanes.length,owners:this.data.lanes.map(x=>({...x,pauseReason:x.paused?(x.stopInfo?.reason||'paused'):null,reminderStatus:!x.reminderClaimed&&this.data.tickets.length?'queued':x.reminderStatus})),queue:this.data.tickets.map((x,i)=>({...x,position:i+1})),position:index+1,turn:lane?(lane.paused?'resume-required':lane.finishing?'finishing':lane.controllerFault?'begin-required':'owned'):ownStop&&!ownStop.beginRequired?'resume-required':head&&ready?'ready':index>=0?'queued':'not-queued',canAcquire:lane?!lane.paused&&!lane.finishing&&!lane.controllerFault:ready&&(!ownStop||ownStop.beginRequired),desktopPaused:!!this.data.desktopStop,controllerFault:this.data.controllerFault||null,ownStop,stoppedExecutions,revision:this.data.revision}
  }
}
