import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
const {threadCaption}=await import(process.argv[2]?pathToFileURL(resolve(process.argv[2])).href:'../lib/thread-caption.js')
const directory=await mkdtemp(join(tmpdir(),'thread-caption-')),dbPath=join(directory,'state_5.sqlite')
const db=new DatabaseSync(dbPath)
try{
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,source TEXT)')
 const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?)')
 insert.run('root','实际侧栏名称','原始长prompt不应显示','"cli"')
 insert.run('child','','child prompt',JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'root'}}}))
 let value=await threadCaption({threadId:'child'},{dbPath,now:1000})
 assert.equal(value.rootId,'root');assert.equal(value.name,'实际侧栏名称');assert.match(value.caption,/实际侧栏名称/);assert.doesNotMatch(value.caption,/child|执行:/);assert.doesNotMatch(value.caption,/prompt/)
 db.prepare('UPDATE threads SET name=? WHERE id=?').run('重命名后','root')
 assert.equal((await threadCaption({threadId:'child'},{dbPath,now:2000})).name,'实际侧栏名称')
 assert.equal((await threadCaption({threadId:'child'},{dbPath,now:17000})).name,'重命名后')
 insert.run('orphan','子会话自己的name','private prompt',JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'unreadable-parent'}}}))
 value=await threadCaption({threadId:'orphan'},{dbPath,now:1000});assert.equal(value.name,null);assert.equal(value.rootId,null);assert.equal(value.caption,'会话名称暂不可用')
 insert.run('cycle','','private prompt',JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'cycle'}}}))
 value=await threadCaption({threadId:'cycle'},{dbPath,now:1000});assert.equal(value.name,null);assert.equal(value.caption,'会话名称暂不可用')
 value=await threadCaption({threadId:'unknown'},{dbPath:join(directory,'missing.sqlite')});assert.equal(value.caption,'会话名称暂不可用')
 assert.equal((await threadCaption({caption:'untrusted',name:'fake'})).threadId,undefined)
 console.log('PASS real SQLite WAL readonly: lowercase trusted parent chain, sidebar name precedence, rename TTL, cycle/missing DB fallback, no prompt leakage')
}finally{db.close();await rm(directory,{recursive:true,force:true})}
