// 去重 ai_task_orders.ai_task_no: 每组保留 synced_at 最大的, 删其余; 然后重建唯一索引
// 用法: node scripts/dedup_task_orders.js  (用户已明确授权删除 99 条旧残留重复)
const fs=require('fs');
fs.readFileSync(__dirname+'/../.env','utf8').split(/\r?\n/).forEach(l=>{const m=l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];});
const {MongoClient}=require('mongodb');
(async()=>{
  const c=await MongoClient.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000,socketTimeoutMS:0});
  const col=c.db(process.env.MONGO_DB).collection('ai_task_orders');
  const dups=await col.aggregate([
    {$group:{_id:'$ai_task_no',n:{$sum:1},docs:{$push:{_id:'$_id',synced:'$ai_synced_at'}}}},
    {$match:{n:{$gt:1}}}
  ]).toArray();
  console.log('dup groups='+dups.length);
  let toDelete=[];
  for(const g of dups){
    // 按 synced 降序, 保留第一个(最新), 其余删除
    g.docs.sort((a,b)=>(b.synced||0)-(a.synced||0));
    for(let i=1;i<g.docs.length;i++) toDelete.push(g.docs[i]._id);
  }
  console.log('to delete='+toDelete.length+' (keep '+dups.length+' newest)');
  if(toDelete.length){
    const r=await col.deleteMany({_id:{$in:toDelete}});
    console.log('deleted='+r.deletedCount);
  }
  // 重建唯一索引
  try{ await col.dropIndex('ai_task_no_1'); }catch(e){}
  try{
    await col.createIndex({ai_task_no:1},{unique:true,name:'ai_task_no_1'});
    console.log('unique index ai_task_no_1 created OK');
  }catch(e){ console.log('index create FAILED: '+e.message); }
  // 校验无重复
  const rem=await col.aggregate([{$group:{_id:'$ai_task_no',n:{$sum:1}}},{$match:{n:{$gt:1}}},{$count:'c'}]).toArray();
  console.log('remaining dup groups='+(rem[0]?rem[0].c:0));
  console.log('total docs now='+await col.estimatedDocumentCount());
  await c.close();
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
