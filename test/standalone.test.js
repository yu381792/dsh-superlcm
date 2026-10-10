import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SuperLcmStore} from '../src/store.js'
import {ArchiveDatabase} from '../src/archive-db.js'
import {archiveWork} from '../src/archive-planner.js'
import {defaults,saveSettings,readSettings,settingsDocument} from '../src/settings.js'
import {estimateSummaryTokens} from '../src/summary-tokens.js'
import {readControls} from '../src/controls-config.js'
const fixture=t=>{const dir=mkdtempSync(join(tmpdir(),'dsh-standalone-')),native=new SuperLcmStore(join(dir,'lcm.sqlite')),db=new ArchiveDatabase(native.path);t.after(()=>{db.close();native.close()});return {dir,native,db}}
const event=(seq,type='user/message',data={content:[{type:'text',text:'x'.repeat(4000)}]})=>({seq,type,data,time:1})
test('originals retain exact structured tool content and reject changed histories or gaps',t=>{
 const {db}=fixture(t),header={id:'one'};db.capture(header,[event(0),event(1,'tool/result',{callId:'t',isError:true,content:'literal  \n body'})])
 assert.equal(db.events('one').items.length,2);assert.match(db.events('one').items[1].text,/literal/)
 assert.throws(()=>db.capture(header,[event(3)]),/不连续/);assert.throws(()=>db.capture(header,[event(0,'user/message',{content:'changed'})]),/改变/)
 assert.equal(db.events('one').items.length,2)
})
test('archive planning uses complete tool groups, source pointers and the chosen chunk amount',t=>{
 const {db}=fixture(t);db.capture({id:'one'},[event(0,'tool/call',{id:'call',arguments:'x'.repeat(5000)}),event(1,'tool/result',{callId:'call',content:'done '+ 'y'.repeat(2000)}),event(2)])
 const work=archiveWork(db,'one',{chunkTokens:1000,fanout:4});assert.equal(work.last,1);assert.deepEqual(work.sources,[0,1]);assert.match(work.content,/done/)
})
test('incomplete tools and short fresh content wait without rewriting context',t=>{
 const {db}=fixture(t);db.capture({id:'one'},[event(0,'tool/call',{id:'c',arguments:'x'.repeat(5000)})]);assert.equal(archiveWork(db,'one',{chunkTokens:1000,fanout:4}),null)
})
test('same-session leases prevent duplicate model work and late settings cannot commit',t=>{
 const {db}=fixture(t);db.capture({id:'one'},[event(0),event(1)]);const owner=db.lease('one','r');assert.ok(owner);assert.equal(db.lease('one','r'),null)
 const work=archiveWork(db,'one',{chunkTokens:1000,fanout:4});assert.throws(()=>db.saveNode('one',work,'summary',owner,'r',()=> 'changed'),/变化/)
 db.saveNode('one',work,'summary',owner,'r',()=> 'r');assert.equal(db.nodes('one').length,1)
 db.release('one',owner);assert.ok(db.lease('one','next'))
})
test('short summaries wait for enough adjacent content before a complete merge',t=>{
 const {db}=fixture(t)
 for(let i=0;i<8;i++)db.db.prepare('INSERT INTO sl_nodes VALUES(?,?,?,?,?,?,?,?,?)').run('one','n'+i,0,i,i,'x'.repeat(1000),'[]',JSON.stringify([i]),i)
 const work=archiveWork(db,'one',{chunkTokens:20000,fanout:4});assert.equal(work.level,1);assert.equal(work.children.length,8);assert.deepEqual(work.sources,[0,1,2,3,4,5,6,7])
})
test('settings preserve native defaults, enforce CAS and map one percentage to ratio mode',t=>{
 const {dir}=fixture(t),file=join(dir,'settings.json'),catalog=[{id:'local',models:[{id:'summary'}]}]
 assert.equal(readSettings(file).settings.takeover,false)
 const settings={...defaults,summaryEnabled:true,summaryProvider:'local',summaryModel:'summary',takeover:true,compactionProvider:'local',compactionModel:'summary',compressionRatio:.85}
 const doc=saveSettings({revision:'initial',settings},catalog,file)
 assert.equal(doc.config.budgetMode,'ratio');assert.equal(readControls(file).config.switchRatio,.85);assert.equal(readControls(file).config.prepareRatio,.75)
 assert.throws(()=>saveSettings({revision:'initial',settings},catalog,file),/变化/)
 const raw=readFileSync(file,'utf8');assert.throws(()=>saveSettings({revision:doc.revision,settings:{...settings,summaryModel:'missing'}},catalog,file),/模型/);assert.equal(readFileSync(file,'utf8'),raw)
})
test('source identity and pagination stay isolated across sessions',t=>{
 const {db}=fixture(t);db.capture({id:'one'},[event(0)]);db.capture({id:'two'},[event(0,'user/message',{content:'different'})])
 assert.equal(db.find({session:'one',query:'different'}).items.length,0);assert.equal(db.sessions({limit:1}).hasMore,true);assert.throws(()=>db.events('../secret'),/编号/)
})
test('standalone package has no separate web server or non-DSH entry points',()=>{
 const p=JSON.parse(readFileSync(new URL('../package.json',import.meta.url))),client=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8')
 assert.equal(p.exports['.'],'./src/runtime.js');assert.doesNotMatch(client,/8791|iframe|console\.url|window\.open|fetch\(/)
 assert.doesNotMatch(JSON.stringify(p.exports),/claude|codex|hermes|web/)
})
test('real DSH nested assistant calls and tool results close a complete source group',t=>{
 const {db}=fixture(t)
 db.capture({id:'one'},[
  event(0,'assistant/message',{message:{content:[{type:'tool-call',id:'real',name:'read',arguments:'{}'}]}}),
  event(1,'tool/call',{callId:'real',name:'read',arguments:'{}'}),
  event(2,'tool/result',{message:{toolCallId:'real',content:[{type:'text',text:'x'.repeat(10000)}]}}),
  event(3),event(4)])
 const work=archiveWork(db,'one',{chunkTokens:1000,fanout:4});assert.ok(work);assert.deepEqual(work.sources.slice(0,3),[0,1,2])
})
test('ordinary records close before overflowing the selected source budget',t=>{
 const {db}=fixture(t)
 db.capture({id:'one'},[event(0,'user/message',{content:'a'.repeat(60000)}),event(1,'user/message',{content:'b'.repeat(60000)})])
 const work=archiveWork(db,'one',{chunkTokens:20000,fanout:4});assert.deepEqual(work.sources,[0]);assert.ok(estimateSummaryTokens(work.content)<=20000)
})
test('a database written by the old 0.3 plugin preserves its compaction nodes on upgrade',async t=>{
 const {SuperLcmStore:LegacyStore}=await import('./fixtures/legacy-store-v3.js')
 const dir=mkdtempSync(join(tmpdir(),'sl-legacy-')),path=join(dir,'lcm.sqlite'),old=new LegacyStore(path)
 old.upsertNode({sessionId:'one',nodeId:'old',summaryText:'Old exact decision',summary:[{type:'text',text:'Old exact decision'}],sourceSeqs:[3,5,8],childIds:[],status:'committed'});old.close()
 const current=new SuperLcmStore(path);t.after(()=>current.close())
 const node=current.getNode('one','old');assert.equal(node.summaryText,'Old exact decision');assert.deepEqual(node.sourceSeqs,[3,5,8]);assert.equal(node.kind,null)
 const archive=new ArchiveDatabase(path);t.after(()=>archive.close());archive.capture({id:'one'},[event(0)])
 assert.equal(current.getNode('one','old').summaryText,'Old exact decision')
})
test('re-importing old archives keeps the actual event time instead of making them recent',t=>{
 const {db}=fixture(t);db.capture({id:'old',createdAt:1},[{seq:0,type:'user/message',time:10,data:{content:'old'}}]);db.capture({id:'new',createdAt:20},[{seq:0,type:'user/message',time:30,data:{content:'new'}}]);db.capture({id:'old',createdAt:1},[])
 assert.equal(db.sessions().items[0].id,'new');assert.equal(db.sessions().items[1].updatedAt,10)
})
