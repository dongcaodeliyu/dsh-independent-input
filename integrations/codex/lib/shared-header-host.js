import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
const sidecar=fileURLToPath(new URL('../sidecar.ps1',import.meta.url))
// One process/UI thread owns all screen headers; lane backends own cursors only.
export class SharedHeaderHost {
  constructor({guardian,settingsFile='',onStop=()=>{},onFault=()=>{},spawnProcess=spawn}){this.guardian=guardian;this.settingsFile=settingsFile;this.onStop=onStop;this.onFault=onFault;this.spawnProcess=spawnProcess;this.proc=null;this.pending=new Map();this.sequence=0;this.starting=null;this.healthy=false;this.normalClosing=false;this.commands=Promise.resolve();this.closingRequested=false}
  async start(){
    if(this.starting)return this.starting;if(this.proc&&this.healthy)return
    this.normalClosing=false
    this.starting=(async()=>{
      const permit=randomUUID(),proc=this.spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-STA','-File',sidecar],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DSH_INPUT_STARTUP_PERMIT:permit,DSH_INPUT_HEADER_HOST:'1',DSH_INPUT_READONLY:'0',DSH_INPUT_EXTERNAL_HEADERS:'0',DSH_INPUT_SETTINGS_FILE:this.settingsFile}})
      this.proc=proc;let buffer=''
      const closed=new Promise(resolve=>proc.once('close',resolve))
      const ready=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('shared-header-start-timeout')),30000)
        proc.stdout.setEncoding('utf8');proc.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let value;try{value=JSON.parse(line)}catch{continue}
          if(value.event==='ready'){clearTimeout(timer);resolve()}
          else if(value.event==='pause-state'&&value.paused&&['keyboard-hook','keyboard-hotkey'].includes(value.stopInfo?.source))this.onStop(value.stopInfo)
          else if(value.id){const waiter=this.pending.get(value.id);if(waiter){this.pending.delete(value.id);clearTimeout(waiter.timer);value.ok?waiter.resolve(value.result):waiter.reject(new Error('shared-header-command-failed'))}}
        }})
        proc.on('error',reject);proc.on('close',()=>{clearTimeout(timer);const current=this.proc===proc,unexpected=current&&this.healthy&&!this.normalClosing;if(current){this.healthy=false;this.proc=null};for(const waiter of this.pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('shared-header-exited'))};this.pending.clear();reject(new Error('shared-header-exited-before-ready'));if(unexpected)this.onFault({kind:'fault',source:'backend-exit',reason:'backend-controller-surface-exit',utcTimestamp:new Date().toISOString()})})
      })
      proc.stderr.on('data',()=>{});proc.stdin.on('error',()=>{})
      try{const bound=await this.guardian.call({cmd:'bind',pid:proc.pid,role:'header'});if(!bound.ok)throw new Error(bound.reason);proc.stdin.write(JSON.stringify({cmd:'__launch',permit})+'\n');await ready
        const deadline=Date.now()+1500;let status
        do{status=await this.sendReady('status');if(status.escapeHookRegistered)break;await new Promise(r=>setTimeout(r,25))}while(Date.now()<deadline)
        if(!status.escapeHookRegistered)throw new Error('desktop-stop-hook-unavailable')
        this.healthy=true
      }catch(error){proc.stdin.end();proc.kill();await closed;await ready.catch(()=>{});throw error}
    })().finally(()=>{this.starting=null});return this.starting
  }
  async send(cmd,args={}){if(this.closingRequested)throw new Error('shared-header-closing');const result=this.commands.then(async()=>{await this.start();return this.sendReady(cmd,args)});this.commands=result.catch(()=>{});return result}
  async sendReady(cmd,args={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('shared-header-response-timeout'))},3000);this.pending.set(id,{resolve,reject,timer});this.proc.stdin.write(JSON.stringify({id,cmd,...args})+'\n')})}
  async update(members,activeLane=false,anyRunningLane=activeLane){
    const screens=[]
    for(const [device,lanes] of Object.entries(members)){
      const point=lanes.find(lane=>lane.point)?.point
      if(!point)continue
      const paused=lanes.every(lane=>lane.paused)
      const notice=lanes.length===1&&lanes[0].notice===true
      const indicator=paused?(notice?lanes[0].indicator:lanes.find(lane=>lane.indicator==='user-stopped')?.indicator):null
      screens.push({device,x:point.x,y:point.y,paused,...(indicator?{indicator,notice}:{})})
    }
    if(!activeLane&&!screens.length&&!this.proc)return
    const result=await this.send('sharedHeaders',{screens,activeLane,anyRunningLane})
    if(!result?.ok)throw new Error('shared-header-render-failed')
    this.lastDiagnostics=result.sharedHeaders||[]
  }
  async close(){this.closingRequested=true;const result=this.commands.then(async()=>{if(this.starting)await this.starting.catch(()=>{});this.normalClosing=true;if(!this.proc)return;const proc=this.proc,closed=new Promise(resolve=>proc.once('close',resolve));await this.sendReady('shutdown');await closed});this.commands=result.catch(()=>{});return result}
}
