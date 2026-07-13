// UPH 端到端验证: admin登录 → /api/uph-stats + /api/uph-filters 全结构 + 缓存 + 过滤
require('dotenv').config();
const http = require('http');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname:'localhost', port:8080, path, method, headers:{} };
    if (data) { opts.headers['Content-Type']='application/json'; opts.headers['Content-Length']=Buffer.byteLength(data); }
    if (cookie) opts.headers.Cookie = cookie;
    const r = http.request(opts, res => {
      let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:buf}));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  let ok=0, fail=0;
  const ck=(n,c,x)=>{ if(c){ok++;console.log('  ✓',n,x||'');} else {fail++;console.log('  ✗',n,x||'');} };

  // 1. admin login
  const lr = await req('POST','/api/admin-login',{key:ADMIN_KEY});
  const setCookie = lr.headers['set-cookie']||[];
  const cookie = setCookie[0] ? setCookie[0].split(';')[0] : '';
  ck('admin-login', lr.status===200 && cookie, 'status='+lr.status);
  if (!cookie) { console.log('  登录失败,终止'); process.exit(1); }

  // 2. uph-stats 主结构
  console.log('\n[2] /api/uph-stats');
  const sr = await req('GET','/api/uph-stats?dateFrom=2026-06-20&dateTo=2026-06-25&prevFrom=2026-06-15&prevTo=2026-06-19', null, cookie);
  let s;
  try { s = JSON.parse(sr.body); } catch(e){ ck('JSON解析', false, sr.body.slice(0,200)); process.exit(1); }
  ck('success', s.success===true, 'status='+sr.status);
  ck('summary.total>0', s.summary && s.summary.total>0, 'total='+s.summary?.total+' uph='+s.summary?.uph+' mom='+s.summary?.mom);
  ck('hourly数组', Array.isArray(s.hourly) && s.hourly.length>0, 'len='+s.hourly?.length);
  ck('daily数组', Array.isArray(s.daily) && s.daily.length>0, 'len='+s.daily?.length+' 样例='+s.daily?.slice(0,2).map(d=>d.key+':'+d.total).join(' '));
  ck('byModel数组', Array.isArray(s.byModel) && s.byModel.length>0, 'len='+s.byModel?.length);
  ck('byLine数组', Array.isArray(s.byLine) && s.byLine.length>0, 'len='+s.byLine?.length);
  ck('byOperation数组', Array.isArray(s.byOperation) && s.byOperation.length>0, 'len='+s.byOperation?.length);
  ck('byOperationHour数组', Array.isArray(s.byOperationHour) && s.byOperationHour.length>0, 'len='+s.byOperationHour?.length+' 样例='+s.byOperationHour?.slice(0,2).map(r=>r.op+':'+r.hour+'h='+r.total).join(' '));
  ck('stageEnd三段', s.stageEnd && s.stageEnd.stages && s.stageEnd.stages.length===3, s.stageEnd?.stages?.map(x=>x.label+':'+x.output+'/uph'+x.uph).join(' '));
  ck('granular 6键', s.granular && ['realtime','week','month','quarter','half','year'].every(k=>s.granular[k]), 'realtime='+s.granular?.realtime?.total+' month='+s.granular?.month?.total+' year='+s.granular?.year?.total);
  ck('dataStart', !!s.dataStart, s.dataStart);
  ck('opMap', !!s.opMap && Object.keys(s.opMap).length>0, 'ops='+Object.keys(s.opMap||{}).length);
  ck('range/filters', !!s.range && !!s.filters, 'line_display='+s.filters?.line_display);

  // 3. uph-filters
  console.log('\n[3] /api/uph-filters');
  const fr = await req('GET','/api/uph-filters', null, cookie);
  let f; try { f = JSON.parse(fr.body); } catch(e){ ck('JSON', false, fr.body.slice(0,200)); process.exit(1); }
  ck('success', f.success===true);
  ck('models数组', Array.isArray(f.models) && f.models.length>0, 'len='+f.models?.length+' 样例='+f.models?.slice(0,3).join(','));
  ck('operations数组', Array.isArray(f.operations) && f.operations.length>0, 'len='+f.operations?.length);
  ck('lines数组', Array.isArray(f.lines) && f.lines.length>0, 'len='+f.lines?.length);

  // 4. 缓存命中
  console.log('\n[4] dashCache 命中');
  const sr2 = await req('GET','/api/uph-stats?dateFrom=2026-06-20&dateTo=2026-06-25&prevFrom=2026-06-15&prevTo=2026-06-19', null, cookie);
  let s2; try{s2=JSON.parse(sr2.body);}catch(e){}
  ck('二次请求缓存命中', s2 && s2.cached===true, 'cached='+s2?.cached);

  // 5. 过滤: lineName + model
  console.log('\n[5] 过滤生效');
  const sr3 = await req('GET','/api/uph-stats?dateFrom=2026-06-20&dateTo=2026-06-25&lineName=ASS_Line2', null, cookie);
  let s3; try{s3=JSON.parse(sr3.body);}catch(e){}
  ck('lineName过滤(total<=全厂)', s3 && s3.summary && s3.summary.total>0 && s3.summary.total<=s.summary.total, 'ASS_Line2 total='+s3?.summary?.total+' (全厂'+s.summary.total+')');
  ck('line_display映射(功放线)', s3 && s3.filters && s3.filters.line_display==='功放线', 'line_display='+s3?.filters?.line_display);
  // 选一个真实机型过滤
  const aModel = s.byModel.slice().sort((a,b)=>b.total-a.total)[0].key;
  const sr4 = await req('GET','/api/uph-stats?dateFrom=2026-06-20&dateTo=2026-06-25&model='+encodeURIComponent(aModel), null, cookie);
  let s4; try{s4=JSON.parse(sr4.body);}catch(e){}
  ck('model过滤(byModel仅1)', s4 && s4.byModel && s4.byModel.length===1, 'model='+aModel+' byModel.len='+s4?.byModel?.length);

  // 6. 交叉矩阵 /api/uph-matrix (机型×线体)
  console.log('\n[6] /api/uph-matrix');
  const mr = await req('GET','/api/uph-matrix?dateFrom=2026-06-20&dateTo=2026-06-25&rowDim=model&colDim=line', null, cookie);
  let m; try { m = JSON.parse(mr.body); } catch(e){ ck('matrix JSON', false, mr.body.slice(0,200)); process.exit(1); }
  ck('matrix success', m.success===true, 'rowDim='+m.rowDim+' colDim='+m.colDim);
  ck('matrix rows非空', Array.isArray(m.rows) && m.rows.length>0, 'rows='+m.rows?.length+' 样例='+m.rows?.slice(0,2).map(r=>r.row+'×'+r.col+'='+r.total).join(' '));
  // stage 筛选: stage=test → rows 应只含测试段工序(若 colDim=operation)
  const msr = await req('GET','/api/uph-matrix?dateFrom=2026-06-20&dateTo=2026-06-25&rowDim=operation&colDim=line&stage=test', null, cookie);
  let ms; try { ms = JSON.parse(msr.body); } catch(e){}
  ck('stage筛选矩阵', ms && ms.success && Array.isArray(ms.rows), 'stage=test rows='+ms?.rows?.length);
  // shift 筛选: shift=day
  const msh = await req('GET','/api/uph-matrix?dateFrom=2026-06-20&dateTo=2026-06-25&rowDim=hour&colDim=line&shift=day', null, cookie);
  let mh; try { mh = JSON.parse(msh.body); } catch(e){}
  ck('shift筛选矩阵', mh && mh.success && Array.isArray(mh.rows), 'shift=day rows='+mh?.rows?.length+' (白班hour8-19)');

  console.log('\n=== '+ok+' 通过 / '+fail+' 失败 ===');
  process.exit(fail?1:0);
})().catch(e=>{console.error('[ERR]',e.message); process.exit(1);});
