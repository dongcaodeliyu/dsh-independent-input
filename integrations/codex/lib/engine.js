/**
 * dsh-independent-input · sidecar 客户端
 *
 * 一个常驻的 Windows PowerShell 5.1 进程（STA）负责：
 *   - UIA / 窗口消息（默认，不碰真实光标）
 *   - 仅目标窗口消息/UIA；不启用真实输入回退
 *   - active期间Esc监听、Ctrl+Alt+Q暂停及独立中断控制帧
 *   - AI 光标覆盖层（点击穿透、不抢焦点）
 *
 * Node 侧只做一件事：按行发 JSON、按行收 JSON。sidecar 懒启动，
 * 第一次真正要用输入能力时才编译 C#，不拖慢 DSH 启动。
 */

import { normalizeFocusPolicy } from './focus-policy.js'
import { spawn } from 'node:child_process'
import { existsSync,readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { StopTracker } from './stop-info.js'
import { ControlLease } from './control-lease.js'
import {cleanupLaunchTemporary} from './launch-tickets.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(HERE, '..', 'sidecar.ps1')
const RUNTIME_VERSION=JSON.parse(readFileSync(join(HERE,'..','package.json'),'utf8')).version

function resolvePowerShell() {
  const explicit = process.env.DSH_INPUT_POWERSHELL
  if (explicit) return explicit
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(system)) return system
  return 'powershell.exe'
}

export class InputEngine {
  constructor({ log = () => {}, cursorMode = 'companion', cursorHoldMs = 2600, cursorSize = 0, cursorState = 'pointer', settingsFile = '', focusPolicy = 'preserve', spawnProcess = spawn, controlLease = new ControlLease() } = {}) {
    this.spawnProcess = spawnProcess
    this.focusPolicy = normalizeFocusPolicy(focusPolicy)
    this.settingsFile = settingsFile
    this.log = log
    this.cursorMode = cursorMode === 'clean' ? 'clean' : 'companion'
    this.cursorHoldMs = Number(cursorHoldMs) > 0 ? Number(cursorHoldMs) : 2600
    this.cursorSize = clampSize(cursorSize)
    this.cursorState = clampStyle(cursorState)
    this.proc = null
    this.ready = false
    this.starting = null
    this.seq = 0
    this.pending = new Map()
    this.buf = ''
    this.stderr = ''
    this.stopping = false
    this.quiescing = null
    this.hostPauseReason = ''
    this.faulted = false
    this.disposed = false
    this.stopFailure = null
    this.pauseEpoch=0
    this.stops=new StopTracker()
    this.control = controlLease
    this.controlQueue=Promise.resolve()
    this.interruptEpoch=0
    this.context = new AsyncLocalStorage()
  }

  async setCursorMode(mode, holdMs, defer = false) {
    if (mode === 'clean' || mode === 'companion') this.cursorMode = mode
    if (Number(holdMs) > 0) this.cursorHoldMs = Number(holdMs)
    if (!defer && this.ready && this.proc && this.proc.exitCode === null) {
      return this.request('setCursorMode', { mode: this.cursorMode, holdMs: this.cursorHoldMs })
    }
    return { ok: true, cursorMode: this.cursorMode, cursorHoldMs: this.cursorHoldMs, pending: true }
  }

  async setCursorSize(size, defer = false) {
    this.cursorSize = clampSize(size)
    if (!defer && this.ready && this.proc && this.proc.exitCode === null) {
      return this.request('setCursorSize', { size: this.cursorSize })
    }
    return { ok: true, cursorSize: this.cursorSize, pending: true }
  }

  async setCursorState(state, defer = false) {
    this.cursorState = clampStyle(state)
    if (!defer && this.ready && this.proc && this.proc.exitCode === null) {
      return this.request('setCursorStyle', { style: this.cursorState })
    }
    return { ok: true, cursorState: this.cursorState, pending: true }
  }

  async setCursorStyle(state) {
    return this.setCursorState(state)
  }

  async ensure() {
    if (this.quiescing) await this.quiescing
    if (this.stopFailure) throw this.stopFailure
    if (this.disposed) throw Object.assign(new Error('输入连接已关闭；不执行后续动作'), {code:'host-interrupted',partial:'possible'})
    if (this.ready && this.proc && this.proc.exitCode === null) return
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }

  async start() {
    if (this.proc) await this.interrupt('backend-restart', {host:false,fault:true})
    if (this.stopFailure) throw this.stopFailure
    this.stopping = false
    this.ready = false
    this.buf = ''
    this.stderr = ''
    this.readonlyBackend=!!this.control.supportsDual&&!this.control.owner

    const ps = resolvePowerShell()
    const spawnExecutor=this.control.owner&&this.spawnProcess===spawn&&this.control.spawnExecutor?(_file,_args,options)=>this.control.spawnExecutor(options.env):this.spawnProcess
    const proc = await spawnExecutor(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
      '-ExecutionPolicy', 'Bypass', '-File', SIDECAR,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(this.control.executorEnvironment?.()||{}),
        DSH_INPUT_FOCUS_POLICY: this.focusPolicy,
        DSH_INPUT_RUNTIME_VERSION: RUNTIME_VERSION,
        DSH_INPUT_INITIAL_PAUSE_REASON: this.hostPauseReason,
        DSH_INPUT_INITIAL_STOP_JSON: JSON.stringify(this.stops.current||this.control.owner?.stopInfo||null),
        DSH_INPUT_OWNER_JSON: JSON.stringify(this.control.owner||{}),
        DSH_INPUT_INITIAL_FINISHED: this.faulted ? '1' : '0',
        DSH_INPUT_SETTINGS_FILE: this.settingsFile,
        DSH_INPUT_CURSOR_MODE: this.cursorMode,
        DSH_INPUT_CURSOR_HOLD_MS: String(this.cursorHoldMs),
        DSH_INPUT_CURSOR_SIZE: String(this.cursorSize),
        DSH_INPUT_CURSOR_STYLE: this.cursorState,
      },
    })
    this.proc = proc
    proc.stdin.on?.('error',()=>{})
    if(this.control.owner){
      try{
        await this.control.bind(proc.pid)
        if(this.control.startupPermit)proc.stdin.write(JSON.stringify({cmd:'__launch',permit:this.control.startupPermit})+'\n')
      }catch(error){
        // A v3 child is still before compilation/hooks/input until the Job
        // bind succeeds. Close only this uninitialized executor on bind failure.
        const closed=new Promise(resolve=>proc.once('close',resolve))
        proc.stdin.end();try{proc.kill()}catch{}
        await Promise.race([closed,sleep(1500)])
        if(proc.exitCode!==null||proc.signalCode){if(this.proc===proc)this.proc=null}
        else this.stopFailure=Object.assign(new Error('executor-stop-unconfirmed'),{code:'executor-stop-unconfirmed'})
        throw error
      }
    }
    proc.stdin.on?.('error', () => { if(this.proc === proc && !this.stopping) this.interrupt('backend-write-failed', {host:false,fault:true}) })

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this.onData(chunk) })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000)
      this.log(`[sidecar stderr] ${chunk.trim()}`)
    })

    proc.on('error', (error) => {
      if (this.proc !== proc) return
      this.failAll(new Error(`输入 sidecar 启动失败：${error.message}`))
    })
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return
      proc.inputExited = true
      this.ready = false
      const detail = this.stderr ? `\n${this.stderr.slice(-1200)}` : ''
      this.failAll(Object.assign(new Error(`输入executor已exit，等待stdio收尾（code=${code} signal=${signal}）${detail}`),{code:'executor-fault',partial:'possible'}))
      if (!this.stopping) this.interrupt('backend-exit', {host:false,fault:true})
    })
    proc.on('close', () => {
      if (this.proc !== proc) return
      this.ready = false; this.proc = null; this.stopFailure = null
    })

    const started = Date.now()
    while (true) {
      if (this.ready) return
      if (!this.proc || this.proc.exitCode !== null) {
        throw new Error(`输入 sidecar 没起来：${this.stderr.slice(-1500) || '进程已退出'}`)
      }
      if (Date.now() - started > 30000) {
        await this.interrupt('backend-start-timeout', {host:false,fault:true})
        throw new Error(`输入 sidecar 启动超时：${this.stderr.slice(-1500) || '没有收到 ready'}`)
      }
      await sleep(80)
    }
  }

  onData(chunk) {
    this.buf += chunk
    let index
    while ((index = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, index).trim()
      this.buf = this.buf.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log(`[sidecar] 非 JSON 输出：${line.slice(0, 300)}`)
        continue
      }
      if (message.event === 'pause-state') {
        if(message.paused)this.pauseEpoch++
        if (message.paused && !String(message.reason || '').startsWith('backend-')) {this.hostPauseReason=message.reason || 'paused';this.control.pause(this.hostPauseReason,this.stops.record(this.hostPauseReason,this.control.owner,message.stopInfo||null)).catch(error=>this.log(error.message))}
        if(message.stopInfo?.kind==='fault'){this.faulted=true;this.stops.record(message.reason,this.control.owner,message.stopInfo,{fault:true});this.control.recordFault?.(message.stopInfo).catch(error=>this.log(error.message));if(this.control.supportsDual)this.interrupt(message.reason||'backend-controller-fault',{host:false,fault:true})}
        if (!message.paused && !message.transportSealed && !this.stopping && !this.disposed){this.hostPauseReason='';this.stops.resume()}
        continue
      }
      if (message.event === 'ready') {
        if (!this.stopping) this.ready = true
        continue
      }
      if(message.event==='launch-preparation'){
        const pending=this.pending.get(message.id)
        if(pending?.cmd==='shellOpen'&&['indicator-enter','shortcut-prepare','prepared'].includes(message.stage))pending.launchPreparation=Object.fromEntries(['id','stage','utc','ticks','frequency','callerPid','callerBirth','callerThreadId','apartment'].map(k=>[k,message[k]]))
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) {
        const state = message.result?.cursorState
        if (typeof state === 'string' && state) this.cursorState = state
        if (pending.cmd === 'begin') this.faulted = false
        if(pending.cmd==='resume'&&this.pauseEpoch!==pending.pauseEpoch){message.result={...message.result,paused:true,pauseReason:this.hostPauseReason,stopInfo:this.stops.current}}
        if (pending.cmd === 'resume' && !message.result?.paused) this.hostPauseReason = ''
        pending.resolve(message.result)
      } else {
        const error = new Error(message.error || 'sidecar 返回错误')
        if (/message-|PostMessage|ScreenToClient/.test(error.message)) { error.code='native-message-uncertain'; error.partial='possible' }
        if(pending.cmd==='shellOpen'){error.launchStarted=false;error.launchPreparation=pending.launchPreparation}
        pending.reject(error)
      }
    }
  }

  failAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(pending.cmd==='shellOpen'?Object.assign(new Error(error.message),error,{launchStarted:false,launchPreparation:pending.launchPreparation}):error)
    }
    this.pending.clear()
  }

  checkRequestCancelled(context){
    if(!context?.abortSignal?.aborted)return
    if(this.control.owner?.executionId===this.control.executionId(context))this.interrupt('host-cancel',{host:true})
    throw Object.assign(new Error('宿主已取消此请求；未派发后续输入'),{code:'host-interrupted'})
  }
  request(cmd,args={},timeoutMs=30000,trustedContext={}) {
    const context=this.context.getStore()||trustedContext
    if(['ping','status','windows','observe','checkObservation','capture','winInfo','windowAt','uiaInfo','debug'].includes(cmd))return this.requestCore(cmd,args,timeoutMs,context)
    // Finish + release is one controlled queue item. A following request must
    // reacquire inside this queue, even if its tool wrapper already checked.
    const epoch=this.interruptEpoch
    const task=this.controlQueue.then(()=>{if(epoch!==this.interruptEpoch)throw Object.assign(new Error('宿主已中止本批次；未派发排队动作'),{code:'host-interrupted'});return this.requestCore(cmd,args,timeoutMs,context,epoch)})
    this.controlQueue=task.catch(()=>{})
    return task
  }
  async requestCore(cmd, args = {}, timeoutMs = 30000, trustedContext = {}, epoch=this.interruptEpoch) {
    const context=this.context.getStore() || trustedContext
    if(context.actorKind==='manual-preview'&&!['begin','overlay','finish','status','resume'].includes(cmd))throw Object.assign(new Error('手动预览主体仅能预览/收起光标'),{code:'preview-scope-only'})
    const controlled=!['ping','status','windows','observe','checkObservation','capture','winInfo','windowAt','uiaInfo','debug'].includes(cmd)
    if(cmd==='shellOpen'&&!this.control.startLaunch)return {ok:false,opened:false,reason:'async-launch-coordinator-required',inputSent:false}
    if(controlled)this.checkRequestCancelled(context)
    if(controlled){await this.control.acquire(context,['resume','begin'].includes(cmd)?cmd:null);if(this.control.owner?.pauseReason&&!this.hostPauseReason)this.hostPauseReason=this.control.owner.pauseReason;if(this.control.owner?.stopInfo)this.stops.current=this.control.owner.stopInfo}
    if(controlled)this.checkRequestCancelled(context)
    if(controlled&&this.control.owner?.pauseReason&&!['resume','finish','pause'].includes(cmd))return {ok:false,paused:true,reason:'paused',pauseReason:this.control.owner.pauseReason,stopInfo:this.control.owner.stopInfo}
    if(cmd==='status' && !this.proc && !this.starting && !this.disposed && !this.stopFailure) return {ok:true,runtimeVersion:RUNTIME_VERSION,controlProtocolVersion:this.control.supportsDual?3:2,backend:'not-started',paused:!!this.hostPauseReason,pauseReason:this.hostPauseReason,sessionState:this.faulted?'finished':'idle',stopInfo:this.stops.current,lastStop:this.stops.lastStop,control:await this.control.status(this.control.executionId(context))}
    if(controlled&&this.control.supportsDual&&this.readonlyBackend&&this.proc)await this.closeBackendClean()
    await this.ensure()
    if(controlled){this.control.assert(this.control.executionId(context));await this.control.bind(this.proc.pid)}
    const targetCommand=controlled&&this.control.supportsDual&&args.hwnd&&['click','type','key','scroll','drag','bounds','reveal'].includes(cmd)
    if(targetCommand){await this.control.reserve(args.hwnd);await this.control.assertTarget(args.hwnd)}
    if(controlled)this.checkRequestCancelled(context)
    if(controlled&&epoch!==this.interruptEpoch)throw Object.assign(new Error('宿主已中止本批次；未派发动作'),{code:'host-interrupted'})
    const proc=this.proc
    if(!proc || !this.ready || this.stopping) throw Object.assign(new Error('executor中止中，结果可能部分发生；先观察，不重放'),{code:'host-interrupted',partial:'possible'})
    const id = ++this.seq
    const result=await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.interrupt(`backend-timeout:${cmd}`, { host: false, fault: true })
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, cmd, pauseEpoch:this.pauseEpoch,...(cmd==='shellOpen'?{launchPreparation:{id,stage:'prepare-request-dispatched'}}:{}) })
      try {
        proc.stdin.write(`${JSON.stringify({ id, cmd:cmd==='shellOpen'?'prepareLaunch':cmd, ...args, trustedOwnerJson: JSON.stringify(this.control.owner||{}), trustedCaption: typeof context.caption === "string" ? context.caption : "会话名称暂不可用" })}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
    if(cmd==='shellOpen'){
      if(result.ok===false)return result
      try{
        this.checkRequestCancelled(context)
        if(epoch!==this.interruptEpoch||this.hostPauseReason)throw Object.assign(new Error('launch-stopped-before-start'),{code:'host-interrupted'})
        const launch=await this.control.startLaunch({...result.launch,x:args.x,y:args.y,preparation:result.preparation,requestId:id})
        if(epoch!==this.interruptEpoch||this.hostPauseReason)return {...launch,ok:false,paused:!!this.hostPauseReason,reason:'launch-interrupted-result-uncertain'}
        return launch
      }catch(error){await cleanupLaunchTemporary(result.launch?.temporaryPath);throw error}
    }
    if(cmd==='status'){result.runtimeVersion=RUNTIME_VERSION;result.controlProtocolVersion=this.control.supportsDual?3:2;result.control=await this.control.status(this.control.executionId(context));if(this.control.supportsDual)result.screenIndicator={mode:'shared-coordinator',visible:result.control.sharedHeaders?.some(x=>x.visible)||false,snapshots:result.control.sharedHeaders||[],freshness:'last-render-sample'}}
    if(cmd!=='resume'&&this.control.owner?.pauseReason){result.paused=true;result.pauseReason=this.control.owner.pauseReason;result.stopInfo=this.control.owner.stopInfo}
    if(cmd==='resume' && result?.paused===false){await this.control.resume();this.stops.resume()}
    if(cmd==='finish'&&result?.sessionState==='finished')result.completion={source:'manual-tool',reason:'completed',utcTimestamp:new Date().toISOString()}
    if(cmd==='finish' && result?.ok!==false && result?.sessionState==='finished' && result?.paused===false && !this.hostPauseReason){if(this.control.requiresExecutorExit){await this.control.prepareFinish?.(args.resourceYield===true);await this.closeBackendClean()};await this.control.release(this.control.executionId(context))}
    return result
  }

  async closeBackendClean(){
    const proc=this.proc;if(!proc)return
    this.stopping=true
    const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Object.assign(new Error('executor-stop-unconfirmed'),{code:'executor-stop-unconfirmed'})),5000);proc.once('close',()=>{clearTimeout(timer);resolve()})})
    const id=++this.seq
    proc.stdin.write(JSON.stringify({id,cmd:'shutdown'})+'\n')
    await closed;this.readonlyBackend=false;this.stopping=false
  }

  interrupt(reason = 'host-cancel', { host = true, fault = false } = {}) {
    this.interruptEpoch++
    if (host) {this.hostPauseReason = this.hostPauseReason || reason;this.control.pause(this.hostPauseReason,this.stops.record(this.hostPauseReason,this.control.owner)).catch(error=>this.log(error.message))}
    if(fault){this.faulted=true;const info=this.stops.record(reason,this.control.owner,null,{fault:true});this.control.recordFault?.(info).catch(error=>this.log(error.message))}
    const error = Object.assign(new Error(`${reason}：动作结果可能部分发生；已发出旧executor中止请求，先重新观察，禁止自动重放。`), { code: fault ? 'executor-fault' : 'host-interrupted', partial: 'possible' })
    this.failAll(error)
    if (this.quiescing) return this.quiescing
    const proc = this.proc
    this.ready = false
    if (!proc) return Promise.resolve()
    this.stopping = true
    // A dedicated C# reader handles this before the ordinary request queue.
    try { proc.stdin.write(`${JSON.stringify({ cmd: '__interrupt', reason, stopInfo:this.stops.current||this.stops.lastStop })}\n`) } catch {}
    try { proc.stdin.end() } catch {}
    this.quiescing = new Promise(resolve => {
      let timer, verification, exited=false
      const done = () => { exited=true; clearTimeout(timer); clearTimeout(verification); if (this.proc === proc) { this.proc=null; this.ready=false }; this.stopFailure=null; resolve() }
      proc.once('close', done)
      timer=setTimeout(() => {
        if(!proc.inputExited) { try { proc.kill() } catch {} }
        if(exited) return
        verification=setTimeout(() => {
          if(exited) return
          this.stopFailure=Object.assign(new Error('旧executor退出或stdio收尾未证实；停止故障，禁止启动并行executor。'),{code:'executor-stop-unconfirmed',partial:'possible'})
          resolve()
        },300)
      },1200)
    }).finally(() => { this.quiescing = null })
    return this.quiescing
  }

  stop(permanent = true) { if(permanent) this.disposed=true; return this.interrupt('transport-eof', { host: true }) }

}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampSize(size) {
  const n = Number(size)
  if (!Number.isFinite(n) || n === 0) return 0
  return Math.max(24, Math.min(192, Math.round(n)))
}

const STYLES = new Set([
  'pointer', 'work', 'unavailiable', 'link', 'text',
  'cross', 'busy', 'move', 'vert', 'horz',
  'help', 'handwriting', 'dgn1', 'dgn2', 'alternate',
])

function clampStyle(style) {
  const s = String(style || '').toLowerCase()
  return STYLES.has(s) ? s : 'pointer'
}
