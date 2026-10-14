import test from 'node:test'
import assert from 'node:assert/strict'
import {deriveRatioPolicy} from '../src/ratio-policy.js'

test('fixed prompts do not squeeze a 500K model summary into an impossible 1K budget',()=>{
 const policy=deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:500000,fixedTokens:48385})
 assert.equal(policy.summaryPrefixTargetTokens,30000)
 assert.equal(policy.postTargetTokens,98385)
 assert.equal(policy.postTargetTokens,48385+policy.minRetainTokens+policy.summaryPrefixTargetTokens)
 assert.ok(policy.postTargetTokens<policy.softActiveTokens)
})
test('output reservation, early thresholds and excessive fixed costs remain bounded',()=>{
 const normal=deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:1000000,reservedCompletionTokens:100000})
 assert.equal(normal.postTargetTokens,90000);assert.equal(normal.summaryPrefixTargetTokens,54000)
 const early=deriveRatioPolicy({foldBatchTokens:20000,prepareRatio:.01,switchRatio:.02,emergencyRatio:.03},{contextWindow:100000})
 assert.ok(early.minRetainTokens+early.summaryPrefixTargetTokens<early.softActiveTokens)
 assert.throws(()=>deriveRatioPolicy({foldBatchTokens:20000},{contextWindow:100000,fixedTokens:78000}),/无法容纳/)
})
