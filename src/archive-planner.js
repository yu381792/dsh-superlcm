import {detectSummaryLanguage,userTextFromRecord} from './summary-language.js'
import {SUMMARY_POLICY_VERSION} from './summary-policy.js'
import {createHash} from 'node:crypto'
import {selectSummaryMerge,mergeContent} from './summary-merge.js'
import {estimateSummaryTokens,takeTokenPrefix,takeTokenSuffix} from './summary-tokens.js'
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const bounded=(text,budget,seq)=>estimateSummaryTokens(text)<=budget?text:takeTokenPrefix(text,Math.floor(budget*.55))+`\n[source #${seq} is oversized; read omitted details with lcm_read; never guess]\n`+takeTokenSuffix(text,Math.floor(budget*.35))
function calls(event,pending) {
  const data=event.data||{}
  if(event.type==='assistant/message'){
    for(const call of data.message?.content||[])if(call.type==='tool-call'&&call.id)pending.add(call.id)
    for(const call of data.toolCalls||[])if(call.id)pending.add(call.id)
  }
  if(event.type==='tool/call'){const id=data.callId||data.id;if(id)pending.add(id)}
  if(event.type==='tool/result')pending.delete(data.message?.callId||data.callId||data.toolCallId||data.id)
}
export function archiveWork(db,session,{chunkTokens,fanout}) {
  const fallback=()=>db.db.prepare("SELECT event FROM sl_events WHERE session=? AND json_extract(event,'$.type')='user/message' AND (json_extract(event,'$.data.source') IS NULL OR json_extract(event,'$.data.source.kind')='user') ORDER BY seq DESC LIMIT 128").all(session).reverse().map(r=>userTextFromRecord(r.event)).filter(Boolean)

  for(let level=1;level<=12;level++){
    const lower=db.nodes(session,level-1),owned=new Set(db.nodes(session,level).flatMap(n=>n.children))
    const batch=selectSummaryMerge(lower,owned,{fanout,targetTokens:chunkTokens})
    if(batch){const language=detectSummaryLanguage(fallback());return {language,requireHeading:true,id:digest([SUMMARY_POLICY_VERSION,language.code,session,level,batch.map(n=>[n.id,n.summary])]),level,first:batch[0].first,last:batch.at(-1).last,children:batch.map(n=>n.id),sources:[...new Set(batch.flatMap(n=>n.sources))].sort((a,b)=>a-b),content:mergeContent(batch)}}
  }
  const existing=db.nodes(session,0),from=existing.length?Math.max(...existing.map(n=>n.last))+1:0
  const rows=db.sourceRows(session,from),batch=[],pending=new Set();let tokens=0
  const finish=()=>{
    const content=batch.map(x=>x.text).join('\n\n');if(content.length>280000)throw Error('完整摘要输入过大，原文保留，请调整分块')
    const language=detectSummaryLanguage(batch.map(r=>userTextFromRecord(r.event)),fallback)
    return {language,requireHeading:true,id:digest([SUMMARY_POLICY_VERSION,language.code,session,0,batch.map(n=>[n.seq,n.event])]),level:0,first:batch[0].seq,last:batch.at(-1).seq,children:[],sources:batch.map(n=>n.seq),content}
  }
  for(const row of rows){
    const label=`[source #${row.seq}]\n`,text=label+bounded(row.text,Math.min(chunkTokens,60000)-estimateSummaryTokens(label)-2,row.seq)
    const cost=estimateSummaryTokens(text)+(batch.length?estimateSummaryTokens('\n\n'):0)
    if(batch.length&&!pending.size&&tokens+cost>chunkTokens)return finish()
    calls(JSON.parse(row.event),pending);batch.push({...row,text});tokens+=cost
    if(tokens>=chunkTokens&&!pending.size)return finish()
  }
  return null
}
