import {DatabaseSync} from 'node:sqlite'
import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {resolveDatabasePath} from './store.js'
import {controlsConfig} from './controls-config.js'
import {automaticRatios} from './ratio-policy.js'
export const defaults=Object.freeze({summaryEnabled:false,summaryProvider:'',summaryModel:'',chunkTokens:20000,fanout:4,takeover:false,compactionProvider:'',compactionModel:'',compressionRatio:.8,compressionChunkTokens:20000})
export const settingsPath=()=>join(dirname(resolveDatabasePath()),'settings.json')
const integer=(value,min,max,label)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(label+'无效');return value}
export function validateSettings(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('设置格式无效')
  const out={...defaults,...input}
  for(const key of ['summaryEnabled','takeover'])if(typeof out[key]!=='boolean')throw Error('开关无效')
  for(const key of ['summaryProvider','summaryModel','compactionProvider','compactionModel'])if(typeof out[key]!=='string'||out[key].length>200)throw Error('模型选择无效')
  for(const key of ['chunkTokens','compressionChunkTokens']){integer(out[key],1000,4000000,'摘要分块');if(out[key]%1000)throw Error('摘要分块请输入整数 K')}
  integer(out.fanout,2,100,'合并段数');automaticRatios(out.compressionRatio)
  if(Math.abs(out.compressionRatio*100-Math.round(out.compressionRatio*100))>1e-8)throw Error('压缩比例请输入整数百分比')
  if(out.summaryEnabled&&(!out.summaryProvider||!out.summaryModel)||out.takeover&&(!out.compactionProvider||!out.compactionModel))throw Error('请先选择摘要模型')
  return Object.fromEntries(Object.keys(defaults).map(key=>[key,out[key]]))
}
export function settingsDocument(settings,revision=randomUUID()) {
  settings=validateSettings(settings)
  const config=controlsConfig({auto:settings.takeover,budgetMode:'ratio',...automaticRatios(settings.compressionRatio),foldBatchTokens:settings.compressionChunkTokens,condensedMinFanout:settings.fanout,
    summarizationProvider:settings.compactionProvider,summarizationModel:settings.compactionModel,
    summaryAdapter:settings.takeover?{plugin:'host',config:{}}:null})
  // The engine uses the host's existing registry; no duplicate adapters or credentials.
  config.summaryAdapter=null
  return {format:1,revision,settings,config}
}
export function readSettings(file=settingsPath()) {
  if(!existsSync(file))return settingsDocument(defaults,'initial')
  const doc=JSON.parse(readFileSync(file,'utf8'))
  if(doc.format!==1||typeof doc.revision!=='string'||!doc.revision)throw Error('插件设置文件损坏，请恢复备份')
  return {...doc,settings:validateSettings(doc.settings)}
}
export function saveSettings(input,catalog,file=settingsPath()) {
  mkdirSync(dirname(file),{recursive:true,mode:0o700})
  const lock=new DatabaseSync(file+'.lock.sqlite');let acquired=false
  try{lock.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');acquired=true;return saveLocked(input,catalog,file)}finally{if(acquired)lock.exec('ROLLBACK');lock.close()}
}
function saveLocked(input,catalog,file) {
  const current=readSettings(file);if(input?.revision!==current.revision)throw Error('设置已变化，请重新读取')
  const next=settingsDocument(input.settings)
  // Existing explicitly configured backup survives an unrelated console save.
  // Never silently choose a backup or replace the conversation's model.
  next.config=controlsConfig({...next.config,...Object.fromEntries(['fallbackSummarizationProvider','fallbackSummarizationModel'].filter(key=>current.config?.[key]!==undefined).map(key=>[key,current.config[key]]))})
  for(const [enabled,provider,model] of [[next.settings.summaryEnabled,next.settings.summaryProvider,next.settings.summaryModel],[next.settings.takeover,next.settings.compactionProvider,next.settings.compactionModel]]){
    if(enabled&&!catalog.some(p=>p.id===provider&&p.models.some(m=>m.id===model)))throw Error('所选模型当前不可用，请重新选择')
  }
  mkdirSync(dirname(file),{recursive:true,mode:0o700})
  if(existsSync(file)){const backup=join(dirname(file),'backups');mkdirSync(backup,{recursive:true,mode:0o700});writeFileSync(join(backup,randomUUID()+'.json'),readFileSync(file),{mode:0o600,flag:'wx'})}
  const temp=file+'.'+randomUUID();writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'})
  if(readSettings(file).revision!==current.revision)throw Error('设置已变化，请重新读取')
  renameSync(temp,file);return next
}
