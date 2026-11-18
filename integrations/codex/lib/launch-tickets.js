import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {unlink} from 'node:fs/promises'
import {dirname,basename,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
const executable=fileURLToPath(new URL('../native/bin/launch-helper.exe',import.meta.url))
export async function cleanupLaunchTemporary(path){
 if(typeof path==='string'&&dirname(resolve(path)).toLowerCase()===resolve(join(tmpdir(),'dsh-independent-input-launch')).toLowerCase()&&/^[a-f0-9]{32}\.lnk$/i.test(basename(path)))await unlink(path).catch(()=>{})
}
export function acceptLaunchStage(t,event){
 const stages=['received','native-enter','native-return']
 if(event.stage!==stages[t.trace.length]||event.helperPid!==t.proc.pid||!/^\d+$/.test(event.helperBirth)||t.helper.birth&&t.helper.birth!==event.helperBirth)throw new Error('invalid-launch-stage')
 const safe={stage:event.stage,utc:event.utc,ticks:event.ticks,frequency:event.frequency,helperPid:event.helperPid,helperBirth:event.helperBirth,threadId:event.threadId,apartment:event.apartment}
 if(event.stage==='received')safe.data={mask:'0x00200140',show:4,cwd:'shell-default'}
 if(event.stage==='native-return')safe.data=Object.fromEntries(['accepted','win32Error','applicationPid','applicationBirth','applicationExited','applicationExitCode'].map(k=>[k,event.data?.[k]??null]))
 t.helper.birth=event.helperBirth;t.lastStage=event.stage;t.trace.push(safe)
 if(event.stage==='native-enter')t.nativeEntered=true
 if(event.stage==='native-return'){t.result=safe.data;t.state=t.cancelled?'unknown':safe.data.accepted===true?'accepted':safe.data.accepted===false?'failed':'unknown'}
}
// OS-created anonymous pipes belong to this fixed child instance. No named
// first-client rendezvous; paths never travel to an unauthenticated peer.
export class LaunchTickets {
 constructor(){this.byExecution=new Map()}
 public(t,{details=false}={}){return {launchTicket:t.id,requestId:t.requestId,launchState:t.state,launchAttempted:t.nativeEntered?true:null,opened:t.result?.accepted===true?true:t.result?.accepted===false?false:null,helper:t.helper,result:t.result||null,lastStage:t.lastStage,...(details?{preparation:t.preparation,trace:t.trace,helperExitCode:t.helperExitCode??null,helperExitedUtc:t.helperExitedUtc||null,cancelRequestedUtc:t.cancelRequestedUtc||null}:{}),acceptedApplicationHealth:'unverified',cancellationEffect:t.cancelled?(t.nativeEntered?'native-call-not-retractable':'helper-stopped-before-confirmed-native-enter'):null}}
 get(owner,id){const t=this.byExecution.get(owner.executionId);if(!t||t.id!==id||t.leaseId!==owner.leaseId)throw Object.assign(new Error('launch-ticket-not-owned'),{code:'launch-ticket-not-owned'});return t}
 status(owner,id,options){return this.public(this.get(owner,id),options)}
 async start(owner,{path,x,y,temporaryPath=null,adaptation=null,preparation=null,requestId=null}){
  const old=this.byExecution.get(owner.executionId)
  if(old?.leaseId===owner.leaseId&&['pending','unknown'].includes(old.state)){await cleanupLaunchTemporary(temporaryPath);return {...this.public(old),reason:old.state==='pending'?'launch-already-pending':'prior-launch-unknown-no-retry'}}
  const t={id:randomUUID(),executionId:owner.executionId,leaseId:owner.leaseId,state:'pending',lastStage:'helper-spawn',trace:[],nativeEntered:false,temporaryPath,adaptation,requestId,preparation:preparation?Object.fromEntries(['id','stage','utc','ticks','frequency','callerPid','callerBirth','callerThreadId','apartment'].map(k=>[k,preparation[k]])):null}
  this.byExecution.set(owner.executionId,t)
  const clean=()=>{if(t.temporaryPath){const path=t.temporaryPath;t.temporaryPath=null;cleanupLaunchTemporary(path)}}
  t.proc=spawn(executable,[],{detached:true,windowsHide:true,stdio:['pipe','pipe','ignore']})
  t.helper={pid:t.proc.pid,birth:null};let buffer=''
  t.proc.stdin.on('error',()=>{if(t.state==='pending')t.state='unknown'})
  t.proc.stdout.setEncoding('utf8')
  t.proc.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{
   const event=JSON.parse(line)
   acceptLaunchStage(t,event)
  }catch{t.state='unknown';t.proc.stdin.end()}}})
  t.proc.on('error',()=>{t.state='failed';t.lastStage='helper-spawn-failed';clean()})
  t.proc.on('close',code=>{t.helperExitCode=code;t.helperExitedUtc=new Date().toISOString();if(t.state==='pending')t.state='unknown';clean()})
  t.proc.stdin.write(JSON.stringify({path,x,y})+'\n')
  return {...this.public(t),managedChromeOcclusion:adaptation}
 }
 async cancel(executionId,reason='input-session-ended'){
  const t=this.byExecution.get(executionId);if(!t||t.state!=='pending')return
  t.cancelled=true;t.cancelReason=reason;t.cancelRequestedUtc=new Date().toISOString();t.state='unknown';t.lastStageBeforeCancel=t.lastStage
  // EOF ends only the exact helper; an accepted app is never killed by PID.
  t.proc.stdin.end()
 }
 async cancelAll(reason){await Promise.all([...this.byExecution.keys()].map(id=>this.cancel(id,reason)))}
}
