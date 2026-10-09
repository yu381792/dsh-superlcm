import {clientRequestSchema} from '@deepseek-ai/dsh-client-connection'
import {readSettings,saveSettings} from './settings.js'
import {readFileSync} from 'node:fs'
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).version
export async function modelCatalog(ctx){const active=await ctx.llm.listProviders(),items=[]
  for(const provider of active){let models=[];try{models=await ctx.llm.listModels(provider.id)}catch{}
    items.push({id:provider.id,label:provider.name||provider.displayName||provider.id,models:models.map(m=>({id:m.id,label:m.name||m.id}))})}
  return items
}
export function pluginApi(ctx,archive,owner,file){let saving=false
  const read=async()=>{const doc=readSettings(file);return {version,revision:doc.revision,settings:doc.settings,catalog:await modelCatalog(ctx),runtime:{takeover:owner.mode==='superlcm',mode:owner.mode==='superlcm'?'superlcm':'native',archive:true,lastError:archive.lastError,lastDiagnostic:archive.lastDiagnostic}}}
  const handlers={read,save:async payload=>{if(saving)throw Error('设置正在保存');saving=true
      try{saveSettings(payload,await modelCatalog(ctx),file);archive.changed();await owner.reload();return await read()}finally{saving=false}},
    sessions:payload=>archive.sessions(payload||{}),outline:payload=>archive.outline(payload?.session),
    'read-events':payload=>archive.db.events(payload?.session,payload?.offset,payload?.limit),find:payload=>archive.db.find(payload),import:()=>archive.import(),summarize:payload=>archive.schedule(payload?.session)}
  ctx.inject(['connection'],child=>{
    for(const [method,handle] of Object.entries(handlers))child.connection.fetch.register({path:'/api/dsh-superlcm/'+method,methods:['POST'],requestBody:'buffered',fetch:async request=>{
      let message;try{message=clientRequestSchema.parse(await request.json());if(message.method!=='dsh-superlcm/'+method)throw Error('method')}catch{return new Response('请求格式无效',{status:400})}
      let result;try{request.signal.throwIfAborted();result={ok:true,value:await handle(message.payload)}}catch(error){result={ok:false,error:{code:error.message.startsWith('设置已变化')?'REVISION_CONFLICT':'DSH_SUPERLCM',message:/^(?:设置|插件设置|摘要|压缩|开关|模型|所选|请|会话|分页|搜索)/.test(error.message)?error.message:'插件操作失败，原文保留，请检查 DSH 日志'}}}
      return Response.json({type:'server-response',rpcId:message.rpcId,result})
    }})
  });return {read,handlers}
}
