import { resolvePreferredMonitor, preferredWindowBounds } from './window-placement.js'
const geometry = r => r && ({x:r.x,y:r.y,width:r.width ?? r.w,height:r.height ?? r.h})
const actualMonitor = (rect, monitors=[]) => {
  if(!rect) return null
  const x=rect.x+rect.width/2,y=rect.y+rect.height/2
  return monitors.find(m=>x>=m.bounds.x&&x<m.bounds.x+m.bounds.width&&y>=m.bounds.y&&y<m.bounds.y+m.bounds.height)?.device || null
}
const contains = (outer, rect) => Boolean(outer && rect && rect.width>0 && rect.height>0 && rect.x>=outer.x && rect.y>=outer.y && rect.x+rect.width<=outer.x+outer.width && rect.y+rect.height<=outer.y+outer.height)
export async function placeWindow(engine, hwnd, preference, { status, expectedPid }={}) {
 const before=status || await engine.request('status',{},10000)
 const resolved=resolvePreferredMonitor(before.monitors,preference)
 const base={requestedMonitor:preference,resolvedMonitor:resolved.monitor?.device || null,foregroundBeforeSample:before.foreground,actualMonitor:null,actualRect:null,wasMoved:false}
 if(before.paused) return {...base,ok:false,paused:true,reason:'paused'}
 if(!resolved.available) return {...base,ok:false,reason:'no-monitor'}
 const info=await engine.request('winInfo',{hwnd},10000)
 if(expectedPid && info.pid !== expectedPid) return {...base,ok:false,reason:'new-window-owner-changed'}
 if(!info.visible||info.iconic||info.maximized||!info.topLevel) return {...base,ok:false,reason:'normal-top-level-window-required'}
 const requestedBounds=preferredWindowBounds(geometry(info.outerBounds),resolved.monitor)
 const moved=await engine.request('bounds',{hwnd,...requestedBounds,...(expectedPid ? {expectedPid} : {})},10000)
 const after=await engine.request('status',{},10000)
 const rect=geometry(moved.outerBounds || moved.rect)
 return {...base,...moved,wasMoved:rect ? ['x','y','width','height'].some(key=>rect[key]!==geometry(info.outerBounds)[key]) : null,requestedBounds,actualRect:rect || null,actualMonitor:actualMonitor(rect,after.monitors),foregroundAfterSample:after.foreground,foregroundSampleChanged:before.foreground?.hwnd!==after.foreground?.hwnd,placementConfirmed:moved.ok===true&&contains(resolved.monitor.bounds,rect)}
}
export async function openOnMonitor(engine, path, preference, {wait=ms=>new Promise(r=>setTimeout(r,ms)), polls=12}={}) {
 const before=await engine.request('status',{},10000)
 const resolved=resolvePreferredMonitor(before.monitors,preference)
 const base={path,requestedMonitor:preference,resolvedMonitor:resolved.monitor?.device || null,foregroundBeforeSample:before.foreground,wasMoved:false,placementConfirmed:false,actualMonitor:null,actualRect:null}
 if(before.paused) return {...base,ok:false,paused:true,reason:'paused',opened:false}
 if(!resolved.available) return {...base,ok:false,reason:'no-monitor',opened:false}
 const inventory=await engine.request('windows',{},15000)
 const existing=new Set(inventory.windows.map(w=>w.hwnd)), existingPids=new Set(inventory.windows.map(w=>w.pid))
 const area=resolved.monitor.workArea
 let launch
 try { launch=await engine.request('shellOpen',{path,x:Math.round(area.x+area.width/2),y:Math.round(area.y+area.height/2)},15000) }
 catch(error) { return {...base,ok:false,opened:error.launchStarted===false?false:null,launchAttempted:error.launchStarted===false?false:true,reason:error.launchStarted===false?'open-preparation-incomplete':'open-result-unknown',...(error.launchPreparation?{launchPreparation:error.launchPreparation}:{}),error:String(error.message || error),note:'不得自动重试open；准备阶段失败尚未交给启动helper，其他未知结果可能已经启动。先核原请求。'} }
 if(launch.launchTicket)return {...base,...launch,ok:['pending','accepted'].includes(launch.launchState),placementConfirmed:false,reason:launch.reason||('launch-'+launch.launchState),note:'单次启动票据；pending/unknown不等于未启动，不自动重试。可继续同执行器observe处理已授权提示，再open_status查询；接受不等于健康。窗口出现后fresh核对并显式place。'}
 launch.launchAttempted=launch.opened===true
 let stage='post-launch-status'
 try {
 let state=await engine.request('status',{},10000)
 const samples=()=>({foregroundAfterSample:state.foreground,foregroundSampleChanged:before.foreground?.hwnd!==state.foreground?.hwnd})
 if(!launch.opened) return {...base,...launch,...samples(),ok:false}
 if(state.paused||launch.paused) return {...base,...launch,...samples(),ok:false,paused:true,reason:'opened-then-paused',opened:true}
 if(!launch.pid||existingPids.has(launch.pid)) return {...base,...launch,...samples(),ok:true,reason:'opened-but-placement-unconfirmed',confirmationReason:'shared-instance-or-no-new-process',candidates:[]}
 let candidates=[]
 for(let i=0;i<polls;i++) {
  stage='discovery-status'
  state=await engine.request('status',{},10000)
  if(state.paused||state.sessionState==='finished') return {...base,...launch,...samples(),ok:false,paused:state.paused,reason:'opened-then-control-stopped',candidates}
  stage='discover-new-windows'
  const current=await engine.request('windows',{},15000)
  candidates=current.windows.filter(w=>w.pid===launch.pid&&!existing.has(w.hwnd))
  if(candidates.length>1) break
  if(candidates.length===1) {
   stage='place-new-window'
   const placed=await placeWindow(engine,candidates[0].hwnd,preference,{status:state,expectedPid:launch.pid})
   return {...base,...launch,...placed,foregroundBeforeSample:before.foreground,foregroundSampleChanged:before.foreground?.hwnd!==placed.foregroundAfterSample?.hwnd,opened:true,reason:placed.placementConfirmed?'opened-and-placed':'opened-but-placement-unconfirmed',confirmationReason:placed.reason || 'unique-new-window-of-returned-process',confirmationScope:'仅当前观察到的唯一新增顶层窗口；仍需fresh observe核对实际主窗和文件内容，可能是启动器/闪屏。',candidates}
  }
  if(i+1<polls) await wait(200)
 }
 return {...base,...launch,...samples(),ok:true,opened:true,reason:'opened-but-placement-unconfirmed',confirmationReason:candidates.length>1?'multiple-new-windows':'no-new-window-observed',candidates}
 } catch(error) {
  return {...base,...launch,ok:false,opened:launch.opened===true,launchAttempted:launch.opened===true,placementConfirmed:false,reason:launch.opened?'opened-but-placement-unconfirmed':'open-failed',confirmationReason:'post-launch-observation-error',failedStage:stage,error:String(error.message || error),note:'启动已接受时不能自动重试open；先fresh观察实际窗口/内容。'}
 }
}
