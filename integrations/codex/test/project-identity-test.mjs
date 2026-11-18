import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {threadCaption} from '../lib/thread-caption.js'
const dir=await mkdtemp(join(tmpdir(),'project-identity-'))
const databases=[]
let checks=0
const eq=(actual,expected)=>{assert.deepEqual(actual,expected);checks++}
function fixture(file,columns='project_id TEXT,cwd TEXT',projects=true){
 const dbPath=join(dir,file),db=new DatabaseSync(dbPath);databases.push(db)
 db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,source TEXT${columns?','+columns:''})`)
 if(projects)db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT)')
 return {db,dbPath}
}
const parent=id=>JSON.stringify({subagent:{thread_spawn:{parent_thread_id:id}}})
try{
 const anonymous=await threadCaption({caption:'internal settings',name:'internal name',projectId:'spoof',projectName:'spoof',projectPath:'spoof',projectSource:'spoof'})
 eq([anonymous.caption,anonymous.name,anonymous.projectId,anonymous.projectName,anonymous.projectPath,anonymous.projectSource],['internal settings','internal name',null,null,null,'unavailable'])
 const {db,dbPath}=fixture('full.sqlite')
 const put=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)')
 put.run('r1','same chat','secret','"cli"','p1','C:\\main\\alpha')
 put.run('r2','same chat','secret','"cli"','p2','C:\\main\\beta')
 put.run('child','child name','secret',parent('r1'),'fake','C:\\scratch')
 db.prepare('INSERT INTO projects VALUES(?,?)').run('p1','Official Alpha')
 db.prepare('INSERT INTO projects VALUES(?,?)').run('p2','Official Beta')
 let a=await threadCaption({threadId:'child',projectId:'fake',projectName:'fake',cwd:'fake',name:'fake'},{dbPath,now:0})
 eq([a.rootId,a.name,a.projectId,a.projectName,a.projectPath,a.projectSource],['r1','same chat','p1','Official Alpha','C:\\main\\alpha','projects.name'])
 let b=await threadCaption({threadId:'r2'},{dbPath,now:0})
 eq([b.name,b.projectName,b.projectId],['same chat','Official Beta','p2'])
 eq((await threadCaption({threadId:'r1'},{dbPath,now:0})).projectName,a.projectName)
 db.prepare('UPDATE projects SET name=? WHERE id=?').run('Renamed','p1')
 eq((await threadCaption({threadId:'child'},{dbPath,now:14999})).projectName,'Official Alpha')
 eq((await threadCaption({threadId:'child'},{dbPath,now:15000})).projectName,'Renamed')
 for(const [id,source] of [['orphan',parent('missing')],['cycle',parent('cycle')]]){
  put.run(id,'unsafe','secret',source,'p1','C:\\scratch')
  a=await threadCaption({threadId:id,projectName:'spoof'},{dbPath,now:0})
  eq([a.rootId,a.name,a.projectId,a.projectName,a.projectPath,a.projectSource],[null,null,null,null,null,'unavailable'])
 }
 for(let i=0;i<9;i++)put.run('depth'+i,'unsafe','secret',i<8?parent('depth'+(i+1)):'"cli"','p1','C:\\scratch')
 eq((await threadCaption({threadId:'depth0'},{dbPath,now:0})).projectName,null)
 eq((await threadCaption({threadId:'depth1'},{dbPath,now:0})).projectName,'Renamed')
 eq((await threadCaption({threadId:'missing',projectName:'spoof'},{dbPath,now:0})).projectName,null)
 for(const [file,columns,projects,values,expected] of [
  ['no-projects.sqlite','project_id TEXT,cwd TEXT',false,['p','C:\\trusted\\folder'],['p','folder','C:\\trusted\\folder','root-cwd-basename']],
  ['no-id.sqlite','cwd TEXT',true,['/trusted/folder'],[null,'folder','/trusted/folder','root-cwd-basename']],
  ['legacy.sqlite','',false,[],[null,null,null,'unavailable']],
  ['no-cwd.sqlite','project_id TEXT',true,['p'],['p',null,null,'unavailable']],
  ['no-row.sqlite','project_id TEXT,cwd TEXT',true,['p','/trusted/folder'],['p','folder','/trusted/folder','root-cwd-basename']]
 ]){
  const f=fixture(file,columns,projects)
  f.db.prepare(`INSERT INTO threads VALUES(${Array(4+values.length).fill('?').join(',')})`).run('r','preserved','secret','"cli"',...values)
  a=await threadCaption({threadId:'r'},{dbPath:f.dbPath,now:0})
  eq(a.name,'preserved');eq([a.projectId,a.projectName,a.projectPath,a.projectSource],expected)
 }
 // Preserve the existing cache size boundary: size 129 clears on next insertion.
 for(let i=0;i<130;i++)await threadCaption({threadId:'absent'+i},{dbPath,now:0})
 db.prepare('UPDATE projects SET name=? WHERE id=?').run('After Clear','p1')
 eq((await threadCaption({threadId:'child'},{dbPath,now:1})).projectName,'After Clear')
 console.log(`PASS project identity: ${checks} assertions; root/child, same-name projects, optional schemas, trust boundaries, depth/cycle/missing parent, TTL and cache capacity`)
}finally{for(const db of databases)db.close();await rm(dir,{recursive:true,force:true})}
