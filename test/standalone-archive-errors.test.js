import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ArchiveDatabase} from '../src/archive-db.js'
import {archiveDiagnostic} from '../src/archive-diagnostic.js'
const event=(seq,text='source')=>({seq,type:'user/message',time:seq,data:{content:text}})
test('legacy live headers can resume from durable headers without abandoning the original tail',t=>{
  const db=new ArchiveDatabase(join(mkdtempSync(join(tmpdir(),'sl-header-')),'archive.sqlite'));t.after(()=>db.close())
  const legacy={id:'legacy',createdAt:1,cwd:'/project',isSeeded:false}
  db.capture(legacy,[event(0)])
  const durable={...legacy,version:4,delegationDepth:0,agentPreset:'PI-BOTH'}
  db.capture(durable,[event(1)])
  assert.equal(db.cursor('legacy'),2)
  assert.deepEqual(JSON.parse(db.db.prepare('SELECT header FROM sl_sessions WHERE id=?').get('legacy').header),durable)
  db.capture(legacy,[event(2)])
  assert.equal(db.cursor('legacy'),3)
  assert.equal(JSON.parse(db.db.prepare('SELECT header FROM sl_sessions WHERE id=?').get('legacy').header).agentPreset,'PI-BOTH')
  for(const changed of [{...durable,cwd:'/other'},{...durable,createdAt:2},{...durable,agentPreset:'other'},{...durable,origin:'subagent'}])assert.throws(()=>db.capture(changed,[event(3)]),/来源身份改变/)
  assert.throws(()=>db.capture(durable,[event(0,'changed')]),/原文已改变/)
  assert.equal(db.cursor('legacy'),3)
})
test('storage encoding changes are metadata while original event digests remain immutable',t=>{
  const db=new ArchiveDatabase(join(mkdtempSync(join(tmpdir(),'sl-version-')),'archive.sqlite'));t.after(()=>db.close())
  db.capture({id:'one',createdAt:1,version:3},[event(0)])
  db.capture({id:'one',createdAt:1,version:4},[event(0),event(1)])
  assert.equal(db.cursor('one'),2)
  assert.throws(()=>db.capture({id:'one',createdAt:1,version:4,parentSession:'different'},[event(2)]),/来源身份改变/)
})
test('background diagnostics distinguish causes without disclosing raw errors',()=>{
  const error=Object.assign(new Error('secret-token https://private.example/?token=unsafe'),{status:401})
  const diagnostic=archiveDiagnostic(error,{stage:'summary',session:'one'})
  assert.equal(diagnostic.code,'HTTP_401');assert.match(diagnostic.message,/认证失败/)
  assert.doesNotMatch(JSON.stringify(diagnostic),/secret-token|private.example|unsafe/)
  assert.equal(archiveDiagnostic(Error('会话来源身份改变，原记录保留')).code,'HEADER_IDENTITY')
  assert.equal(archiveDiagnostic(Error('Summary exceeds 6000 characters')).code,'SUMMARY_TOO_LONG')
  assert.equal(archiveDiagnostic(Error('Summary generation was incomplete')).code,'SUMMARY_INCOMPLETE')
  const legacy=Object.assign(Error('migration incomplete private source content'),{name:'SessionFormatUnsupportedError'})
  assert.equal(archiveDiagnostic(legacy).code,'LEGACY_FORMAT')
  assert.doesNotMatch(JSON.stringify(archiveDiagnostic(legacy)),/private source content/)
  assert.equal(archiveDiagnostic(Object.assign(Error('incomplete private provider body'),{status:401}),{stage:'summary'}).code,'HTTP_401')
  for(const [kind,code] of [['stream_empty','SUMMARY_STREAM_EMPTY'],['stream_cutoff','SUMMARY_STREAM_CUTOFF']]){
   const value=archiveDiagnostic(Object.assign(Error('SECRET SOURCE'),{summaryKind:kind}),{stage:'summary'})
   assert.equal(value.code,code);assert.doesNotMatch(value.message,/SECRET/)
  }
})
