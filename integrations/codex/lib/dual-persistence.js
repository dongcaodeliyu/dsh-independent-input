import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {DualLaneState} from './dual-lane-state.js'
const exec=promisify(execFile)
export async function dualControlPaths(testNamespace=null){
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$session=[Diagnostics.Process]::GetCurrentProcess().SessionId;@{sid=$sid;session=$session;localAppData=[Environment]::GetFolderPath('LocalApplicationData')}|ConvertTo-Json -Compress"],{windowsHide:true})
 const value=JSON.parse(stdout),scope=(testNamespace?'test-'+testNamespace+'-':'')+'dsh-independent-input-'+value.sid+'-'+value.session
 return {metadata:join(value.localAppData,'dsh-independent-input-control',...(testNamespace?['tests',testNamespace]:[]),scope+'.json')}
}
const processIdentity=value=>Number.isSafeInteger(value?.pid)&&value.pid>0&&value.pid<=2147483647&&typeof value.birth==='string'&&/^[0-9]{1,19}$/.test(value.birth)&&BigInt(value.birth)>0n&&BigInt(value.birth)<=3155378975999999999n
export function persistedDualState(record,gate){
 if(!record||typeof record!=='object'||['protocolVersion','nextSequence','revision','lanes','tickets','desktopStop','halted','completed'].some(k=>!Object.hasOwn(record,k))||typeof record.generation!=='string'||!record.generation)throw new Error('dual-state-unknown')
 const state=new DualLaneState(record)
 // Only persisted native identities are authority. The pure model may still
 // use actor:null; durable recovery must not manufacture a missing mapping.
 if([...record.lanes,...record.tickets,...Object.values(record.halted)].some(value=>!processIdentity(value.actor)))throw new Error('dual-state-unknown')
 for(const lane of record.lanes)if(!processIdentity(lane.executor)||!Array.isArray(gate?.executors)||!gate.executors.some(value=>value.role==='lane'&&processIdentity(value)&&value.pid===lane.executor.pid&&value.birth===lane.executor.birth))throw new Error('dual-state-unknown')
 return state
}
// No writes or process startup. Stamp is checked again inside the existing
// guardian mutex before it publishes a replacement gate or creates its Job.
export async function readDualPersistence(metadata){
 let bytes,gate=null
 try{gate=JSON.parse(await readFile(metadata,'utf8'))}catch(error){if(error.code!=='ENOENT')throw new Error('dual-state-unknown')}
 try{bytes=await readFile(metadata.replace(/\.json$/,'.v3.json'))}catch(error){if(error.code!=='ENOENT'||gate?.protocolVersion===3)throw new Error('dual-state-unknown');return {record:{},stamp:'absent'}}
 let record,state;try{record=JSON.parse(bytes);state=persistedDualState(record,gate)}catch{throw new Error('dual-state-unknown')}
 if(gate?.protocolVersion===3&&record.generation!==gate.generation)throw new Error('dual-state-generation-mismatch')
 return {record,state,stamp:createHash('sha256').update(bytes).digest('hex')}
}
