// One explicit pre-release entry point. Every failed check stops publication.
// No production services, settings or conversation files are used.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),pkg=JSON.parse(readFileSync(resolve(root,'package.json')))
assert.ok(process.env.npm_execpath,'Run with npm run verify:release')
const stages=pkg.name==='SuperLcm'?['validate','test:install','test:package']:['validate','test:dsh-runtime','test:installed-package','test:package']
for(const stage of stages){
 console.log('\nRelease verification: '+stage)
 const result=spawnSync(process.execPath,[process.env.npm_execpath,'run',stage],{cwd:root,env:process.env,stdio:'inherit'})
 if(result.status!==0)process.exit(result.status||1)
}
console.log(JSON.stringify({releaseChecks:'passed',package:pkg.name,version:pkg.version,platform:process.platform,paidSummaryCalls:0,productionSettingsChanged:false}))
