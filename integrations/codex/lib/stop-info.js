import {randomUUID} from 'node:crypto'
export function stopSource(reason){return ['escape','control-escape','hotkey','paused'].includes(reason)?'unknown':reason.startsWith('backend-timeout')?'backend-timeout':reason.startsWith('backend-')?reason.split(':')[0]:reason==='transport-eof'?'transport-eof':reason==='host-cancel'?'host-cancel':reason==='permission-refusal'?'permission-refusal':reason==='api'?'manual-tool':'host-interrupt'}
export class StopTracker {
 constructor(){this.sessionId=randomUUID();this.sequence=0;this.current=null;this.lastStop=null;this.lastTransition=null}
 record(reason,owner,provided=null,{fault=false}={}){
  const transition={reason,source:provided?.source||stopSource(reason),utcTimestamp:new Date().toISOString()}
  this.lastTransition=transition
  if(fault&&this.current)return {...transition,kind:'fault',sessionId:this.sessionId,sequence:++this.sequence,ownerExecutionId:owner?.executionId||null,ownerRootId:owner?.rootId||null,ownerName:owner?.name||'会话名称暂不可用'}
  if(this.current){if(provided?.utcTimestamp&&this.current.utcTimestamp&&Date.parse(provided.utcTimestamp)<Date.parse(this.current.utcTimestamp)){this.current=provided;this.lastStop=provided}return this.current}
  const info=provided||{...transition,...(transition.source==='unknown'?{utcTimestamp:null}:{}),kind:fault?'fault':'pause',sessionId:this.sessionId,sequence:++this.sequence,ownerExecutionId:owner?.executionId||null,ownerRootId:owner?.rootId||null,ownerName:owner?.name||'会话名称暂不可用'}
  this.lastStop=info;if(!fault)this.current=info
  return info
 }
 resume(){this.current=null}
}
export function compactStop(info){return info?{reason:info.reason,source:info.source,utcTimestamp:info.utcTimestamp||null,kind:info.kind,ownerName:info.ownerName||'会话名称暂不可用'}:null}
export function stopText(info){if(!info)return '';const label=info.source==='keyboard-hook'?(info.reason==='control-escape'?'键盘钩子检测到Ctrl+Esc（来源未能确认）':'键盘钩子检测到Esc（来源未能确认）'):info.source==='keyboard-hotkey'?'兼容快捷键停止':info.source==='manual-tool'?'工具手动暂停':info.source==='permission-refusal'?'权限拒绝停止':info.source==='host-cancel'?'宿主取消':info.source==='transport-eof'?'连接结束':info.source==='backend-timeout'?'后端超时故障':info.source==='backend-exit'?'后端退出故障':info.source?.startsWith('backend-')?`后端故障（${info.source}）`:'停止来源未能确认';return `${label} · ${info.utcTimestamp||'时间未知'}`}
