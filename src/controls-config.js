// The console owns this private document. Native engines consume it at boot
// and while running; there is one document for every DSH launch mode.
import { readFileSync, existsSync } from 'node:fs'
import {ratioOptions} from './ratio-policy.js'
export const controlFields = {
  tailCount:[1,10000,24], minRetainTokens:[0,2000000,32000],
  softActiveTokens:[1000,4000000,160000], hardActiveTokens:[1001,8000000,220000],
  pressureFoldTokens:[1,2000000,20000], foldBatchTokens:[1,4000000,64000],
  summaryPrefixTargetTokens:[0,2000000,0], condensedMinFanout:[2,100,4],
  summaryTimeoutMs:[1000,1800000,180000], summaryRetryCooldownMs:[1000,1800000,30000],
}
export function controlsConfig(raw) {
  if(!raw||typeof raw!=='object'||typeof raw.auto!=='boolean')throw Error('压缩开关无效')
  const budgetMode=raw.budgetMode??(raw.softActiveTokens!==undefined||raw.hardActiveTokens!==undefined?'tokens':'ratio')
  if(!['tokens','ratio'].includes(budgetMode))throw Error('压缩预算模式无效')
  const out={auto:raw.auto,budgetMode,...ratioOptions(raw)}
  for(const [key,[min,max,fallback]] of Object.entries(controlFields)) {
    const value=raw[key]??(budgetMode==='ratio'&&key==='foldBatchTokens'?20000:fallback)
    if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('压缩参数无效：'+key)
    out[key]=value
  }
  if(budgetMode==='ratio')out.pressureFoldTokens=out.foldBatchTokens
  if(budgetMode==='tokens'&&out.hardActiveTokens<=out.softActiveTokens)throw Error('强制压缩门槛必须大于开始压缩门槛')
  if(budgetMode==='tokens'&&out.minRetainTokens>=out.softActiveTokens)throw Error('原文保留量必须小于开始压缩门槛')
  if(out.pressureFoldTokens>out.foldBatchTokens)throw Error('最小压缩批量不能超过每批处理量')
  if(raw.auto&&(typeof raw.summarizationProvider!=='string'||!raw.summarizationProvider||typeof raw.summarizationModel!=='string'||!raw.summarizationModel))throw Error('请选择 DSH 已配置的压缩模型')
  const fallbackProvider=raw.fallbackSummarizationProvider??'',fallbackModel=raw.fallbackSummarizationModel??''
  if(typeof fallbackProvider!=='string'||typeof fallbackModel!=='string'||!!fallbackProvider!==!!fallbackModel)throw Error('备用摘要供应商和模型须同时设置')
  if(fallbackProvider&&fallbackProvider===raw.summarizationProvider&&fallbackModel===raw.summarizationModel)throw Error('备用摘要模型须与主摘要模型不同')
  return {...out,summarizationProvider:raw.summarizationProvider||'',summarizationModel:raw.summarizationModel||'',summaryAdapter:raw.summaryAdapter||null,
    ...(fallbackProvider?{fallbackSummarizationProvider:fallbackProvider,fallbackSummarizationModel:fallbackModel}:{})}
}
export function readControls(file) {
  if(!file||!existsSync(file))return null
  const value=JSON.parse(readFileSync(file,'utf8'))
  if(value.format!==1||typeof value.revision!=='string'||!value.revision)throw Error('压缩设置文件无效')
  return {...value,config:controlsConfig(value.config)}
}
