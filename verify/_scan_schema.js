// 手动加载 .env(plaintext), 避免 dotenvx banner 污染 stdout
const fs=require('fs');
fs.readFileSync(__dirname+'/../.env','utf8').split(/\r?\n/).forEach(line=>{
  const m=line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if(m && !process.env[m[1]]) process.env[m[1]]=m[2];
});
const db=require('../db.js');
const {ObjectId}=require('mongodb');
function isLeafObj(v){return v&&typeof v==='object'&&!Array.isArray(v)&&!Buffer.isBuffer(v)&&!(v instanceof Date)&&!(v instanceof ObjectId);}
function walk(v,prefix,leafSet,nestedSet){
  if(Array.isArray(v)){ v.forEach(x=>walk(x,prefix,leafSet,nestedSet)); return; }
  if(isLeafObj(v)){
    for(const k of Object.keys(v)){
      const path = prefix? prefix+'.'+k : k;
      if(k==='_id') continue;
      leafSet.add(k);
      if(prefix) nestedSet.add(path);
      walk(v[k],path,leafSet,nestedSet);
    }
  }
}
const COLLS=['ai_production','ai_bad_repair','ai_task_orders','ai_line_config','ai_product_config','ai_downtime_records','ai_cache','ai_exceptions','ai_action_items','ai_attendance','ai_maintenance','ai_inspection','ai_production_plan','ai_daily_snapshot','ai_shift_config','ai_shift_override','ai_work_operations','ai_machines','ai_fixture','ai_aging_cable','ai_mo_orders','ai_task_order_wip','ai_repair_report','ai_process_routes','ai_model_map','ai_work_centers'];
(async()=>{
  await db.connect();
  const mdb=db.getDb();
  const inv={};
  for(const name of COLLS){
    const cnt=await mdb.collection(name).estimatedDocumentCount();
    const sample=await mdb.collection(name).find({},{limit:300}).toArray();
    const leaf=new Set(), nested=new Set();
    sample.forEach(d=>walk(d,'',leaf,nested));
    inv[name]={count:cnt, fields:Array.from(leaf).sort(), nested:Array.from(nested).sort(), sampled:sample.length};
  }
  const all=new Set(); for(const c of Object.values(inv)) c.fields.forEach(x=>all.add(x));
  const byLenDesc=Array.from(all).sort((a,b)=>b.length-a.length);
  const collisions={};
  for(const f of all){
    const longer=Array.from(all).filter(o=>o!==f&&o.length>f.length&&o.split('_').includes(f));
    if(longer.length) collisions[f]=longer;
  }
  const payload={collections:inv, allFieldsByLenDesc:byLenDesc, totalDistinct:all.size, tokenCollisions:collisions};
  fs.writeFileSync(__dirname+'/_field_inventory.json', JSON.stringify(payload,null,1));
  console.log('SCAN_DONE distinct='+all.size+' cols='+Object.keys(inv).length+' collisions='+Object.keys(collisions).length);
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
