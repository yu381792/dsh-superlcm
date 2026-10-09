import {DatabaseSync} from 'node:sqlite'
import {createHash,randomUUID} from 'node:crypto'
import {estimateSummaryTokens} from './summary-tokens.js'
import {isCompactCheckpointSource} from '@deepseek-ai/dsh-compaction'
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x
const hash=x=>createHash('sha256').update(x).digest('hex')
// Storage versions describe the encoding, not the conversation identity. Older
// live headers can also omit the preset later supplied by the durable backend.
// Accept only that missing annotation; conflicting presets and provenance stay
// protected by the same identity check as before.
export function archiveHeader(previous,header) {
  const incoming={...header,delegationDepth:header.delegationDepth??0}
  if(!previous)return canonical(incoming)
  const before={...previous,delegationDepth:previous.delegationDepth??0},after={...incoming}
  delete before.version;delete after.version
  if(before.agentPreset===undefined&&typeof after.agentPreset==='string')before.agentPreset=after.agentPreset
  if(after.agentPreset===undefined&&typeof before.agentPreset==='string')after.agentPreset=before.agentPreset
  if(JSON.stringify(canonical(before))!==JSON.stringify(canonical(after)))throw Error('会话来源身份改变，原记录保留')
  return canonical({...previous,...incoming,...(incoming.agentPreset===undefined&&previous.agentPreset!==undefined?{agentPreset:previous.agentPreset}:{})})
}
export const sessionId=id=>{if(typeof id!=='string'||!/^[\w.-]{1,190}$/.test(id))throw Error('会话编号无效');return id}
export const offset=value=>{if(value===undefined)return 0;if(!Number.isSafeInteger(value)||value<0)throw Error('分页位置无效');return value}
export const limit=(value=30,max=100)=>{if(!Number.isSafeInteger(value)||value<1||value>max)throw Error('分页大小无效');return value}
export function original(event) {
  return ['user/message','assistant/message','tool/call','tool/result'].includes(event.type)&&!(event.type==='user/message'&&event.data?.source&&isCompactCheckpointSource(event.data.source))
}
const node=row=>({...row,children:JSON.parse(row.children),sources:JSON.parse(row.sources)})
export class ArchiveDatabase {
  constructor(path) {
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sl_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,header TEXT NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sl_events(session TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,digest TEXT NOT NULL,text TEXT NOT NULL,tokens INTEGER NOT NULL,original INTEGER NOT NULL,PRIMARY KEY(session,seq));
      CREATE INDEX IF NOT EXISTS sl_events_original ON sl_events(session,original,seq);
      CREATE TABLE IF NOT EXISTS sl_nodes(session TEXT NOT NULL,id TEXT NOT NULL,level INTEGER NOT NULL,first INTEGER NOT NULL,last INTEGER NOT NULL,summary TEXT NOT NULL,children TEXT NOT NULL,sources TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(session,id));
      CREATE INDEX IF NOT EXISTS sl_nodes_level ON sl_nodes(session,level,first);
      CREATE TABLE IF NOT EXISTS sl_jobs(session TEXT PRIMARY KEY,owner TEXT NOT NULL,revision TEXT NOT NULL,expires INTEGER NOT NULL,retry INTEGER NOT NULL DEFAULT 0);
    `)
  }
  capture(header,events) {
    const id=sessionId(header.id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior=this.db.prepare('SELECT header,title,updatedAt FROM sl_sessions WHERE id=?').get(id)
      const identity=JSON.stringify(archiveHeader(prior?JSON.parse(prior.header):null,header))
      let title=prior?.title||header.meta?.title||header.title||id
      let next=this.cursor(id),updatedAt=prior?.updatedAt??header.createdAt??0
      for(const event of events){if(Number.isFinite(event.time))updatedAt=Math.max(updatedAt,event.time);if(!Number.isSafeInteger(event.seq)||event.seq<0)throw Error('原文序号无效')
        if(event.type==='session/title'&&typeof event.data?.title==='string')title=event.data.title
        const raw=JSON.stringify(event),digest=hash(JSON.stringify(canonical(event))),saved=this.db.prepare('SELECT digest FROM sl_events WHERE session=? AND seq=?').get(id,event.seq)
        if(saved&&saved.digest!==digest)throw Error('原文已改变，拒绝覆盖归档')
        if(!saved){if(event.seq!==next)throw Error('原文序号不连续，拒绝遗漏归档');this.db.prepare('INSERT INTO sl_events VALUES(?,?,?,?,?,?,?)').run(id,event.seq,raw,digest,raw,estimateSummaryTokens(raw),+original(event));next++}
      }
      this.db.prepare('INSERT INTO sl_sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,header=excluded.header,updatedAt=excluded.updatedAt').run(id,String(title).slice(0,300),identity,updatedAt)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  cursor(id){return (this.db.prepare('SELECT MAX(seq) AS seq FROM sl_events WHERE session=?').get(sessionId(id)).seq??-1)+1}
  sessions({query='',offset:from=0,limit:count=30}={}) {
    if(typeof query!=='string'||query.length>500)throw Error('搜索内容无效')
    const rows=this.db.prepare(`SELECT s.id,s.title,s.updatedAt,(SELECT COUNT(*) FROM sl_events e WHERE e.session=s.id) eventCount,(SELECT COUNT(*) FROM sl_nodes n WHERE n.session=s.id) summaryCount FROM sl_sessions s WHERE instr(lower(s.title),lower(?))>0 ORDER BY s.updatedAt DESC LIMIT ? OFFSET ?`).all(query,limit(count)+1,offset(from))
    return {items:rows.slice(0,count),hasMore:rows.length>count}
  }
  events(id,from=0,count=20){const rows=this.db.prepare('SELECT seq,event FROM sl_events WHERE session=? AND seq>=? ORDER BY seq LIMIT ?').all(sessionId(id),offset(from),limit(count)+1);return {items:rows.slice(0,count).map(x=>({seq:x.seq,type:JSON.parse(x.event).type,text:x.event})),next:rows.length>count?rows[count].seq:null}}
  sourceRows(id,from=0){return this.db.prepare('SELECT seq AS ordinal,seq,event,text,tokens FROM sl_events WHERE session=? AND seq>=? AND original=1 ORDER BY seq').all(sessionId(id),offset(from))}
  nodes(id,level){return this.db.prepare('SELECT * FROM sl_nodes WHERE session=?'+(level===undefined?'':' AND level=?')+' ORDER BY first,createdAt').all(...(level===undefined?[sessionId(id)]:[sessionId(id),level])).map(node)}
  outline(id){const nodes=this.nodes(id),covered=new Set(nodes.filter(n=>n.level===0).flatMap(n=>n.sources)),rows=this.sourceRows(id),s=this.db.prepare('SELECT title FROM sl_sessions WHERE id=?').get(id);return {session:id,title:s?.title||id,nodes,total:rows.length,uncovered:rows.filter(e=>!covered.has(e.seq)).length}}
  find({session,query,offset:from=0,limit:count=20}={}){if(typeof query!=='string'||!query.trim()||query.length>500)throw Error('请输入搜索内容');const args=session?[sessionId(session),query,limit(count)+1,offset(from)]:[query,limit(count)+1,offset(from)];const rows=this.db.prepare('SELECT session,seq,text FROM sl_events WHERE '+(session?'session=? AND ':'')+'instr(lower(text),lower(?))>0 ORDER BY session,seq LIMIT ? OFFSET ?').all(...args);return {items:rows.slice(0,count),next:rows.length>count?from+count:null}}
  lease(id,revision){const owner=randomUUID(),now=Date.now();const row=this.db.prepare(`INSERT INTO sl_jobs(session,owner,revision,expires) VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET owner=excluded.owner,revision=excluded.revision,expires=excluded.expires WHERE sl_jobs.expires<? AND sl_jobs.retry<=? RETURNING owner`).get(sessionId(id),owner,revision,now+45000,now,now);return row?.owner===owner?owner:null}
  renew(id,owner){return this.db.prepare('UPDATE sl_jobs SET expires=? WHERE session=? AND owner=?').run(Date.now()+45000,id,owner).changes===1}
  release(id,owner,failed=false){this.db.prepare('UPDATE sl_jobs SET expires=0,retry=? WHERE session=? AND owner=?').run(failed?Date.now()+60000:0,id,owner)}
  saveNode(id,work,summary,owner,revision,currentRevision){this.db.exec('BEGIN IMMEDIATE');try{const job=this.db.prepare('SELECT * FROM sl_jobs WHERE session=?').get(id);if(job?.owner!==owner||job.expires<Date.now()||job.revision!==revision||currentRevision()!==revision)throw Error('摘要设置或任务已变化')
      this.db.prepare('INSERT INTO sl_nodes VALUES(?,?,?,?,?,?,?,?,?)').run(id,work.id,work.level,work.first,work.last,summary,JSON.stringify(work.children),JSON.stringify(work.sources),Date.now());this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}}
  close(){this.db.close()}
}
