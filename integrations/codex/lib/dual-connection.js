import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dualCall} from './dual-coordinator.js'
import {dualControlPaths,readDualPersistence} from './dual-persistence.js'
const exec=promisify(execFile),host=fileURLToPath(new URL('./dual-coordinator-host.mjs',import.meta.url))
const runtimeVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version
export function requireCoordinatorRuntime(hello){if(hello.runtimeVersion!==runtimeVersion)throw Object.assign(new Error('coordinator-runtime-mismatch'),{code:'coordinator-runtime-mismatch'})}
export function dualConnection({testNamespace=null,headlessTest=false,settingsFile=''}={}){
  if(headlessTest&&!testNamespace)throw new Error('headless seam requires isolated namespace')
  let pathsPromise,starting,descriptor
  const paths=()=>pathsPromise??=dualControlPaths(testNamespace)
  async function existing(){
    const {metadata}=await paths();let gate
    try{gate=JSON.parse(await readFile(metadata,'utf8'))}catch(error){return error.code==='ENOENT'?{absent:true}:{blocked:true,errorCode:error instanceof SyntaxError?'control-record-invalid-json':error.code||'control-record-read-failed'}}
    if(gate?.protocolVersion===3&&gate.kind==='dual-lane-upgrade-gate'&&typeof gate.endpoint==='string'&&gate.endpoint.startsWith(String.raw`\\.\pipe\dsh-dual-`))return {endpoint:gate.endpoint,gate,metadata}
    const hasIdentity=value=>Number.isSafeInteger(value?.pid)&&value.pid>0&&typeof value.birth==='string'&&/^[0-9]{1,19}$/.test(value.birth)&&BigInt(value.birth)>0n&&BigInt(value.birth)<=3155378975999999999n
    if(gate?.executionId&&hasIdentity(gate)&&(!gate.executor||hasIdentity(gate.executor)))return {legacy:true}
    return {blocked:true,errorCode:gate?.executionId?'legacy-record-identity-incomplete':'control-record-schema-unknown'}
  }
  const connect=async({readonly=false,recover=false}={})=>{
    const observed=await existing();if(observed.endpoint&&!recover){
      try{if(!readonly)requireCoordinatorRuntime(await dualCall(observed.endpoint,{op:'hello'}));descriptor=observed;return observed.endpoint}
      catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error}
    }
    if(readonly){const code=observed.absent?'coordinator-not-started':observed.legacy?'legacy-control-record':observed.errorCode||'control-observation-unavailable';throw Object.assign(new Error(code),{code})}
    if(starting)return starting
    starting=(async()=>{
      await readDualPersistence((await paths()).metadata)
      const proc=spawn(process.execPath,[host,...(testNamespace?['--test-namespace',testNamespace]:[]),...(headlessTest?['--headless-test']:[])],{detached:true,windowsHide:true,stdio:headlessTest?['ignore','ignore','pipe']:'ignore',env:{...process.env,DSH_INPUT_COORDINATOR_SETTINGS_FILE:settingsFile}})
      let exited=false,launchError=null,testError='';if(headlessTest)proc.stderr.on('data',s=>testError=(testError+s).slice(-2000));proc.once('exit',()=>{exited=true});proc.once('error',error=>{launchError=error});proc.unref()
      const deadline=Date.now()+15000
      do{
        const found=await existing()
        if(found.endpoint){try{const hello=await dualCall(found.endpoint,{op:'hello'});if(hello.ok&&hello.generation===found.gate.generation&&hello.coordinatorPid===found.gate.coordinator.pid){requireCoordinatorRuntime(hello);descriptor=found;return found.endpoint}}catch(error){if(error.code==='coordinator-runtime-mismatch')throw error}}
        if(launchError)throw launchError
        if(exited&&!found.endpoint)throw Object.assign(new Error('legacy-or-coordinator-start-blocked'+(headlessTest?' '+testError:'')),{code:'control-busy'})
        await new Promise(r=>setTimeout(r,50))
      }while(Date.now()<deadline)
      throw Object.assign(new Error('coordinator-start-unconfirmed'),{code:'control-busy'})
    })().finally(()=>{starting=null})
    return starting
  }
  connect.inspectRecovery=async id=>{
    const observed=await existing();if(!observed.endpoint)throw new Error('dual-gate-unavailable')
    const inspector=fileURLToPath(new URL('./inspect-dual-gate.ps1',import.meta.url))
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',inspector,'-MetadataPath',observed.metadata],{windowsHide:true})
    const proof=JSON.parse(stdout)
    if(!proof.observedDead||proof.generation!==observed.gate.generation)throw new Error('dual-generation-live-or-unknown')
    const {record,state}=await readDualPersistence(observed.metadata)
    if(record.generation!==observed.gate.generation||JSON.stringify(JSON.parse(await readFile(observed.metadata,'utf8')))!==JSON.stringify(observed.gate))throw new Error('dual-generation-changed')
    state.recoverDeadGeneration();const snapshot=state.snapshot(id)
    return {...snapshot,recoveryRequired:true,observedDead:true,recoveryState:'stopped-generation',occupied:null,availableSlots:null,coordinatorRuntimeVersion:null,pauseReason:snapshot.desktopPaused?record.desktopStop?.reason:snapshot.ownStop&&!snapshot.ownStop.beginRequired?snapshot.ownStop.stopInfo?.reason:null}
  }
  connect.local=()=>descriptor;return connect
}
