import { detectSummaryLanguage, userTextFromRecord } from './summary-language.js'
export function dshSummaryLanguage(session,task={}) {
  const collect=(first,last)=>{
    const texts=[]
    for(let seq=last;seq>=first&&texts.length<24;seq--){
      const text=userTextFromRecord(session.eventAt(seq));if(text)texts.unshift(text)
    }
    return texts
  }
  const fallback=collect(0,session.seq-1)
  return detectSummaryLanguage(task.level>0?fallback:collect(Math.max(0,task.first??0),Math.min(session.seq-1,task.last??session.seq-1)),fallback)
}
