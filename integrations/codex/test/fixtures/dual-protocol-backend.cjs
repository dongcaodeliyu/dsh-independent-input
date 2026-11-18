// Owned non-UI protocol fixture. No native APIs, application input or hooks.
const readline=require('node:readline');let launched=process.env.DSH_INPUT_READONLY==='1',observation=null,paused=false
const lines=readline.createInterface({input:process.stdin})
const ready=()=>console.log(JSON.stringify({event:'ready'}))
if(launched)ready()
else console.log('{"event":"bootstrap-waiting"}')
lines.on('line',line=>{const request=JSON.parse(line)
 if(!launched){if(request.cmd!=='__launch'||request.permit!==process.env.DSH_INPUT_STARTUP_PERMIT)process.exit(73);launched=true;ready();return}
 if(request.cmd==='__interrupt'){paused=true;return}
 if(request.cmd==='shutdown'){console.log(JSON.stringify({id:request.id,ok:true,result:{ok:true}}));process.exit(0)}
 if(request.cmd==='stall')return
 let result={ok:true,paused,sessionState:'active'}
 if(request.cmd==='observe'){observation='owned-'+process.pid;result={...result,observationId:observation,hwnd:request.hwnd}}
 if(request.cmd==='type')result={...result,ok:request.observationId===observation,observationId:observation,recipientProcess:process.pid}
 if(request.cmd==='finish')result.sessionState='finished'
 if(request.cmd==='resume'){paused=false;result.paused=false}
 console.log(JSON.stringify({id:request.id,ok:true,result}))
})
