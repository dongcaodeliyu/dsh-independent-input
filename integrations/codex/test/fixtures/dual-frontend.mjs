// Actual production connection wrapper, isolated namespace/headless UI seam.
import {InputEngine} from '../../lib/engine.js'
import {DualControlLease} from '../../lib/dual-control-lease.js'
import {dualConnection} from '../../lib/dual-connection.js'
const [namespace,id]=process.argv.slice(2),context={threadId:id,name:'owned frontend '+id}
const connection=dualConnection({testNamespace:namespace,headlessTest:true})
const engine=new InputEngine({controlLease:new DualControlLease({connection})})
await engine.request('begin',{},30000,context)
await engine.control.invoke('monitor',context,{device:'OWNED-TEST-SCREEN',x:10,y:20})
const descriptor=connection.local()
process.send({ready:true,pid:process.pid,backendPid:engine.proc.pid,endpoint:descriptor.endpoint,metadata:descriptor.metadata,coordinatorPid:descriptor.gate.coordinator.pid})
process.on('message',async message=>{try{if(message.op==='exit'){await engine.stop();process.exit(0)}const result=await engine.request(message.op,{},30000,context);process.send({id:message.id,result})}catch(error){process.send({id:message.id,error:error.message})}})
