// Audit the actual npm packing list and local runtime import closure.
import assert from 'node:assert/strict'
import {readFileSync,readdirSync,existsSync} from 'node:fs'
import {dirname,resolve,relative,extname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),pkg=JSON.parse(readFileSync(resolve(root,'package.json')))
assert.ok(process.env.npm_execpath,'Run through npm run verify:release')
const packed=spawnSync(process.execPath,[process.env.npm_execpath,'pack','--dry-run','--json','--ignore-scripts'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024})
assert.equal(packed.status,0,packed.stderr)
const manifest=JSON.parse(packed.stdout)[0],files=new Set(manifest.files.map(f=>f.path.replaceAll('\\','/')))
assert.equal(manifest.version,pkg.version)
assert.ok(![...files].some(p=>/^(scratchpad|node_modules|\.env|\.git)\//.test(p)),'Private artifacts entered the package')
const runtimeDirs=pkg.name==='SuperLcm'?['src','lib']:['src','dsh']
let imports=0
for(const dir of runtimeDirs){
 const walk=folder=>{
  for(const e of readdirSync(folder,{withFileTypes:true})){
   if(['node_modules','.git'].includes(e.name))continue
   const path=resolve(folder,e.name),name=relative(root,path).replaceAll('\\','/')
   if(e.isDirectory()){walk(path);continue}
   if(!['.js','.mjs','.cjs','.json','.yml','.yaml'].includes(extname(path)))continue
   assert.ok(files.has(name),'Runtime file missing from package: '+name)
   if(!['.js','.mjs','.cjs'].includes(extname(path)))continue
   const text=readFileSync(path,'utf8')
   for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)){
    const target=resolve(dirname(path),match[1]);imports++
    assert.ok(existsSync(target),'Local import target missing: '+name+' -> '+match[1])
    assert.ok(files.has(relative(root,target).replaceAll('\\','/')),'Local import omitted from package: '+name+' -> '+match[1])
   }
  }
 };walk(resolve(root,dir))
}
for(const target of [...Object.values(pkg.bin||{}),...Object.values(pkg.exports||{}).filter(v=>typeof v==='string'),pkg.dsh?.bundle?.patch].filter(Boolean))assert.ok(files.has(target.replace(/^\.\//,'')),'Entrypoint omitted from package: '+target)
if(pkg.name==='superlcm-mcp')for(const name of ['.claude-plugin/plugin.json','dsh/ui/package.json'])assert.equal(JSON.parse(readFileSync(resolve(root,name))).version,pkg.version,name+' version drift')
console.log(JSON.stringify({package:pkg.name,version:pkg.version,packedFiles:files.size,localImportsVerified:imports}))
