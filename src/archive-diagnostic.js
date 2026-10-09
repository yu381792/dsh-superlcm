// Never forward provider bodies, transcript excerpts, paths or credentials to
// the settings page. Classify locally and publish only fixed explanations.
const reasons=[
  [/会话来源身份改变/,'HEADER_IDENTITY','会话来源信息冲突，归档已暂停'],
  [/原文已改变/,'SOURCE_CHANGED','已存原文与当前记录不一致，归档已暂停'],
  [/原文序号不连续/,'SOURCE_GAP','原文事件序号不连续，归档已暂停'],
  [/raw persistence is unavailable/,'RAW_UNAVAILABLE','DSH 未提供原始会话读取能力'],
  [/Summary exceeds/,'SUMMARY_TOO_LONG','摘要超过长度限制，未写入数据库'],
  [/incomplete|未正常结束/,'SUMMARY_INCOMPLETE','摘要模型未完整生成，未写入数据库'],
  [/returned no text/,'SUMMARY_EMPTY','摘要模型未返回正文'],
  [/摘要模型失败/,'SUMMARY_FAILED','摘要模型请求失败'],
  [/摘要设置或任务已变化|失去归属/,'JOB_CHANGED','摘要任务归属已变化，结果未提交'],
]
const named=new Map([
  ['SessionFormatUnsupportedError',['LEGACY_FORMAT','DSH 无法升级一条旧会话，该会话暂未归档']],
  ['SessionPersistenceCorruptionError',['SOURCE_DAMAGED','DSH 原始会话记录未通过完整性检查，归档已暂停']],
  ['SessionPersistenceNotFoundError',['SOURCE_MISSING','DSH 原始会话文件未找到，该会话暂未归档']],
  ['TimeoutError',['TIMEOUT','后台请求超时']],
])
export function archiveDiagnostic(error,{session,stage='capture'}={}) {
  const message=typeof error?.message==='string'?error.message:''
  const status=[error?.status,error?.statusCode,error?.cause?.status].find(x=>Number.isInteger(x)&&x>=400&&x<=599)
  // Host types outrank private text: a path containing "incomplete" must not
  // turn a refused legacy migration into a model error.
  let [code,detail]=named.get(error?.name)||[]
  if(!code&&status){code='HTTP_'+status;detail=status===401||status===403?'摘要模型认证失败':status===429?'摘要模型额度或请求频率受限':'摘要模型服务返回错误'}
  if(!code)[code,detail]=(reasons.find(([match])=>match.test(message))||[]).slice(1)
  if(!code){
    if(error?.code==='SQLITE_BUSY'||error?.code==='SQLITE_LOCKED'){code='DATABASE_BUSY';detail='归档数据库正被其他任务占用'}
    else{code='BACKGROUND_FAILED';detail=stage==='summary'?'后台摘要失败':'后台归档读取失败'}
  }
  return {code,stage,session,at:Date.now(),message:`${detail}（${code}）。原文保留。`}
}
