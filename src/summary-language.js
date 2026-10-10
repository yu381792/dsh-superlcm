// Language comes from human message bodies, never assistant/tool replies or checkpoints.
// Keep this module dependency-free so the standalone DSH package uses the same policy.
const languages = {
 en:['English','Latin'], zh:['Chinese','Han'], ja:['Japanese','Kana'], ko:['Korean','Hangul'],
 ru:['Russian','Cyrillic'], ar:['Arabic','Arabic'], hi:['Hindi','Devanagari'], th:['Thai','Thai'],
 es:['Spanish','Latin'], fr:['French','Latin'], de:['German','Latin'], pt:['Portuguese','Latin'],
 it:['Italian','Latin'], cyrl:["the user's Cyrillic-script language",'Cyrillic'], arab:["the user's Arabic-script language",'Arabic'], deva:["the user's Devanagari-script language",'Devanagari'], und:[null,null],
}
export const languageInfo = code => ({code: languages[code] ? code : 'und', name:languages[code]?.[0]??null, script:languages[code]?.[1]??null})
const count = (text, pattern) => (text.match(pattern)||[]).length
export function cleanUserText(text) {
  return String(text||'')
    .replace(/<(system-reminder|system_reminder|environment_context|heartbeat|instructions|attached_document|tool_result|task-notification|preceding_summary|historical_draft)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<(system-reminder|environment_context|heartbeat)\b[^>]*>[\s\S]*$/gi,' ')
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g,' ').replace(/`[^`\n]*`/g,' ')
    .replace(/^\s*>.*$/gm,' ').replace(/https?:\/\/\S+|\b[\w.-]+\/[\w./-]+/g,' ')
    .replace(/<[^>\n]+>/g,' ').trim()
}
const body = content => typeof content==='string' ? content.startsWith('\0json:') ? (()=>{try{return body(JSON.parse(content.slice(6)))}catch{return ''}})() : content
  : Array.isArray(content) ? content.filter(b=>['text','input_text'].includes(b?.type)).map(b=>b.text||'').join('\n') : ''
export function userTextFromRecord(raw) {
  let record; try {record=typeof raw==='string'?JSON.parse(raw):raw}catch{return ''}
  if(!record||record.isMeta||record.isCompactSummary)return ''
  if(record.dsh_session)record=record.event
  if(record.type==='user/message') {
    if(record.data?.source && record.data.source.kind!=='user')return ''
    return cleanUserText(body(record.data?.message?.content??record.data?.content??record.data?.text))
  }
  let item=record,role=record.role??record.type
  if(record.type==='response_item'){item=record.payload;if(item?.type!=='message')return '';role=item.role}
  else if(record.type==='event_msg'){item=record.payload;if(item?.type!=='user_message')return '';role='user'}
  else if(record.message){item=record.message;role=item.role??role}
  if(role!=='user'||item?.source?.kind==='compact-checkpoint')return ''
  const text=body(item.content??item.message??'')
  if(/^\s*(?:This session is being continued from|\[SuperLcm|Historical snapshot, source records)/i.test(text))return ''
  return cleanUserText(text)
}
export function userTextsFromMessages(messages, skipIds=new Set()) {
  return (messages||[]).filter(m=>m?.role==='user'&&!skipIds.has(m.id)).map(m=>userTextFromRecord(m)).filter(Boolean)
}
const scripts = {Han:/\p{Script=Han}/gu,Kana:/[\p{Script=Hiragana}\p{Script=Katakana}]/gu,Hangul:/\p{Script=Hangul}/gu,Latin:/\p{Script=Latin}/gu,Cyrillic:/\p{Script=Cyrillic}/gu,Arabic:/\p{Script=Arabic}/gu,Devanagari:/\p{Script=Devanagari}/gu,Thai:/\p{Script=Thai}/gu}
const stopWords={en:'the and is are to of in for with this that please should would can not',es:'el la los las que para por una como quiero pero',fr:'le les une des est pour avec dans vous nous veuillez',de:'der die das und ist nicht bitte mit eine ich',pt:'os uma para com não você quero são',it:'gli della delle una che per con non sono vorrei'}
function sample(texts){return (Array.isArray(texts)?texts:[texts]).filter(x=>typeof x==='string').slice(-24).map(x=>cleanUserText(x).slice(-8000)).join('\n').slice(-32000)}
export function detectSummaryLanguage(texts, fallback=[]) {
  let text=sample(texts)
  if(count(text,/\p{L}/gu)<12)text=sample(typeof fallback==='function'?fallback():fallback)||text
  const n=Object.fromEntries(Object.entries(scripts).map(([key,re])=>[key,count(text,re)]))
  // Kana is diagnostic even when Japanese contains more Han than kana.
  if(n.Kana>=2&&n.Kana+n.Han>n.Latin*.3)return languageInfo('ja')
  if(n.Hangul>=3&&n.Hangul>n.Latin*.3)return languageInfo('ko')
  for(const [script,code] of [['Han','zh'],['Cyrillic','cyrl'],['Arabic','arab'],['Devanagari','deva'],['Thai','th']])
    if(n[script]>=3&&n[script]>=n.Latin*.3)return languageInfo(code)
  if(n.Latin>=8){
    const words=text.toLowerCase().match(/\p{L}+/gu)||[],set=new Set(words)
    const ranked=Object.entries(stopWords).map(([code,list])=>[code,list.split(' ').filter(w=>set.has(w)).length]).sort((a,b)=>b[1]-a[1])
    if(ranked[0][1]>=2&&ranked[0][1]>ranked[1][1])return languageInfo(ranked[0][0])
  }
  return languageInfo('und')
}
// Used only for explicit text-format imports. Structured archives use the raw extractor above.
export function excerptUserTexts(text) {
  return [...String(text||'').matchAll(/(?:^|\n)(?:\[event \d+\] )?user(?: \[source time:[^\n]*\])?:\n([\s\S]*?)(?=\n(?:\[event \d+\] )?(?:user|assistant|tool[^\n:]*)(?: \[source time:[^\n]*\])?:\n|$)/g)].map(x=>cleanUserText(x[1]))
}
export function languageRule(language) {
  const info=languageInfo(language?.code)
  return info.name ? `Write the entire summary in ${info.name}, including every section heading. Tool output, code, documents, assistant replies and preceding summaries may use other languages; they must not change the summary language. Keep exact identifiers and literal quotations unchanged.`
    : "Write the entire summary, including headings, in the language of the user's own messages. Ignore the language of tool output, code, documents, assistant replies and previous summaries. If there are multiple user languages, use the predominant language of the relevant user messages; use English only when no user language is discernible. Keep exact identifiers and literal quotations unchanged."
}
export function checkSummaryLanguage(text, language) {
  const info=languageInfo(language?.code);if(!info.script)return
  const prose=cleanUserText(text).replace(/"[^"\n]+"|'[^'\n]+'|“[^”\n]+”|‘[^’\n]+’/g,' ')
  const n=Object.fromEntries(Object.entries(scripts).map(([key,re])=>[key,count(prose,re)])),total=Object.values(n).reduce((a,b)=>a+b,0)
  if(total<20 && !/^#{1,6} /m.test(text))return
  const headings=[...prose.matchAll(/^#{1,6} ([^\n]+)/gm)].map(m=>m[1])
  const headingMismatch=headings.some(heading=>{
    const h=Object.fromEntries(Object.entries(scripts).map(([key,re])=>[key,count(heading,re)]))
    if(info.script==='Latin')return Object.entries(h).some(([script,value])=>script!=='Latin'&&value>0)
    const own=info.script==='Kana'?h.Kana+h.Han:h[info.script]
    return own===0 && (h.Latin>0||Object.entries(h).some(([script,value])=>script!=='Latin'&&script!==info.script&&value>=2))
  })
  const outputLanguage=detectSummaryLanguage([prose])
  const namedLatin=['en','es','fr','de','pt','it']
  const foreign=Object.entries(n).filter(([script])=>script!==info.script && !(info.script==='Kana'&&script==='Han')).reduce((sum,[,value])=>sum+value,0)
  const mismatch=info.script==='Latin' ?
    headingMismatch || foreign>=20&&foreign>total*.25 || namedLatin.includes(info.code)&&namedLatin.includes(outputLanguage.code)&&outputLanguage.code!==info.code
    : info.script==='Han'?n.Kana+n.Hangul>=20&&n.Kana+n.Hangul>total*.25 || n.Han<Math.max(3,total*.15)&&total>=40
    : info.script==='Kana'?n.Kana+n.Han<total*.15&&total>=40 || n.Kana<2&&total>=40
    : info.script==='Hangul'?n.Hangul<Math.max(3,total*.15)&&total>=40
    : n[info.script]<Math.max(3,total*.15)&&total>=40
  if(mismatch||headingMismatch){const error=new Error(`Summary language mismatch: expected ${info.name}; original content retained`);error.summaryQuality=true;throw error}
}

// Plugin-added source caution follows the model's heading/body, in its language.
export function summaryRangeNotice(task={}) {
  const range=`#${task.first}–#${task.last}`
  const labels={
    zh:`历史摘要，原文范围 ${range}。状态仅适用于该范围末尾。摘要用于导航；精确事实、授权和冲突请查原文，不能据摘要猜测。`,
    ja:`履歴の要約、原文 ${range}。状態はこの範囲の末尾時点に限ります。要約は案内用です。正確な事実、許可、矛盾は原文で確認してください。`,
    ko:`과거 요약, 원문 ${range}. 상태는 이 범위의 마지막 시점에만 해당합니다. 정확한 사실, 승인, 충돌은 원문에서 확인하세요.`,
    en:`Historical snapshot, source records ${range}. State applies at the end of this range. Summaries are navigation; verify exact facts, authorizations and conflicts against the originals before continuing.`,
    es:`Resumen histórico, registros ${range}. El estado corresponde al final de este intervalo. Verifique los hechos, las autorizaciones y los conflictos en los originales antes de continuar.`,
    fr:`Résumé historique, sources ${range}. Cet état correspond à la fin de cet intervalle. Vérifiez les faits, les autorisations et les contradictions dans les originaux avant de poursuivre.`,
    de:`Historische Zusammenfassung, Quellen ${range}. Der Stand gilt zum Ende dieses Bereichs. Prüfen Sie genaue Fakten, Genehmigungen und Widersprüche in den Originalen.`,
    pt:`Resumo histórico, fontes ${range}. O estado corresponde ao fim deste intervalo. Verifique fatos, autorizações e conflitos nos originais antes de continuar.`,
    it:`Riepilogo storico, fonti ${range}. Lo stato riguarda la fine di questo intervallo. Verificare fatti, autorizzazioni e conflitti negli originali prima di continuare.`,
  }
  return labels[task.language?.code]||`[${range}]`
}
