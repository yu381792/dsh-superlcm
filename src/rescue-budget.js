import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {currentPolicy,requestIdentity} from './ratio-runtime.js'
import {selectionPricing} from './selection-pricing.js'

// The rescue uses the conversation model, whose window may be much smaller
// than the auxiliary model's. Budget the actual prefix, directive and tools.
export function rescueOutputBudget(engine,agent,input,directive,target,configured) {
  const policy=currentPolicy(engine,agent)
  if(!policy)throw Error('当前对话模型容量尚未核实，最终压缩未提交')
  const measurement=engine.ctx.tokenMeter.measure(agent.session)
  const factor=selectionPricing(measurement,agent.session.requestHeader()).factor
  const instruction=createUserMessage({content:[{type:'text',text:directive}]})
  const tools=input.tools?.length?Math.ceil(JSON.stringify(input.tools).length/4)+4:0
  const blocks=input.messages.flatMap(message=>message.content)
  const images=blocks.filter(block=>block.type==='image')
  const route=requestIdentity(agent)
  const pricing=engine.ctx.llm.imageRequestPricing?.(route.provider,route.model)
  const prices=pricing?.priceImages(images)
  if(prices&&prices.length!==images.length)throw Error('当前对话模型的图片预算不完整，原文已保留')
  const cost=block=>engine.ctx.tokenMeter.estimateMessage({role:'user',content:[block]})-4
  let attachments=0
  if(prices)for(let i=0;i<images.length;i++) {
    const price=prices[i]
    if(!Number.isFinite(price.visualTokens)||price.visualTokens<0||typeof price.text!=='string')throw Error('当前对话模型的图片预算无效，原文已保留')
    attachments+=Math.max(0,price.visualTokens+cost({type:'text',text:price.text})-cost(images[i]))
  }
  for(const block of blocks.filter(block=>block.type==='file'))attachments+=Math.max(0,cost({type:'text',text:engine.ctx.llm.fileRequestText(block.attachment)})-cost(block))
  const estimate=attachments+input.messages.reduce((sum,message)=>sum+engine.ctx.tokenMeter.estimateMessage(message),0)+engine.ctx.tokenMeter.estimateMessage(instruction)+tools
  const available=policy.contextWindow-Math.ceil(estimate*factor)-512
  const maximum=Math.floor(Math.min(configured,Math.max(256,target||1024),available))
  if(!Number.isSafeInteger(maximum)||maximum<256)throw Error('当前对话模型无法同时容纳压缩输入和摘要输出，原文与当前请求已保留')
  return maximum
}
