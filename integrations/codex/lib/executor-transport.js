// Internal per-lane stdio relay. Only the independent coordinator spawns the
// fixed PowerShell executor, so all workers share its Job ancestry.
import {createServer,createConnection} from 'node:net'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {PassThrough,Writable} from 'node:stream'
export async function launchExecutor({script,env}){
  const endpoint=String.raw`\\.\pipe\dsh-executor-`+randomUUID(),token=randomUUID()
  const proc=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env})
  let socket=null,closed=false,queue=[],connected=false
  const send=value=>{if(socket&&!socket.destroyed){if(!socket.write(JSON.stringify(value)+'\n')){proc.stdout.pause();proc.stderr.pause()}}else queue.push(value)}
  proc.stdout.on('data',data=>send({stream:'stdout',data:data.toString('base64')}));proc.stderr.on('data',data=>send({stream:'stderr',data:data.toString('base64')}));proc.stdin.on('error',()=>{})
  proc.on('error',error=>send({error:error.code||'executor-launch-error'}))
  proc.on('exit',(code,signal)=>send({event:'exit',code,signal}))
  proc.on('close',(code,signal)=>{closed=true;send({event:'close',code,signal});if(socket)socket.end();server.close()})
  const server=createServer(client=>{if(connected){client.destroy();return};let buffer='',authorized=false;client.setEncoding('utf8');client.on('error',()=>{});client.on('close',()=>{if(authorized){proc.stdin.end();if(!closed)proc.kill()}});client.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let message;try{message=JSON.parse(line)}catch{client.destroy();return}
    if(!authorized){if(message.token!==token){client.destroy();return};authorized=true;connected=true;socket=client;proc.stdin.on('drain',()=>client.resume());client.on('drain',()=>{proc.stdout.resume();proc.stderr.resume()});for(const value of queue)send(value);queue=[];if(closed)client.end();continue}
    if(message.stdin&&!proc.stdin.write(Buffer.from(message.stdin,'base64')))client.pause();if(message.end)proc.stdin.end();if(message.kill)proc.kill()
  }})})
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve)})}catch(error){proc.stdin.end();proc.kill();server.close();throw error}
  // An unused transport cannot leave a waiting executor/server forever. This
  // is startup cleanup, never expiry of an active lease or a live holder.
  const timer=setTimeout(()=>{if(!connected){proc.stdin.end();proc.kill();server.close()}},15000);timer.unref();proc.once('close',()=>clearTimeout(timer))
  return {pid:proc.pid,endpoint,token}
}
export async function connectExecutor(descriptor){
  const socket=createConnection(descriptor.endpoint),proc=new EventEmitter();proc.pid=descriptor.pid;proc.exitCode=null;proc.signalCode=null;proc.on('error',()=>{});proc.stdout=new PassThrough();proc.stderr=new PassThrough()
  proc.stdin=new Writable({write(chunk,_encoding,done){socket.write(JSON.stringify({stdin:Buffer.from(chunk).toString('base64')})+'\n',done)},final(done){socket.write('{"end":true}\n',done)}})
  proc.kill=()=>{if(!socket.destroyed)socket.write('{"kill":true}\n');return true}
  let buffer='',ended=false
  socket.setEncoding('utf8');socket.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const value=JSON.parse(line);if(value.stream&&!proc[value.stream].write(Buffer.from(value.data,'base64')))socket.pause();if(value.error)proc.emit('error',new Error(value.error));if(value.event==='exit'){proc.exitCode=value.code;proc.signalCode=value.signal;proc.emit('exit',value.code,value.signal)}if(value.event==='close'){ended=true;proc.stdout.end();proc.stderr.end();proc.emit('close',value.code,value.signal);socket.end()}}})
  proc.stdout.on('drain',()=>socket.resume());proc.stderr.on('drain',()=>socket.resume())
  socket.on('error',error=>{if(proc.listenerCount('error'))proc.emit('error',error)});socket.on('close',()=>{if(!ended){proc.stdout.end();proc.stderr.end();proc.emit('exit',null,'transport-lost');proc.emit('close',null,'transport-lost')}})
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)});socket.write(JSON.stringify({token:descriptor.token})+'\n');return proc
}
