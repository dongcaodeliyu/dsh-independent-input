import {sanitizePublic} from './auth-privacy.js'
import {compactStop} from './stop-info.js'
// Public projections only. Full snapshots/signatures remain in the sidecar.
const boundText = n => Number.isInteger(n) ? Math.max(1,Math.min(16384,n)) : 256
export function textLimit(text, max = 256) {
 max=boundText(max)
 const chars=Array.from(String(text ?? ''))
 return {text:chars.slice(0,max).join(''),...(chars.length>max ? {length:chars.length,truncated:true} : {})}
}
function field(out,key,value,max){const s=textLimit(value,max);out[key]=s.text;if(s.truncated){out[key+'Length']=s.length;out[key+'Truncated']=true}}
export function screenshotEvidence({images=[],path=null}={}) {
 const attached=Array.isArray(images)&&images.length>0
 return {imageEvidence:attached?'attached':path?'saved-only':'none',screenshotContentFreshness:attached||path?'unverified':'unavailable'}
}
export function observationEvidenceNote(evidence) {
 const visual=evidence.imageEvidence==='attached'?'已附图：先看实际图片核对当前场景/目标，UIA仅作语义参考。':evidence.imageEvidence==='saved-only'?'图片仅已保存、未附图；按返回路径查看实际图片前，不能作视觉验收。':'当前无截图视觉证据，不能因UIA存在就作视觉验收。'
 return `UIA为provider报告，offscreen=false不保证屏幕可见。${visual}若不符，报告“观察不一致/暂无法视觉验收”，只读fresh核对，不据此判点击无效或重发输入。`
}
export function presentObservation(observed,{details=false,maxTextChars=256}={},screenshot=null) {
 maxTextChars=boundText(maxTextChars);details=details===true
 const result={...observed,windowObservationId:observed.observationId,evidence:{uiaVisibility:'provider-reported',...screenshotEvidence({images:screenshot?.images,path:screenshot?.meta?.path})}}
 result.window={...observed.window};field(result.window,'title',observed.window?.title,maxTextChars)
 result.elements=(observed.elements || []).map(e=>{
  const native=Boolean(e.nativeWindowHandle), backgroundActions=[]
  if(native&&e.enabled&&!e.offscreen){if(e.type==='ControlType.Button'&&/^(Button|WindowsForms10\.BUTTON\..+)$/i.test(e.nativeClass))backgroundActions.push('click');if(e.type==='ControlType.Edit'&&/^(Edit|WindowsForms10\.EDIT\..+)$/i.test(e.nativeClass)&&!e.password&&!e.nativePassword&&!e.nativeReadOnly&&!e.state?.readonly)backgroundActions.push('type')}
  const valueWrite=e.enabled&&!e.offscreen&&!e.password&&!e.nativePassword&&!e.nativeReadOnly&&!e.state?.readonly&&['ControlType.Edit','ControlType.ComboBox'].includes(e.type)&&e.patterns?.includes('Value')?'foreground-root-under-preserve':undefined
  const out=details ? {...e,valueWrite} : {elementId:e.elementId,parentId:e.parentId,type:e.type,rect:e.rect,enabled:e.enabled,offscreen:e.offscreen,password:e.password,readonly:Boolean(e.nativeReadOnly||e.state?.readonly),backgroundActions,valueWrite}
  field(out,'name',e.name,maxTextChars)
  if(e.value!==null&&e.value!==undefined)field(out,'value',e.value,maxTextChars)
  if(details){field(out,'automationId',e.automationId,maxTextChars);field(out,'nativeClass',e.nativeClass,maxTextChars)}
  return out
 })
 result.textLimit=maxTextChars;result.details=details
 return sanitizePublic(result)
}
export function presentWindows(inventory,{title,className,pid,offset=0,limit=24,maxTextChars=256}={}) {
 maxTextChars=boundText(maxTextChars);limit=Number.isInteger(limit)?Math.max(1,Math.min(100,limit)):24;offset=Number.isInteger(offset)?Math.max(0,offset):0
 const matches=(inventory.windows||[]).filter(w=>(!title||w.title?.toLowerCase().includes(title.toLowerCase()))&&(!className||w.className?.toLowerCase().includes(className.toLowerCase()))&&(pid===undefined||w.pid===pid))
 const windows=matches.slice(offset,offset+limit).map(w=>{const out={...w};field(out,'title',w.title,maxTextChars);field(out,'className',w.className,maxTextChars);field(out,'process',w.process,maxTextChars);return out})
 return {...inventory,windows,totalMatched:matches.length,offset,limit,hasMore:offset+windows.length<matches.length,textLimit:maxTextChars}
}
export function presentControl(control,details=false){
 if(details||!control)return control
 const owner=control.owner,out={}
 for(const k of ['busy','scope','canAcquire','reason','pauseReason','externalOfficialState','leaseId','ownerExecutionId','ownerRootId','ownerName','ownerProjectId','ownerProjectName','ownerProjectPath','ownerProjectSource','reminderStatus','state','position','turn','queueVersion','waitResult','protocolVersion','coordinatorRuntimeVersion','capacity','occupied','availableSlots','desktopPaused','migrationState','observationError','recoveryRequired','observedDead','recoveryState'])if(control[k]!==undefined)out[k]=control[k]
 if(control.owners)out.owners=control.owners.map(x=>Object.fromEntries(['executionId','rootId','name','projectId','projectName','projectSource','leaseId','paused','pauseReason','reminderStatus'].filter(k=>x[k]!==undefined).map(k=>[k,x[k]])))
 if(control.stoppedExecutions?.length)out.stoppedExecutions=control.stoppedExecutions.map(x=>({...Object.fromEntries(['executionId','rootId','name','projectId','projectName','requiredAction'].filter(k=>x[k]!==undefined).map(k=>[k,x[k]])),...(x.lastStop?{lastStop:compactStop(x.lastStop)}:{})}))
 if(control.controllerFault)out.controllerFault=compactStop(control.controllerFault)
 if(control.sharedHeaders)out.sharedHeaders=control.sharedHeaders.map(x=>({monitor:x.monitor,visible:x.visible,renderSucceeded:x.renderSucceeded,sampledUtc:x.sampledUtc}))
 if(owner){Object.assign(out,{ownerExecutionId:owner.executionId,ownerRootId:owner.rootId,ownerName:owner.name,ownerProjectId:owner.projectId,ownerProjectName:owner.projectName,ownerProjectSource:owner.projectSource,leaseId:owner.leaseId,pauseReason:owner.pauseReason,reminderStatus:owner.reminderStatus})}
 for(const k of ['stopInfo','lastStop'])if(control[k]||owner?.[k])out[k]=compactStop(control[k]||owner[k])
 if(control.queue)out.queue=control.queue.map(t=>Object.fromEntries(['executionId','rootId','name','projectId','projectName','projectSource','position','sequence','actorState'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]])))
 return out
}
export function presentStatus(status,max=256,details=false){const out={...status,foreground:{...status.foreground}};field(out.foreground,'title',status.foreground?.title,max);field(out.foreground,'className',status.foreground?.className,max);if(!details){for(const key of ['stopInfo','lastStop'])if(out[key])out[key]=compactStop(out[key]);if(out.control)out.control=presentControl(out.control)}return out}
