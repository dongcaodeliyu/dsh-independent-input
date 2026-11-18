import { spawn, execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const script=join(dirname(fileURLToPath(import.meta.url)),'control-lease.ps1')
const scope='independent-input: same Windows user and desktop session'
const executeFile=(file,args,options)=>new Promise((resolve,reject)=>{const child=execFile(file,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));child.stdin.end()})
const manualCredential=Symbol('internal settings preview')
export class ControlLease {
  constructor({testNamespace=null}={}){this.testArgs=testNamespace?['-TestNamespace',testNamespace]:[];this.owner=null;this.helper=null;this.waiters=[];this.acquiring=null;this.tickets=new Map()}
  identity(context={},intent=null){return {executionId:this.executionId(context),rootId:context.rootId||null,name:context.name||'会话名称暂不可用',projectId:context.projectId||null,projectName:context.projectName||null,projectPath:context.projectPath||null,projectSource:context.projectSource||'unavailable',actorKind:context.actorKind||'trusted-execution',actorPid:process.pid,intent}}
  async operation(operation,context={},extra={},signal){
    const identity={...this.identity(context),...extra}
    if(operation!=='status'&&!identity.executionId)throw Object.assign(new Error('trusted-execution-required'),{code:'trusted-execution-required'})
    const {stdout}=await executeFile(process.env.DSH_INPUT_POWERSHELL||'powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-Operation',operation,'-OwnerJson',JSON.stringify(identity),'-WaitMs',String(extra.waitMs??45000),...this.testArgs],{windowsHide:true,signal})
    return JSON.parse(stdout.trim())
  }
  async request(context,{signal}={}){
    this.tickets.set(this.executionId(context),context)
    // Settle the atomic enqueue BEFORE cancellation cleanup. Killing the writer
    // first could race a late enqueue after cancel removed its ticket.
    const result=await this.operation('request',context)
    if(signal?.aborted){await this.cancel(context);throw Object.assign(new Error('control-request-cancelled'),{code:'control-request-cancelled'})}
    return result
  }
  async wait(context,{waitMs=45000,signal}={}){this.tickets.set(this.executionId(context),context);try{return await this.operation('wait',context,{waitMs:Math.max(0,Math.min(45000,waitMs))},signal)}catch(error){if(signal?.aborted)await this.cancel(context);throw error}}
  async cancel(context){const result=await this.operation('cancel',context);this.tickets.delete(this.executionId(context));return result}
  async disconnect(){await Promise.allSettled([...this.tickets.values()].map(context=>this.operation('disconnect',context)));this.tickets.clear()}
  async claimReminder(context){return (await this.operation('claim',context)).notice}
  async delivered(context,leaseId){return this.operation('delivered',context,{noticeLeaseId:leaseId})}
  executionId(context){return context?.[manualCredential]===true?context.executionId:context?.threadId}
  manualPreviewContext(){return Object.freeze({[manualCredential]:true,actorKind:'manual-preview',executionId:'manual-preview',name:'本机设置页手动预览',caption:'本机设置页手动预览'})}
  describe(owner,id,reason){const unknown=/unknown|unavailable/.test(reason||'');const busy=unknown?null:!!owner||reason==='control-busy'||reason==='control-paused';return {busy,ownerExecutionId:owner?.executionId||null,ownerRootId:owner?.rootId||null,ownerName:owner?.name||null,scope,canAcquire:!unknown&&(owner?owner.executionId===id:!busy),reason:reason|| (owner?.pauseReason?'control-paused':owner?'control-busy':'available'),pauseReason:owner?.pauseReason||null,externalOfficialState:'unknown',stopInfo:owner?.stopInfo||null,lastStop:owner?.lastStop||this.lastStop||null,lastTransition:owner?.lastTransition||null}}
  async status(id){
    // Conservative metadata observation only; acquisition always uses the kernel mutex.
    try {const result=await this.operation('status',{threadId:id});this.lastStop=result.lastStop||null;return {...this.describe(result.owner,id,result.state==='unknown'?'control-state-unknown':undefined),canAcquire:result.canAcquire,queue:result.queue,position:result.position,turn:result.turn,queueVersion:result.queueVersion,leaseId:result.owner?.leaseId||null,ownerProjectName:result.owner?.projectName||null,ownerProjectId:result.owner?.projectId||null,ownerProjectPath:result.owner?.projectPath||null,ownerProjectSource:result.owner?.projectSource||'unavailable',reminderStatus:result.owner?.reminderStatus||'not-needed'}}catch{return this.describe(null,id,'control-observation-unavailable')}

  }
  async acquire(context={},intent=null) {
    const id=this.executionId(context)
    if(!id)throw Object.assign(new Error('缺少可信执行会话 _meta.threadId；未获取控制权，未派发输入'),{code:'trusted-execution-required'})
    if(this.acquiring)await this.acquiring
    if(this.owner){if(this.owner.executionId===id)return this.describe(this.owner,id,'owned');if(intent==='begin')await this.request(context);const error=this.busy(this.owner,id);error.control=await this.status(id);throw error}
    this.acquiring=this.start(context,intent)
    try{return await this.acquiring}finally{this.acquiring=null}
  }
  busy(owner,id,reason='control-busy'){const control=this.describe(owner,id,reason);return Object.assign(new Error(`控制权由 ${control.ownerName||'会话名称暂不可用'} 占用；未派发输入（${reason}）`),{code:'control-busy',control})}
  async start(context,intent){
    const id=this.executionId(context)
    const owner=this.identity(context,intent)
    const proc=spawn(process.env.DSH_INPUT_POWERSHELL||'powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-OwnerJson',JSON.stringify(owner),...this.testArgs],{windowsHide:true,stdio:['pipe','pipe','pipe']})
    this.boundPid=null;this.helper=proc;let buffer=''
    proc.stdout.setEncoding('utf8');proc.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const waiter=this.waiters.shift();try{waiter?.resolve(JSON.parse(line))}catch(error){waiter?.reject(error)}}})
    const fail=error=>{if(this.helper!==proc)return;for(const waiter of this.waiters.splice(0))waiter.reject(error);if(this.helper===proc){this.helper=null;this.owner=null;this.boundPid=null}}
    proc.stderr.on('data',chunk=>{const error=Object.assign(new Error('控制权守护失败：'+chunk.toString().slice(0,600)),{code:'control-guard-failed'});fail(error);proc.stdin.end()});
    proc.on('error',fail);proc.on('exit',()=>fail(Object.assign(new Error('控制权守护进程已退出；禁止输入'),{code:'control-guard-lost'})));proc.stdin.on('error',()=>{})
    const result=await this.reply()
    if(!result.ok){this.helper=null;proc.stdin.end();const error=this.busy(result.owner,id,result.reason);if(result.queueState){error.control={...error.control,...result.queueState};if(result.queueState.position>0)this.tickets.set(id,context)}throw error}
    this.owner=result.owner;return this.describe(this.owner,id,'owned')
  }
  reply(){return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}))}
  async bind(pid){if(!this.helper||!this.owner)throw new Error('control-guard-lost');const pending=this.reply();this.helper.stdin.write(JSON.stringify({cmd:'bind',pid})+'\n');const result=await pending;if(!result.ok)throw new Error('control-executor-bind-failed');this.boundPid=result.executor}
  async pause(reason,stopInfo=null){if(!this.owner||!this.helper)return;if(!this.owner.pauseReason||(stopInfo?.sessionId&&stopInfo.sessionId===this.owner.stopInfo?.sessionId&&stopInfo.sequence>this.owner.stopInfo.sequence)||(stopInfo?.utcTimestamp&&this.owner.stopInfo?.utcTimestamp&&Date.parse(stopInfo.utcTimestamp)<Date.parse(this.owner.stopInfo.utcTimestamp))){this.owner.pauseReason=stopInfo?.reason||reason;this.owner.stopInfo=stopInfo}const pending=this.reply();this.helper.stdin.write(JSON.stringify({cmd:'pause',reason,stopInfo})+'\n');await pending;this.owner.lastStop=this.owner.stopInfo;this.lastStop=this.owner.lastStop}
  async recordFault(stopInfo){if(!this.owner||!this.helper)return;const pending=this.reply();this.helper.stdin.write(JSON.stringify({cmd:'fault',stopInfo})+'\n');await pending;if(!this.owner.pauseReason){this.lastStop=stopInfo;this.owner.lastStop=stopInfo}this.owner.lastTransition=stopInfo}

  async resume(){if(!this.owner||!this.helper)throw new Error('control-guard-lost');const pending=this.reply();this.helper.stdin.write('{"cmd":"resume"}\n');await pending;this.owner.pauseReason=null;this.owner.stopInfo=null}
  assert(id){if(!this.helper||!this.owner||this.owner.executionId!==id)throw this.busy(this.owner,id)}
  async release(id){this.assert(id);const proc=this.helper;const closed=new Promise(resolve=>proc.once('close',resolve));const pending=this.reply();proc.stdin.write('{"cmd":"release"}\n');const result=await pending;if(!result.ok)throw Object.assign(new Error('全局暂停仍锁定控制权；需原执行会话在用户明确继续后resume'),{code:result.reason});proc.stdin.end();await closed;this.owner=null;this.helper=null;this.boundPid=null}
}
