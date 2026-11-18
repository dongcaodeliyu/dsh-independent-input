import {AsyncLocalStorage} from 'node:async_hooks'
import {InputEngine} from './engine.js'
import {DualControlLease} from './dual-control-lease.js'
import {dualConnection} from './dual-connection.js'
// One observed state, native backend and cancellation domain per trusted
// execution. Global desktop scheduling lives in the coordinator, not this pool.
export class ExecutionEnginePool {
  constructor(options={}){
    this.context=new AsyncLocalStorage();this.options={...options};this.engines=new Map()
    this.connection=options.connection||dualConnection({settingsFile:options.settingsFile})
    this.credentials=new DualControlLease({connection:this.connection})
    const selected=context=>this.engineFor(this.credentials.executionId(context||this.context.getStore())||'readonly-global')
    const pool=this
    this.control=new Proxy({}, {get(_target,key){
      if(key==='manualPreviewContext'||key==='executionId')return pool.credentials[key].bind(pool.credentials)
      if(key==='status')return id=>pool.engineFor(id||'readonly-global').control.status(id)
      if(['acquire','request','wait','cancel','claimReminder','delivered'].includes(key))return (context,...args)=>selected(context).control[key](context,...args)
      if(key==='disconnect')return ()=>Promise.allSettled([...pool.engines.values()].map(x=>x.control.disconnect()))
      const value=selected().control[key];return typeof value==='function'?value.bind(selected().control):value
    }})
    return new Proxy(this,{get(target,key,receiver){
      if(key in target)return Reflect.get(target,key,receiver)
      const engine=selected(),value=engine[key];return typeof value==='function'?value.bind(engine):value
    },set(target,key,value,receiver){if(key in target)return Reflect.set(target,key,value,receiver);selected()[key]=value;return true}})
  }
  engineFor(executionId){
    if(!this.engines.has(executionId)){const engine=new InputEngine({...this.options,controlLease:new DualControlLease({connection:this.connection})});engine.context=this.context;this.engines.set(executionId,engine)}
    return this.engines.get(executionId)
  }
  cancelRequest(context){const id=this.credentials.executionId(context),engine=this.engines.get(id);if(engine?.control.owner?.executionId===id)return engine.interrupt('host-cancel',{host:true})}
  async stop(permanent=true){return Promise.allSettled([...this.engines.values()].map(x=>x.stop(permanent)))}
  async interrupt(reason,options){const id=this.credentials.executionId(this.context.getStore());if(id)return this.engineFor(id).interrupt(reason,options);return Promise.allSettled([...this.engines.values()].map(x=>x.interrupt(reason,options)))}
  async setCursorMode(mode,holdMs,defer){const id=this.credentials.executionId(this.context.getStore());if(id)return this.engineFor(id).setCursorMode(mode,holdMs,defer);this.options.cursorMode=mode;this.options.cursorHoldMs=holdMs;const results=await Promise.all([...this.engines.values()].map(x=>x.setCursorMode(mode,holdMs,defer)));return results[0]||{cursorMode:mode,cursorHoldMs:holdMs}}
  async setCursorSize(size,defer){const id=this.credentials.executionId(this.context.getStore());if(id)return this.engineFor(id).setCursorSize(size,defer);this.options.cursorSize=size;const results=await Promise.all([...this.engines.values()].map(x=>x.setCursorSize(size,defer)));return results[0]||{cursorSize:size}}
  async setCursorState(style,defer){const id=this.credentials.executionId(this.context.getStore());if(id)return this.engineFor(id).setCursorState(style,defer);this.options.cursorState=style;return {cursorState:style}}
}
