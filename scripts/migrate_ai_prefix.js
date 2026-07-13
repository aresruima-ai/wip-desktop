// MongoDB 字段统一加 ai_ 前缀迁移脚本
// 用法:
//   node scripts/migrate_ai_prefix.js dry-run     # 只统计,不写
//   node scripts/migrate_ai_prefix.js backup      # 备份珍贵集合到 _archive/preai_backup/
//   node scripts/migrate_ai_prefix.js apply       # 执行改名+清cache+删旧索引
//   node scripts/migrate_ai_prefix.js reverse     # 回滚: ai_字段→原名(用 _field_inventory.json 映射)
// 字段集来自 verify/_field_inventory.json (allFieldsByLenDesc)
// 规则: 每个文档字段(含嵌套) k≠_id → ai_k; ai_cache 清空(重建); 旧索引删除(server重启重建)
const fs=require('fs');
const path=require('path');
// 手动加载 .env
fs.readFileSync(path.join(__dirname,'..','.env'),'utf8').split(/\r?\n/).forEach(line=>{
  const m=line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if(m && !process.env[m[1]]) process.env[m[1]]=m[2];
});
const db=require('../db.js');
// 迁移用独立长超时连接(514k 文档 $rename 远程 Mongo 需数分钟, 超出 db.js 45s socketTimeout)
const {MongoClient,ObjectId:OID}=require('mongodb');
let _migClient,_migDb;
async function migDb(){ if(_migDb) return _migDb; _migClient=new MongoClient(process.env.MONGO_URI,{maxPoolSize:8,serverSelectionTimeoutMS:10000,socketTimeoutMS:0}); await _migClient.connect(); _migDb=_migClient.db(process.env.MONGO_DB||'mes_dashboard'); return _migDb; }

const COLLS=['ai_production','ai_bad_repair','ai_task_orders','ai_line_config','ai_product_config','ai_downtime_records','ai_cache','ai_exceptions','ai_action_items','ai_attendance','ai_maintenance','ai_inspection','ai_production_plan','ai_daily_snapshot','ai_shift_config','ai_shift_override','ai_work_operations','ai_machines','ai_fixture','ai_aging_cable','ai_mo_orders','ai_task_order_wip','ai_repair_report','ai_process_routes','ai_model_map','ai_work_centers'];
// 含嵌套子文档/对象数组的集合(ai_cache 清空, 不需 nested 处理)
const NESTED_COLL=new Set(['ai_daily_snapshot','ai_shift_config','ai_process_routes']);
// 手工不可再生(非MES同步)的珍贵集合, backup 模式导出 JSONL
const PRECIOUS=['ai_line_config','ai_product_config','ai_shift_config','ai_shift_override','ai_fixture','ai_aging_cable','ai_process_routes','ai_daily_snapshot','ai_downtime_records','ai_exceptions','ai_action_items','ai_attendance','ai_maintenance','ai_inspection','ai_production_plan','ai_machines'];

const inv=JSON.parse(fs.readFileSync(path.join(__dirname,'..','verify','_field_inventory.json'),'utf8'));
const FIELDS=inv.allFieldsByLenDesc; // 长度降序
// 顶层 $rename 映射: old -> ai_old (排除已经是 ai_ 或 _id)
const RENAME_MAP={};
for(const f of FIELDS){ if(f.startsWith('ai_')||f==='_id') continue; RENAME_MAP[f]='ai_'+f; }

const {ObjectId}=require('mongodb');
function isObj(v){return v&&typeof v==='object'&&!Array.isArray(v)&&!Buffer.isBuffer(v)&&!(v instanceof Date)&&!(v instanceof ObjectId);}
// 递归改嵌套键(只处理非顶层 & 非 ai_ 前缀 & 非 _id); 返回新对象
function renameNested(v){
  if(Array.isArray(v)) return v.map(renameNested);
  if(!isObj(v)) return v;
  const out={};
  for(const k of Object.keys(v)){
    if(k==='_id'){ out[k]=v[k]; continue; }
    const nk = k.startsWith('ai_') ? k : 'ai_'+k;
    out[nk]=renameNested(v[k]);
  }
  return out;
}

async function dryRun(){
  const mdb=await migDb();
  console.log('=== DRY-RUN ===');
  console.log('顶层 $rename 映射 ('+Object.keys(RENAME_MAP).length+' 字段): 长度降序前20:', FIELDS.slice(0,20).join(', '));
  let grandTotal=0;
  for(const name of COLLS){
    const cnt=await mdb.collection(name).estimatedDocumentCount();
    const nested=NESTED_COLL.has(name);
    console.log(`  ${name}: ${cnt} 文档 ${name==='ai_cache'?'[将清空]':''} ${nested?'[含嵌套,逐文档处理]':'[$rename顶层]'}`);
    grandTotal+=cnt;
  }
  console.log('总文档数:',grandTotal);
  console.log('珍贵集合(backup导出):',PRECIOUS.join(', '));
  process.exit(0);
}

async function backup(){
  const mdb=await migDb();
  const dir=path.join(__dirname,'..','_archive','preai_backup');
  fs.mkdirSync(dir,{recursive:true});
  console.log('=== BACKUP → '+dir+' ===');
  for(const name of PRECIOUS){
    const cnt=await mdb.collection(name).estimatedDocumentCount();
    if(cnt===0){ console.log('  '+name+': 空,跳过'); continue; }
    const file=path.join(dir,name+'.jsonl');
    const out=fs.createWriteStream(file);
    let n=0;
    const cur=mdb.collection(name).find({},{batchSize:500});
    for await(const doc of cur){ out.write(JSON.stringify(doc)+'\n'); n++; }
    out.end(); await new Promise(r=>out.on('close',r));
    console.log(`  ${name}: ${n} 文档 → ${path.basename(file)}`);
  }
  console.log('备份完成.');
  process.exit(0);
}

async function apply(){
  const mdb=await migDb();
  console.log('=== APPLY (改名+清cache+删旧索引) ===');
  // 1. ai_cache 清空
  const cd=await mdb.collection('ai_cache').deleteMany({});
  console.log('  ai_cache 清空: 删'+cd.deletedCount+' 文档');
  // 2. 先删所有集合的非 _id 旧索引($rename 时旧唯一索引会因多 null 冲突报 E11000; 先删后改)
  console.log('  删除旧索引(除 _id_)...');
  for(const name of COLLS){
    if(name==='ai_cache') continue;
    try{
      const idxs=await mdb.collection(name).listIndexes().toArray();
      for(const ix of idxs){
        if(ix.name==='_id_') continue;
        try{ await mdb.collection(name).dropIndex(ix.name); }catch(e){}
      }
    }catch(e){ /* 集合可能无索引 */ }
  }
  // 3. 每集合: 顶层 $rename
  for(const name of COLLS){
    if(name==='ai_cache') continue;
    const cnt=await mdb.collection(name).estimatedDocumentCount();
    if(cnt===0){ console.log('  '+name+': 空,跳过'); continue; }
    const t0=Date.now();
    const r=await mdb.collection(name).updateMany({},{$rename:RENAME_MAP});
    console.log('  '+name+': $rename matched='+r.matchedCount+' t='+(Date.now()-t0)+'ms');
    // 4. 嵌套集合: 逐文档递归改名
    if(NESTED_COLL.has(name)){
      const t1=Date.now(); let bn=0; const bulk=[];
      const cur=mdb.collection(name).find({},{batchSize:200});
      for await(const doc of cur){
        const fixed=renameNested(doc);
        bulk.push({replaceOne:{filter:{_id:doc._id},replacement:fixed}});
        if(bulk.length>=500){ await mdb.collection(name).bulkWrite(bulk,{ordered:false}); bn+=bulk.length; bulk.length=0; }
      }
      if(bulk.length){ await mdb.collection(name).bulkWrite(bulk,{ordered:false}); bn+=bulk.length; }
      console.log('    nested 递归改名 '+bn+' 文档 t='+(Date.now()-t1)+'ms');
    }
  }
  console.log('=== APPLY 完成. 重启 server 会自动重建 ai_ 索引 ===');
  process.exit(0);
}

async function reverse(){
  const mdb=await migDb();
  console.log('=== REVERSE (ai_字段→原名) ===');
  const rev={};
  for(const f of FIELDS){ if(f.startsWith('ai_')||f==='_id') continue; rev['ai_'+f]=f; }
  for(const name of COLLS){
    if(name==='ai_cache') continue;
    const cnt=await mdb.collection(name).estimatedDocumentCount();
    if(cnt===0) continue;
    const r=await mdb.collection(name).updateMany({},{$rename:rev});
    console.log('  '+name+': reverse matched='+r.matchedCount);
    if(NESTED_COLL.has(name)){
      const cur=mdb.collection(name).find({},{batchSize:200});
      const bulk=[];
      for await(const doc of cur){
        const fixed=(function undo(v){
          if(Array.isArray(v)) return v.map(undo);
          if(!isObj(v)) return v;
          const out={};
          for(const k of Object.keys(v)){ if(k==='_id'){out[k]=v[k];continue;} out[k.replace(/^ai_/,'')]=undo(v[k]); }
          return out;
        })(doc);
        bulk.push({replaceOne:{filter:{_id:doc._id},replacement:fixed}});
        if(bulk.length>=500){ await mdb.collection(name).bulkWrite(bulk,{ordered:false}); bulk.length=0; }
      }
      if(bulk.length) await mdb.collection(name).bulkWrite(bulk,{ordered:false});
    }
  }
  console.log('=== REVERSE 完成 ===');
  process.exit(0);
}

const mode=process.argv[2]||'dry-run';
(async()=>{ if(mode==='dry-run')await dryRun(); else if(mode==='backup')await backup(); else if(mode==='apply')await apply(); else if(mode==='reverse')await reverse(); else {console.log('unknown mode. use dry-run|backup|apply|reverse');process.exit(1);} })()
  .catch(e=>{console.error('FATAL',e);process.exit(1);});
