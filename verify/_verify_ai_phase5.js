// Phase5: ai_ 迁移后端到端验证 — 直连DB(改后) + API(走server) 双口径对齐
require('dotenv').config();
const db = require('../db.js');
const http = require('http');
function pad(n){return String(n).padStart(2,'0');}
const d=new Date(); const D=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
function req(method,path,body,cookie){return new Promise((res,rej)=>{const o={hostname:'127.0.0.1',port:8080,method,path,headers:{}};if(cookie)o.headers.Cookie=cookie;if(body){o.headers['Content-Type']='application/json';}const r=http.request(o,rr=>{let d='';rr.on('data',c=>d+=c);rr.on('end',()=>res({status:rr.statusCode,body:d,headers:rr.headers}));});r.on('error',rej);if(body)r.write(JSON.stringify(body));r.end();});}
let pass=0,fail=0; function ck(n,ok,info){console.log((ok?'PASS':'FAIL')+' '+n+(info?'  '+info:''));if(ok)pass++;else fail++;}
(async()=>{
  // 1. 登录拿cookie
  const lr=await req('POST','/api/admin-login',{key:process.env.ADMIN_KEY||'12345678'});
  const ck2=lr.headers['set-cookie']||[]; const cookie=ck2[0]?ck2[0].split(';')[0]:'';
  ck('admin-login',lr.status===200&&cookie);
  // 2. 直连DB: production 今日去重SN(应=3021附近, 与API output对齐)
  await db.connect();
  const dbTotal=await db.queryProductionTotal(D,D,'');
  // 3. API: dashboard-kpi output
  const kr=await req('GET','/api/dashboard-kpi','',cookie); const k=JSON.parse(kr.body);
  ck('api.dashboard-kpi', kr.status===200&&k.success, 'oee='+k.oee+' fpy='+k.fpy+' output='+k.output+' offline='+k.output_offline);
  ck('DB vs API output 对齐', Math.abs((k.output||0)-dbTotal)<=50, 'DB='+dbTotal+' API='+k.output);
  // 4. API: oee ASS_Line1 (整机1线) 应有 oee 数值
  const oer=await req('GET','/api/oee?line=ASS_Line1','',cookie); const oe=JSON.parse(oer.body);
  const l1=oe.daily&&oe.daily.find(x=>x.line_name==='ASS_Line1');
  ck('api.oee 整机1线', !!l1&&l1.oee!=null, 'oee='+l1.oee+' avail='+l1.availability+' out='+l1.total_output);
  // 5. API: bad/pareto 应返回数组
  const bpr=await req('GET','/api/bad/pareto?groupBy=defect','',cookie); const bp=JSON.parse(bpr.body);
  ck('api.bad.pareto', Array.isArray(bp.data), 'len='+(bp.data?bp.data.length:0));
  // 6. API: fixtures 应返回数组(ai_fixture 已迁移)
  const fr=await req('GET','/api/fixtures','',cookie); const fx=JSON.parse(fr.body);
  ck('api.fixtures', Array.isArray(fx.data||fx), 'len='+(fx.data?fx.data.length:(Array.isArray(fx)?fx.length:0)));
  // 7. 直连DB: fixture 字段应是 ai_ (抽样), queryFixtures 返回原名字段
  const fxs=await db.queryFixtures('');
  const sample=fxs[0]||{};
  ck('queryFixtures 字段无ai_前缀(翻译层)', !('ai_code' in sample)&&'code' in sample, 'keys='+Object.keys(sample).slice(0,5).join(','));
  console.log('\n=== '+pass+' PASS / '+fail+' FAIL ===');
  process.exit(fail?1:0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
