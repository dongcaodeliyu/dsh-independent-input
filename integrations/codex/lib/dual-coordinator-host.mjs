// On-demand coordinator independent of any frontend lifetime. No service/task.
import {startDualCoordinator} from './dual-coordinator.js'
const args=process.argv.slice(2);let testNamespace=null,headless=false
for(let i=0;i<args.length;i++){if(args[i]==='--test-namespace')testNamespace=args[++i];else if(args[i]==='--headless-test')headless=true;else throw new Error('unknown coordinator argument')}
if(headless&&!testNamespace)throw new Error('headless seam requires isolated namespace')
await startDualCoordinator({testNamespace,settingsFile:process.env.DSH_INPUT_COORDINATOR_SETTINGS_FILE||'',...(headless?{onMembers:async()=>{},testBackend:true}:{})})
