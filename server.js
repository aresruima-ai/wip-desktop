require('dotenv').config();
const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const fspath = require('path');
const { TextDecoder } = require('util');
const db = require('./db');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || (process.env.WIP_DESKTOP_MODE === '1' ? '127.0.0.1' : undefined);
const WIP_DESKTOP_MODE = process.env.WIP_DESKTOP_MODE === '1';
const MES_BASE = 'https://lh-cmes.cviauto.cn';
const USERNAME = process.env.MES_USERNAME || '';
const PASSWORD = process.env.MES_PASSWORD || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
if (ADMIN_KEY.length < 16) console.warn(`[SECURITY] ADMIN_KEY 过短(${ADMIN_KEY.length}位), 建议在 .env 设置 ≥16 位随机强口令; 当前弱口令可被暴力枚举, admin 后台有被突破风险`);

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 10 });
let mesCookies = '';
let loginInProgress = null;
let lastSyncTime = null;
let syncCount = 0;
const badFastCache = new Map();

// ===== 通用 TTL 结果缓存 =====
// 数据每 30s 由 syncAndNotify 同步一次, 故缓存新鲜度上限即 30s, 不牺牲任何真实新鲜度。
// 同步完成后 prewarm() 失效+重算最常用 key; 过去日期数据冻结走长 TTL。
// 带 maxEntries 上限: 超限时按写入时间淘汰最旧条目, 防长期运行内存无限增长。
function mkCache(name, ttlMs, maxEntries) {
  const store = new Map();
  maxEntries = maxEntries || 2000;
  const self = {
    name,
    ttlMs,
    get(key) {
      const e = store.get(key);
      if (!e) return undefined;
      if (Date.now() - e.at > e.ttl) { store.delete(key); return undefined; }
      return e.val;
    },
    getWithMeta(key) {
      const e = store.get(key);
      if (!e) return { hit:false };
      if (Date.now() - e.at > e.ttl) { store.delete(key); return { hit:false }; }
      return { hit:true, val:e.val, age:Date.now()-e.at };
    },
    set(key, val, ttlOverride) {
      if (store.size >= maxEntries && !store.has(key)) {
        // 淘汰最旧(at 最小)的条目
        let oldestKey = null, oldestAt = Infinity;
        for (const [k, e] of store) { if (e.at < oldestAt) { oldestAt = e.at; oldestKey = k; } }
        if (oldestKey) store.delete(oldestKey);
      }
      store.set(key, { val, at: Date.now(), ttl: ttlOverride != null ? ttlOverride : ttlMs });
    },
    del(key) { store.delete(key); },
    clear() { store.clear(); },
    invalidate() { store.clear(); },
    store,
  };
  return self;
}
// computeDashboard 结果缓存: 今天短 TTL(15s, 因 30s 同步), 过去日期长 TTL(6h, 数据冻结)
// 今日 TTL=60s: syncAndNotify 实际周期 = syncData(~30s) + prewarm(~14s) ≈ 44s。
// TTL 须 > 实际刷新周期才不出现冷窗; 取 60s 留余量。数据天然 30s 同步延迟, 60s TTL 新鲜度仍受同步延迟约束, 不牺牲真实新鲜度。
const DASH_TTL_TODAY = 60 * 1000;
const DASH_TTL_PAST = 6 * 3600 * 1000;
const dashCache = mkCache('dashboard', DASH_TTL_TODAY);
function dashCacheKey(df, dt, line) { return `${df}|${dt}|${line||''}`; }
function isPastDate(dt) { return dt < localDate(); }
// 引用/字典数据缓存: 60s TTL(配置类数据变更频率低); sync 触发失效
const REF_TTL = 60 * 1000;
const refCache = mkCache('ref', REF_TTL);
// 趋势/汇总等中等 TTL
const TREND_TTL = 60 * 1000;
const trendCache = mkCache('trend', TREND_TTL);

// 带缓存的 computeDashboard 包装: 命中直接返回, 未命中重算并写入(过去日期长 TTL)
let dashInflight = new Map(); // 同 key 并发去重, 避免冷启动惊群
async function computeDashboardCached(df, dt, line='') {
  const key = dashCacheKey(df, dt, line);
  const hit = dashCache.getWithMeta(key);
  if (hit.hit) return { val: hit.val, cached: true, age: hit.age };
  const existing = dashInflight.get(key);
  if (existing) return { val: await existing, cached: false, age: 0 };
  const p = computeDashboard(df, dt, line).then(val => {
    dashCache.set(key, val, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
    return val;
  }).finally(() => { dashInflight.delete(key); });
  dashInflight.set(key, p);
  return { val: await p, cached: false, age: 0 };
}

// OEE 结果计算(供 /api/oee 路由 + board-snapshot + prewarm 共用; 命中 dashCache)
async function computeOeeResult(df, dt, line) {
  const oeeKey=`oee|${df}|${dt}|${line}`;
  const hit = dashCache.getWithMeta(oeeKey);
  if (hit.hit) return hit.val;
  const [oeeData, dailyRaw, downtimePareto, settingsDoc] = await Promise.all([
    db.computeOEE(df,dt,line),
    db.computeOEEDaily(df,dt,line),
    db.computeDowntimePareto(df,dt,line),
    db.getDb().collection('ai_cache').findOne({ai_key:'kpi_targets'}),
  ]);
  const daily = dailyRaw.map(o=>({...o,line_display:lineNameMap[o.line_name]||o.line_name}));
  const summary={};
  oeeData.forEach(o=>{summary[lineNameMap[o.line_name]||o.line_name]=o});
  const _wSum = oeeData.reduce((s,o)=>s+(o.total_output||0),0);
  const _wavg = (k) => oeeData.length>0 ? (_wSum>0 ? +(oeeData.reduce((s,o)=>s+o[k]*(o.total_output||0),0)/_wSum).toFixed(1) : +(oeeData.reduce((s,o)=>s+o[k],0)/oeeData.length).toFixed(1)) : 0;
  const _bd = oeeData.filter(o=>o.breakdown_count>0);
  const _tbd = _bd.reduce((s,o)=>s+o.breakdown_count,0);
  const kpiTargets=(settingsDoc&&settingsDoc.ai_value)||{};
  const _tgtDefault = kpiTargets.oee==null && kpiTargets.mtbf==null && kpiTargets.mttr==null; // 三项目标均未在 admin 配置→前端标注"默认目标",避免把默认值伪装成已设目标
  const result={success:true, daily, summary, targets:{oee:kpiTargets.oee??85,mtbf:kpiTargets.mtbf??3000,mttr:kpiTargets.mttr??90,isDefault:_tgtDefault}, downtimePareto,
    oee:_wavg('oee'), availability:_wavg('availability'), performance:_wavg('performance'), quality:_wavg('quality'),
    mtbf:_tbd>0?+(_bd.reduce((s,o)=>s+(o.mtbf||0)*o.breakdown_count,0)/_tbd).toFixed(1):null,
    mttr:_tbd>0?+(_bd.reduce((s,o)=>s+(o.mttr||0)*o.breakdown_count,0)/_tbd).toFixed(1):null,
    total_output:oeeData.reduce((s,o)=>s+o.total_output,0), breakdown_count:oeeData.reduce((s,o)=>s+o.breakdown_count,0),
    data_quality:{ rows:oeeData.map(o=>({line_name:o.line_name,line_display:lineNameMap[o.line_name]||o.line_name,data_quality:o.data_quality})) }
  };
  dashCache.set(oeeKey, result, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
  return result;
}

// scroll-board 大屏聚合快照计算(供 /api/board-snapshot 路由 + prewarm 共用)
async function computeBoardSnapshot() {
  const t=localDate(), y=(()=>{const d=new Date();d.setDate(d.getDate()-1);return localDate(d);})();
  const w=(()=>{const d=new Date();d.setDate(d.getDate()-6);return localDate(d);})();
  // 复用 computeOeeResult(命中 dashCache, 避免重复 computeOEE)
  const getOeeCached = (df,dt) => computeOeeResult(df,dt,'').catch(()=>null);
  const [dashAll, kpi, kpiY, stage, pareto, ins, badSum, oee, fxOv, fx, cb, health, bp, oeeWeek, shiftCfg, srv] = await Promise.all([
    computeDashboardCached(t,t,'').then(r=>r.val).catch(()=>null),
    computeDashboardCached(t,t,'').then(r=>({oee:(r.val.oee.oee!=null?r.val.oee.oee:null),fpy:r.val.fpy.value,ppm:r.val.ppm.value,upph:r.val.upph.value,mistest:r.val.mistest_rate.value,output:r.val.upph.total_output,output_offline:r.val.upph.offline_output,data_quality:r.val.data_quality})).catch(()=>null),
    computeDashboardCached(y,y,'').then(r=>({oee:(r.val.oee.oee!=null?r.val.oee.oee:null),fpy:r.val.fpy.value,ppm:r.val.ppm.value,upph:r.val.upph.value,output:r.val.upph.total_output})).catch(()=>null),
    db.queryProductionByStage(t,t,'').catch(()=>null),
    db.queryBadPareto(w,t,'').catch(()=>[]),
    computeDashboardCached(t,t,'').then(r=>{
      const d=r.val;const insights=[];
      const mt=d.mistest_rate.value, oe=d.oee.oee, fp=d.fpy.value, pm=d.ppm.value, tot=d.upph.total_output;
      if(mt!=null&&mt>50)insights.push({level:'danger',title:`误测率 ${mt}%`,detail:`测试线误测率 ${mt}%，异常中误测占比偏高`,suggestion:'核查测试设备与参数阈值，区分真不良与误测，避免维修资源浪费'});
      if(oe!=null&&oe<60)insights.push({level:'warning',title:`OEE ${oe}%`,detail:`综合效率 ${oe}% 低于 60% 红线，稼动损失大`,suggestion:'排查停机主因与瓶颈工位节拍，见 OEE 损失归因屏'});
      if(oe!=null&&oe>=85)insights.push({level:'success',title:`OEE ${oe}%`,detail:`综合效率 ${oe}% 达到 85% 目标`,suggestion:'保持当前稼动与节拍节奏'});
      if(fp!=null&&fp<95&&fp>0)insights.push({level:'warning',title:`直通率 ${fp}%`,detail:`直通率 ${fp}% 未达 95% 目标`,suggestion:'聚焦 TOP 不良缺陷与责任工序，见质量根因屏'});
      if(pm!=null&&pm>=2000)insights.push({level:'danger',title:`PPM ${pm}`,detail:`PPM ${pm} 超过 2000 目标线`,suggestion:'召开品质专项会议，按缺陷帕累托攻关前 3 项'});
      if(!insights.length)insights.push({level:'info',title:tot>0?'今日运行正常':'暂无生产数据',detail:tot>0?'各项指标均在正常区间':'当日暂无过站数据',suggestion:tot>0?'继续保持':'待 MES 同步后自动刷新'});
      return {insights};
    }).catch(()=>({insights:[]})),
    db.queryBadSummary(w,t,'').catch(()=>null),
    getOeeCached(t,t),
    db.queryFixtureOverview('').catch(()=>null),
    db.queryFixtures('').catch(()=>[]),
    db.queryAgingCables('').catch(()=>[]),
    Promise.resolve({status:'ok',time:new Date().toISOString(),hasCookie:!!mesCookies,desktopMode:WIP_DESKTOP_MODE}),
    db.queryBadPareto(w,t,'','process').catch(()=>[]),
    getOeeCached(w,t),
    db.getShiftConfigs().catch(()=>[]),
    (async()=>{const mem=process.memoryUsage();return{success:true,data:{uptime:process.uptime(),nodeVersion:process.version,memoryUsage:{rss:Math.round(mem.rss/1024/1024),heapUsed:Math.round(mem.heapUsed/1024/1024)},mesCookie:!!mesCookies,lastSync:lastSyncTime,syncCount,wsClients:(wss&&wss.clients&&wss.clients.size)||0,sessions:sessions.size}};})().catch(()=>null),
  ]);
  return {success:true,
    dashAll, kpi, kpiY, stage, pareto, insights:ins?.insights||[], badSummary:badSum, oee, fixtureOverview:fxOv, fixtures:fx, cables:cb, health, badByProcess:bp||[], oeeWeek, shiftConfigs:shiftCfg, systemStatus:srv?.data||srv
  };
}

// 同步完成后的预热: 后台重算最常用 key(today/各产线)并覆写缓存。
// 注意: 不主动 clear today 的 dashCache(否则会制造冷窗), 仅覆写; 旧值在 TTL(15s)内自然过期或被新值覆盖。
// 数据每 30s 同步, 故 sync 后覆写即可保证新鲜, 无需清空。
const _prewarmLock = { busy:false };
async function prewarmCaches() {
  if (_prewarmLock.busy) return;
  _prewarmLock.busy = true;
  try {
    const t = localDate();
    // 引用数据/趋势缓存可清(便宜, 立即重填)
    trendCache.clear();
    // 后台并发重算今日全量 + 各产线, 覆写缓存(不删旧值, 避免冷窗)
    const lineCodes = Object.keys(lineNameMap);
    const tasks = [
      () => computeDashboardCached(t, t, '').catch(()=>{}),
      ...lineCodes.map(ln => () => computeDashboardCached(t, t, ln).catch(()=>{})),
    ];
    const CONC = 4;
    let idx = 0;
    const runners = Array.from({length: CONC}, async () => {
      while (idx < tasks.length) { const cur = tasks[idx++]; await cur(); }
    });
    await Promise.all(runners);
    // 预热大屏依赖: oee(今天/周) + dashboard(昨天) — 让 board-snapshot 装配即 <50ms
    const y=(()=>{const d=new Date();d.setDate(d.getDate()-1);return localDate(d);})();
    const w=(()=>{const d=new Date();d.setDate(d.getDate()-6);return localDate(d);})();
    await Promise.all([
      computeOeeResult(t,t,'').catch(()=>{}),
      computeOeeResult(w,t,'').catch(()=>{}),
      computeDashboardCached(y,y,'').then(r=>r.val).catch(()=>{}),
    ]);
    // 预热首屏路由 key: dashboard-kpi / dashboard-trend(周) / bad/summary(周) / wip(周) / dashboard-all 明细
    // 这些路由各自有独立 cache key, 预热后首个真实请求即命中, 无冷窗
    await Promise.all([
      prewarmKpi(t, t).catch(e=>console.error('[Prewarm] kpi fail:', e.message)),
      prewarmTrend(w, t).catch(e=>console.error('[Prewarm] trend fail:', e.message)),
      prewarmBadSummary(w, t).catch(e=>console.error('[Prewarm] badSum fail:', e.message)),
      prewarmWip(w, t).catch(e=>console.error('[Prewarm] wip fail:', e.message)),
      prewarmDashboardAll(t, t).catch(e=>console.error('[Prewarm] dashAll fail:', e.message)),
    ]);
    // 预热大屏聚合快照(scroll-board 5min 轮询, 预热后命中即 1ms; 后台跑, 不阻塞请求)
    computeBoardSnapshot().then(r => dashCache.set('board-snapshot', r, 120*1000)).catch(()=>{});
  } finally { _prewarmLock.busy = false; }
}

// —— 首屏路由预热: 复刻各路由的缓存写入逻辑, 供 prewarm 调用 ——
async function prewarmKpi(df, dt) {
  const kpiKey=`kpi|${df}|${dt}`;
  if (dashCache.getWithMeta(kpiKey).hit) return;
  const {val:d} = await computeDashboardCached(df,dt);
  const [openExc, pendingAct, downtimeCount] = await Promise.all([
    db.getExceptions({status:'open'}).then(r=>r.length),
    db.getActionItems({status:{$ne:'done'}}).then(r=>r.length),
    db.getDowntimeRecords(df,dt).then(r=>r.length),
  ]);
  const result={success:true,oee:(d.oee.oee!=null?d.oee.oee:null),fpy:d.fpy.value,ppm:d.ppm.value,upph:d.upph.value,mistest:d.mistest_rate.value,output:d.upph.total_output,output_offline:d.upph.offline_output,openExceptions:openExc,pendingActions:pendingAct,downtimeCount,data_quality:d.data_quality};
  dashCache.set(kpiKey, result, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
}

async function prewarmTrend(df, dt) {
  const tKey=`${df}|${dt}||`;
  if (trendCache.getWithMeta(tKey).hit) return;
  // 复用 dashboard-trend 的 fetchPeriodData 逻辑: 直接调聚合并缓存
  const mongodb = db.getDb();
  const prodCol = mongodb.collection('ai_production');
  const badCol = mongodb.collection('ai_bad_repair');
  const [prodByDay, badItemsRaw] = await Promise.all([
    prodCol.aggregate([
      {$match:db.prefixAi({move_out_date:{$gte:df,$lte:dt}})},
      {$group:{_id:{date:'$ai_move_out_date',sn:'$ai_barcode'}}},
      {$group:{_id:'$_id.date',total:{$sum:1}}},
      {$project:{_id:0,date:'$_id',total:1}}
    ]).toArray(),
    badCol.find(db.prefixAi({test_date:{$gte:df,$lte:dt}}),
      {projection:db.prefixAi({_id:0, test_date:1, barcode:1, content_name:1, causes_name:1, remark:1})}).toArray(),
  ]);
  const badItems = db.stripAi(badItemsRaw);
  const prodMap={}; prodByDay.forEach(d=>{prodMap[d.date]=d.total;});
  const badMap={}, realBadMap={}, seenBad={}, seenReal={};
  badItems.forEach(b=>{
    const date=b.test_date; if(!date)return;
    const sn=b.barcode||('_'+(b.content_name||'')+'_'+(b.causes_name||'')+'_'+(b.remark||''));
    const kb=date+'|'+sn;
    if(!seenBad[kb]){seenBad[kb]=1; badMap[date]=(badMap[date]||0)+1;}
    if(!isMistest(b)&&!seenReal[kb]){seenReal[kb]=1; realBadMap[date]=(realBadMap[date]||0)+1;}
  });
  const days=[]; const d1=new Date(df),d2=new Date(dt);
  for(let dd=new Date(d1);dd<=d2;dd.setDate(dd.getDate()+1)){
    const ds=dd.toISOString().split('T')[0];
    const prod=prodMap[ds]||0, badCnt=badMap[ds]||0, realBad=realBadMap[ds]||0;
    days.push({date:ds,output:prod,bad:badCnt,realBad,rate:prod>0?+((prod-badCnt)/prod*100).toFixed(2):null,ppm:prod>0?Math.round(realBad/prod*1000000):null});
  }
  const totalDays=Math.round((new Date(dt)-new Date(df))/86400000)+1;
  const curTotal=days.reduce((s,d)=>s+d.output,0),curBad=days.reduce((s,d)=>s+d.bad,0),curRealBad=days.reduce((s,d)=>s+(d.realBad||0),0);
  const curRate=curTotal>0?+((curTotal-curBad)/curTotal*100).toFixed(2):null;
  const curPpm=curTotal>0?Math.round(curRealBad/curTotal*1000000):null;
  const result={granularity:'day',current:{days,total:curTotal,bad:curBad,realBad:curRealBad,rate:curRate,ppm:curPpm,avgDaily:totalDays>0?Math.round(curTotal/totalDays):0},previous:{days:[],total:0,bad:0,realBad:0,rate:null,ppm:null,avgDaily:0},change:{output:null,rate:null,ppm:null}};
  trendCache.set(tKey, result, isPastDate(dt) ? DASH_TTL_PAST : TREND_TTL);
}

async function prewarmBadSummary(df, dt) {
  const bsKey=`badSum|${df}|${dt}||0|all|all`; // key须与路由excludeMisce?1:0一致(false->0)否则prewarm填的key路由查不到
  if (dashCache.getWithMeta(bsKey).hit) return;
  const [summary, prodTotal, trend, quality] = await Promise.all([
    db.queryBadSummary(df,dt,null,false,'all','all'),
    db.queryProductionTotal(df,dt,''),
    db.queryBadTrend(df,dt,null,null,'all','all'),
    computeQuality(df,dt,null).catch(()=>null)
  ]);
  const uniqueBad = summary.barcodes ? summary.barcodes.filter(b=>b).length : 0;
  const fpy = prodTotal>0 ? +((prodTotal-uniqueBad)/prodTotal*100).toFixed(2) : null;
  const badRate = prodTotal>0 ? +(uniqueBad/prodTotal*100).toFixed(2) : 0;
  const closureRate = summary.closureRate != null ? summary.closureRate : (summary.total>0 ? +(summary.closed/summary.total*100).toFixed(1) : 0);
  const days = trend.length || 1;
  const dailyAvg = Math.round(uniqueBad/days);
  const defMap={}; (summary.topDefects||[]).forEach(d=>{defMap[d]=(defMap[d]||0)+1;});
  const topDefects=Object.entries(defMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,count])=>({name,count}));
  const rangeDays = Math.max(1, Math.round((new Date(dt)-new Date(df))/86400000)+1);
  const prevTo = new Date(new Date(df).getTime()-86400000).toISOString().split('T')[0];
  const prevFrom = new Date(new Date(prevTo).getTime()-(rangeDays-1)*86400000).toISOString().split('T')[0];
  const [prevSummary, prevProd] = await Promise.all([
    db.queryBadSummary(prevFrom,prevTo,null,false,'all','all'),
    db.queryProductionTotal(prevFrom,prevTo,'')
  ]);
  const prevUniqueBad = prevSummary.barcodes ? prevSummary.barcodes.filter(b=>b).length : 0;
  const prevFpy = prevProd>0 ? +((prevProd-prevUniqueBad)/prevProd*100).toFixed(2) : null;
  const prevBadRate = prevProd>0 ? +(prevUniqueBad/prevProd*100).toFixed(2) : 0;
  const _result={success:true, fpy, badRate, badTotal:uniqueBad, closureRate, dailyAvg, days,
    productionTotal:prodTotal, closedCount:summary.closed, totalRecords:summary.total,
    topDefects, stage:'all', type:'all',
    closureAvgHours: summary.closureAvgHours, closureP50Hours: summary.closureP50Hours,
    closureP90Hours: summary.closureP90Hours, closureCount: summary.closureCount,
    data_quality:{production:prodTotal>0?'real':'empty',fpy:prodTotal>0?'real':'empty'},
    compare:{ prevFpy, prevBadRate, prevBadTotal:prevUniqueBad, fpyDelta:(fpy!=null&&prevFpy!=null)?+(fpy-prevFpy).toFixed(2):null, badRateDelta:+(badRate-prevBadRate).toFixed(2) },
    rework: quality ? { rate: quality.rework_rate, sn_count: quality.rework_sn_count, total_sn: quality.total_sn_count, by_category: quality.rework_by_category || [] } : null
  };
  dashCache.set(bsKey, _result, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
}

async function prewarmWip(df, dt) {
  const wKey=`wip|${df}|${dt}|`;
  if (dashCache.getWithMeta(wKey).hit) return;
  const wipData = await computeWIP(df,dt,'');
  try {
    const opMap = {};
    (await db.getWorkOperations()).forEach(o => { opMap[o.code] = o.name; });
    wipData.by_operation.forEach(op => { op.operation_name = opMap[op.operation] || op.operation; });
  } catch(e) {}
  dashCache.set(wKey, wipData, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
}

async function prewarmDashboardAll(df, dt) {
  const extrasKey=`extras|${df}|${dt}|`;
  if (dashCache.getWithMeta(extrasKey).hit) return;
  const [badItems, hourStats] = await Promise.all([
    db.queryBadItems(df,dt,null),
    db.queryProductionByHour(df,dt,'')
  ]);
  dashCache.set(extrasKey, {badItems, hourStats}, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function decodeMesBuffer(chunks, contentType='') {
  const buf = Buffer.concat(chunks);
  const charset = (contentType.match(/charset=([^;]+)/i)?.[1] || '').toLowerCase();
  const decode = enc => new TextDecoder(enc).decode(buf);
  if (charset.includes('gb')) return decode('gb18030');
  const utf8 = decode('utf-8');
  return utf8.includes('�') ? decode('gb18030') : utf8;
}

// 统一误测判定逻辑 — 前后端共用规则
function isMistest(item) {
  const content = item.content_name || item.contentName || '';
  const causes = item.causes_name || item.causesName || '';
  const remark = item.remark || '';
  return content === '误测' || content === 'NTF' || causes.includes('故障不再现') || remark === '重测';
}

const lineNameMap = {
  'ASS_Line1': '整机1线', 'ASS_Line2': '功放线', 'ASS_Line2-1': '功放2线',
  'ASS_Line3': '整机3线', 'QJG_Line1': '前加工1线屏组件', 'QJG_Line2': '前加工3线屏组件',
  'QJG_Line3': '前加工3线', 'QJG_Line4': '附件盒包装3线', 'PKG_Line1': '包装1线'
};
// 反向映射: 显示名→MES原始code
const lineCodeMap = {};
for (const [code, display] of Object.entries(lineNameMap)) lineCodeMap[display] = code;
// ai_bad_repair/ai_repair_report 的 line_name 历史存中文显示名(整机1线/功放1线), 而 ai_production 存 code(ASS_Line1)。
// 线体筛选传 code, bad 查询用 $in 兼容 code/显示名/显示名变体, 无需数据迁移。
// 功放1线 = ASS_Line2(MES 显示名变体, ASS_Line2 过站17万活跃)
const BAD_LINE_ALIASES = { 'ASS_Line2': ['功放1线'] };
function badLineMatch(lineCode) {
  if (!lineCode) return null;
  const names = [lineCode];
  const display = lineNameMap[lineCode];
  if (display) names.push(display);
  (BAD_LINE_ALIASES[lineCode] || []).forEach(n => names.push(n));
  return { $in: names };
}
// 将前端传来的线体名称（可能是显示名或原始code）解析为数据库查询用的line_name
function resolveLineName(input) {
  if (!input) return '';
  if (lineCodeMap[input]) return lineCodeMap[input];
  return input;
}

// UPH 周期→日期范围(后端版, 与前端 wip-ui.periodRange 口径一致; 供 /api/uph-stats 多粒度累计与环比用)
function uphPeriodRange(period, customRange) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const pad = n => (n < 10 ? '0' : '') + n;
  const fmtD = dt => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  const today = y + '-' + pad(m + 1) + '-' + pad(d);
  switch (period) {
    case 'realtime':
      return { dateFrom: today, dateTo: today, label: '今日', prevFrom: null, prevTo: null };
    case 'week': {
      const dow = now.getDay() || 7;
      const mon = new Date(now); mon.setDate(d - dow + 1);
      return { dateFrom: fmtD(mon), dateTo: today, label: '本周',
        prevFrom: fmtD(new Date(mon.getTime() - 7 * 86400000)), prevTo: fmtD(new Date(mon.getTime() - 86400000)) };
    }
    case 'month': {
      const prevM = m === 0 ? 11 : m - 1, prevY = m === 0 ? y - 1 : y;
      return { dateFrom: y + '-' + pad(m + 1) + '-01', dateTo: today, label: '本月',
        prevFrom: prevY + '-' + pad(prevM + 1) + '-01', prevTo: y + '-' + pad(m + 1) + '-01' };
    }
    case 'quarter': {
      const qs = Math.floor(m / 3) * 3, qStart = y + '-' + pad(qs + 1) + '-01';
      let prevQs = qs - 3, prevY = y; if (prevQs < 0) { prevQs = 9; prevY = y - 1; }
      return { dateFrom: qStart, dateTo: today, label: '本季',
        prevFrom: prevY + '-' + pad(prevQs + 1) + '-01', prevTo: qStart };
    }
    case 'half': {
      const isH1 = m < 6;
      return { dateFrom: y + '-' + (isH1 ? '01' : '07') + '-01', dateTo: today, label: '半年',
        prevFrom: (isH1 ? y - 1 : y) + '-' + (isH1 ? '07' : '01') + '-01',
        prevTo: y + '-' + (isH1 ? '01' : '07') + '-01' };
    }
    case 'year':
      return { dateFrom: y + '-01-01', dateTo: today, label: '年度',
        prevFrom: (y - 1) + '-01-01', prevTo: (y - 1) + '-12-31' };
    case 'custom': {
      const c = customRange;
      if (!c || !c.dateFrom || !c.dateTo) return null;
      const cf = new Date(c.dateFrom + 'T00:00:00'), ct = new Date(c.dateTo + 'T00:00:00');
      const cdays = Math.round((ct - cf) / 86400000);
      return { dateFrom: c.dateFrom, dateTo: c.dateTo, label: c.label || '自定义',
        prevFrom: fmtD(new Date(cf.getTime() - (cdays + 1) * 86400000)), prevTo: fmtD(new Date(cf.getTime() - 86400000)) };
    }
    default:
      return { dateFrom: today, dateTo: today, label: '今日', prevFrom: null, prevTo: null };
  }
}

// ===== Session =====
const sessions = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;
function parseCookies(h) { const c = {}; if (!h) return c; h.split(';').forEach(s => { const [k,...v] = s.trim().split('='); if(k) c[k]=v.join('='); }); return c; }
function isAuth(req) { const t = parseCookies(req.headers.cookie).session; if(!t) return false; const s = sessions.get(t); if(!s) return false; if(Date.now()-s.created>SESSION_TTL){sessions.delete(t);return false;} return s; }
const WHITELIST = ['/login.html','/api/login','/api/admin-login','/api/health','/api/health/ping','/common.css','/common.js','/nav.js','/filter-bar.js','/wip-ui.js','/chart-theme.js','/sw.js','/manifest.json','/favicon.ico','/libs/echarts.min.js','/libs/echarts-liquidfill.min.js','/bad-core.js','/bad-charts.js','/bad-table.js','/bad-spc.js','/bad-ai.js','/images/logo-sm.png','/images/favicon.svg'];
const WIP_DESKTOP_WHITELIST = new Set([
  '/',
  '/wip.html',
  '/api/wip',
  '/api/wip/overview',
  '/api/wip/by-batch',
  '/api/wip/sns-by-order',
  '/api/wip/detail',
  '/api/wip/cycle-detail',
  '/api/wip/snapshots',
  '/api/delivery/detail',
  '/api/process-routes',
  '/api/work-order-progress',
  '/api/lines',
  '/api/sync',
  '/api/shift-config'
]);
function isWhitelisted(p) { if(WHITELIST.includes(p)) return true; if(p.startsWith('/images/')||p.startsWith('/libs/')) return true; return false; }
function isLocalRequest(req) {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}
function isWipDesktopAllowed(req, p) {
  return WIP_DESKTOP_MODE && isLocalRequest(req) && (WIP_DESKTOP_WHITELIST.has(p) || isWhitelisted(p));
}

// ===== MES Login =====
async function mesLogin() {
  if (loginInProgress) return loginInProgress;
  loginInProgress = (async () => {
    let browser = null;
    try {
      console.log('[MES] Puppeteer登录...');
      // 桌面端:探测系统浏览器作为 Puppeteer 可执行路径(PUPPETEER_SKIP_DOWNLOAD=1 无自带 Chromium)。
      // 跨平台:Windows 优先 Edge,macOS 优先 Chrome(Puppeteer 在 Mac 用 Chrome 更稳)。
      let _edgePath = null;
      try {
        const _edgeCandidates = process.platform === 'darwin' ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ] : [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ];
        for (const _p of _edgeCandidates) { if (fs.existsSync(_p)) { _edgePath = _p; break; } }
      } catch(_e) { _edgePath = null; }
      const _launchOpts = { headless: 'new', args: ['--no-sandbox','--ignore-certificate-errors'] };
      if (_edgePath) _launchOpts.executablePath = _edgePath;
      browser = await puppeteer.launch(_launchOpts);
      const page = await browser.newPage();
      await page.goto(MES_BASE + '/login?callback=%2F', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      const inputs = await page.$$('input[type="text"], input:not([type])');
      const pwds = await page.$$('input[type="password"]');
      if (inputs.length > 0 && pwds.length > 0) {
        await inputs[inputs.length-1].focus(); await page.keyboard.type(USERNAME);
        await pwds[0].focus(); await page.keyboard.type(PASSWORD);
        const btn = await page.$('button[type="submit"], .ant-btn-primary');
        if (btn) await btn.click();
      }
      await page.waitForFunction(() => !location.href.includes('/login'), {timeout:10000}).catch(()=>{});
      const cookies = await page.cookies();
      const info = cookies.find(c => c.name === 'cmes-lh-info');
      if (info) mesCookies = `cmes-lh-info=${info.value}`;
      console.log('[MES] 登录成功');
    } catch(e) { console.error('[MES] 登录失败:', e.message); }
    finally { if (browser) { try { await browser.close(); } catch(_e){} } }
    loginInProgress = null;
  })();
  return loginInProgress;
}

// ===== MES Request =====
async function mesReqInner(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, MES_BASE);
    const opts = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method, agent: httpsAgent, timeout: 15000, headers: { 'Cookie': mesCookies, 'Content-Type': 'application/json' } };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      const chunks=[]; res.on('data',c=>chunks.push(Buffer.from(c)));
      res.on('end',()=>{
        const d=decodeMesBuffer(chunks,res.headers['content-type']||'');
        if(res.statusCode===401||res.statusCode===302||(res.statusCode===200&&d.includes('"login"')&&d.includes('callback'))){
          resolve({__needRelogin:true});
        } else {
          try{resolve(JSON.parse(d))}catch(e){resolve(null)}
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function mesReq(method, urlPath, body) {
  let result = await mesReqInner(method, urlPath, body);
  if(result && result.__needRelogin) {
    console.log('[MES] Cookie过期，自动重新登录...');
    await mesLogin();
    result = await mesReqInner(method, urlPath, body);
    if(result && result.__needRelogin) { console.error('[MES] 重新登录后仍无法访问'); return null; }
  }
  return result;
}

// ===== MES Fetchers =====
async function fetchTaskOrders() {
  const d = await mesReq('GET', '/frontApi/prod/api/services/mreport/TaskOrderReport/GetTaskOrderReportInputs?maxResultCount=100&skipCount=0');
  return d?.result?.items || [];
}
async function fetchMoveOut(start, end, skip=0, max=500) {
  const d = await mesReq('POST', '/frontApi/prod/api/services/mreport/ProducesReport/ContainerMoveOutHistory', JSON.stringify({moveOutTimeFrom:start,moveOutTimeTo:end,MoveOutStatus:1,moveOutType:1,skipCount:skip,maxResultCount:max}));
  return d?.result || {};
}
async function fetchRepair(date, page=0, size=200) {
  const d = await mesReq('POST', '/frontApi/mfgNode/msys_apis/cir_tool/view/render', JSON.stringify({
    pageNum:page, pageSize:size, viewId:'a6d231284a23406b90a4eaaa1ae44e7b', isCustomerView:'0', isAsyncPage:'0', viewDatasourceId:'c9073fd5c83349b6a0a69dbf93e5cc54',
    advConditions:`[{"caseSensitive":"1","conn":"and","field":"test_time","left":"(","val":"${date}","opt":"ge","right":"","type":"date"},{"caseSensitive":"1","conn":"and","field":"test_time","left":"","val":"${date}","opt":"le","right":")","type":"date"}]`
  }));
  return d?.data || {};
}
function extractMesItems(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d.data?.items)) return d.data.items;
  if (Array.isArray(d.result)) return d.result;
  if (Array.isArray(d.result?.items)) return d.result.items;
  if (Array.isArray(d.result?.data)) return d.result.data;
  if (Array.isArray(d.result?.result)) return d.result.result;
  return [];
}
async function fetchUPH() { const d = await mesReq('GET','/frontApi/prod/api/services/bas/MachinePartsUph/GetList?maxResultCount=200&skipCount=0'); return d?.result?.items||[]; }
async function fetchCapacityData() { const d = await mesReq('GET','/frontApi/prod/api/services/bas/CapacityDataSet/GetPageList?isDeleted=false&maxResultCount=9999&skipCount=0'); return d?.result?.items||[]; }
// 任务单切换过站工时(moveOutWorkHours=工序级真实净生产工时, UPH实际分母源)
async function fetchTaskMoveRecords(skip=0, max=500) { const d = await mesReq('GET',`/frontApi/prod/api/services/mbiz/DailyReport/GetTaskMoveRecordPages?maxResultCount=${max}&skipCount=${skip}`); return { items: d?.result?.items||[], totalCount: d?.result?.totalCount||0 }; }
async function fetchMESLines() { const d = await mesReq('GET','/frontApi/prod/api/services/bas/Line/GetPageList?isDeleted=false&maxResultCount=9999'); return d?.result?.items||[]; }
async function fetchWorkOperations() {
  const paths = [
    '/frontApi/prod/api/services/main-data/WorkOperation/GetCacheAllList',
    '/frontApi/prod/api/services/bas/WorkOperation/GetPageList?maxResultCount=9999&skipCount=0',
    '/frontApi/prod/api/services/bas/WorkOperation/GetPageList?isDeleted=false&maxResultCount=9999&skipCount=0',
    '/frontApi/prod/api/services/bas/WorkOperation/GetList?maxResultCount=9999&skipCount=0',
    '/frontApi/prod/api/services/bas/WorkOperation/GetAll?maxResultCount=9999&skipCount=0'
  ];
  for (const path of paths) {
    const d = await mesReq('GET', path);
    const items = extractMesItems(d);
    if (items.length) return items;
  }
  console.log('[Sync] 工序接口返回为空');
  return [];
}
async function fetchProcessRoutes() {
  const paths = [
    '/frontApi/prod/api/services/bas/ProcessRoute/GetProcessRoutes',
    '/frontApi/prod/api/services/bas/ProcessRoute/GetPageList?maxResultCount=9999&skipCount=0',
    '/frontApi/prod/api/services/bas/ProcessRoute/GetPageList?isDeleted=false&maxResultCount=9999&skipCount=0',
    '/frontApi/prod/api/services/bas/ProcessRoute/GetList?maxResultCount=9999&skipCount=0',
    '/frontApi/prod/api/services/bas/ProcessRoute/GetAll?maxResultCount=9999&skipCount=0'
  ];
  for (const path of paths) {
    const d = await mesReq('GET', path);
    const items = extractMesItems(d);
    if (items.length) return items;
  }
  console.log('[Sync] 工艺路线接口返回为空');
  return [];
}
// 任务单列表(bas/TaskOrder/GetList) — 提供 task_id/lineCode/productPartName,用于按任务拉工艺路线
async function fetchTaskOrderList(skip=0, max=500) {
  const d = await mesReq('GET', `/frontApi/prod/api/services/bas/TaskOrder/GetList?MaxResultCount=${max}&SkipCount=${skip}`);
  return d?.result || {};
}
// 工艺路线获取(bas/TaskOrder/GetStageList) — 按任务单取权威工序列表+sortNo(MES 真实路线入口)
// 注:ProcessRoute/GetProcessRoutes 对本账号返回空(主数据模块未启用),真实路线在 TaskOrder 模块下
async function fetchTaskStageList(taskId) {
  const d = await mesReq('GET', `/frontApi/prod/api/services/bas/TaskOrder/GetStageList?TaskId=${encodeURIComponent(taskId)}`);
  if (Array.isArray(d?.result)) return d.result;
  return d?.result?.items || [];
}
// 任务单 productPartName 形如 "VQC1006-A,332BEV高通6..." → 取逗号前产品型号,对齐 ai_production.product_model
function productModelFromPartName(partName) {
  if (!partName) return '';
  const i = partName.indexOf(',');
  return (i >= 0 ? partName.slice(0, i) : partName).trim();
}
// 工序归一化平均位置:op 在所有 mes 路线里 sortNo÷该路线工序数 的平均(0~1)。
// 用于跨产品合并工位(line-balance/factory-3d)的稳定排序——末道(B50)各路线都末道→≈1排末尾,首道→≈0排前,
// 避免 by_operation last_sort 跨产品漂移。无 mes 路线命中返回 null。
function opNormPos(mesRoutes, opCode) {
  if (!mesRoutes || !mesRoutes.length || !opCode) return null;
  let sum = 0, n = 0;
  for (const r of mesRoutes) {
    if (r.source !== 'mes') continue;
    const ops = r.operations || [];
    const len = ops.length || 1;
    const o = ops.find(x => x.name === opCode);
    if (o && o.sort_no != null) { sum += o.sort_no / len; n++; }
  }
  return n > 0 ? sum / n : null;
}
// 每工序相邻过站间隔 P25(秒):近似单台纯处理时间( fastest 25% 样本接近无等待排队)。
// 用于 line-balance 的 CT —— P50 含排队等待偏大(包装前堆积→6.7h),3600/UPH 对并行工位偏低;
// P25 取快速通过样本,最接近真实处理节拍。样本<3 跳过。
async function computeOpWaitP25(dateFrom, dateTo, lineName) {
  const prodCol = db.getDb().collection('ai_production');
  const match = { move_out_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) match.line_name = lineName;
  const snOps = await prodCol.aggregate([
    { $match: db.prefixAi(match) },
    { $sort: { ai_move_out_time: 1 } },
    { $group: { _id: { barcode: '$ai_barcode', op: '$ai_work_operation_code' }, move_time: { $last: '$ai_move_out_time' } } }
  ]).toArray();
  const snMap = {};
  for (const r of snOps) {
    if (!snMap[r._id.barcode]) snMap[r._id.barcode] = [];
    snMap[r._id.barcode].push({ op: r._id.op, time: new Date(r.move_time) });
  }
  const opGaps = {}; // op -> [gap_seconds...]
  for (const records of Object.values(snMap)) {
    records.sort((a,b) => a.time - b.time);
    for (let i = 1; i < records.length; i++) {
      const gapS = (records[i].time - records[i-1].time) / 1000;
      if (gapS > 0 && gapS < 72*3600) { // 排除跨天异常(>72h)
        (opGaps[records[i].op] = opGaps[records[i].op] || []).push(gapS);
      }
    }
  }
  const result = {};
  for (const [op, gaps] of Object.entries(opGaps)) {
    if (gaps.length < 3) continue; // 样本不足跳过
    gaps.sort((a,b) => a - b);
    const idx = Math.max(0, Math.floor(gaps.length * 0.25)); // P25
    result[op] = gaps[idx];
  }
  return result;
}
async function fetchWorkCenters() { const d = await mesReq('GET','/frontApi/prod/api/services/bas/WorkCenter/GetPageList?maxResultCount=9999&skipCount=0'); return d?.result?.items||[]; }
async function fetchProducts() { const d = await mesReq('GET','/frontApi/prod/api/services/bas/Product/GetPageList?maxResultCount=9999&skipCount=0'); return d?.result?.items||[]; }
async function fetchMachines() { const d = await mesReq('GET','/frontApi/prod/api/services/bas/Machine/GetPageList?maxResultCount=9999&skipCount=0'); return d?.result?.items||[]; }
async function fetchEquipmentDowntime(start, end) { const d = await mesReq('GET',`/frontApi/prod/api/services/mfg/EquipmentDowntime/GetPageList?startTime=${start}&endTime=${end}&maxResultCount=9999&skipCount=0`); return d?.result?.items||[]; }
async function fetchMoveIn(start, end, skip=0, max=500) {
  const d = await mesReq('POST','/frontApi/prod/api/services/mreport/ProducesReport/ContainerMoveInHistory', JSON.stringify({moveInTimeFrom:start,moveInTimeTo:end,moveInType:1,skipCount:skip,maxResultCount:max}));
  return d?.result || {};
}

// ===== 12-KPI Phase1 Fetchers =====
// 工单(计划达成率) — 全量快照
async function fetchMoOrders(skip=0, max=500) {
  const d = await mesReq('GET', `/frontApi/prod/api/services/bas/MoOrder/GetMoOrderList?MaxResultCount=${max}&SkipCount=${skip}`);
  return d?.result || {};
}
// 任务单WIP(在制周期) — 全量快照
async function fetchTaskOrderWip(skip=0, max=500) {
  const d = await mesReq('GET', `/frontApi/prod/api/services/mreport/TaskOrderWip/GetList?MaxResultCount=${max}&SkipCount=${skip}`);
  return d?.result || {};
}
// 维修报表(返工率) — 按日期增量 (注: TestStime/TestEtime会500，实际可用 StartTime/EndTime)
async function fetchRepairReport(date, skip=0, max=200) {
  const d = await mesReq('GET', `/frontApi/prod/api/services/test/TestRepair/GetRepairReport?StartTime=${encodeURIComponent(date+' 00:00:00')}&EndTime=${encodeURIComponent(date+' 23:59:59')}&MaxResultCount=${max}&SkipCount=${skip}`);
  return d?.result || {};
}

// 通用分页同步器: 翻页直到取完或达上限
async function syncPaged(fetcher, inserter, opts={}) {
  const { max=500, maxPages=50, polite=200, label='Sync' } = opts;
  let skip=0, total=0, mesTotal=null, page=0;
  while (page < maxPages) {
    const r = await fetcher(skip, max);
    const items = r.items || r.list || (Array.isArray(r)?r:[]) || [];
    if (mesTotal === null) mesTotal = r.totalCount ?? r.total ?? null;
    if (!items.length) break;
    await inserter(items);
    total += items.length; skip += items.length; page++;
    if (mesTotal && total >= mesTotal) break;
    if (items.length < max) break;
    await sleep(polite);
  }
  return { total, mesTotal, pages: page };
}

// 日期增量同步: 维修报表
async function syncRepairReportForDate(date) {
  try {
    const r = await syncPaged((skip,max)=>fetchRepairReport(date,skip,max), db.insertRepairReport, {max:200, label:'RepairReport'});
    if (r.total) console.log(`[Sync] 维修报表 ${r.total} date=${date}`);
    return r.total;
  } catch(e) { console.log('[Sync] 维修报表跳过:', e.message?.substring(0,80)); return 0; }
}
// 全量快照同步(5分钟周期): 工单/WIP
async function syncSnapshotSources() {
  if (!mesCookies) return;
  try {
    const mo = await syncPaged(fetchMoOrders, db.insertMoOrders, {max:500, polite:300, label:'MoOrder'});
    if (mo.total) console.log(`[Sync] 工单快照 ${mo.total}`);
  } catch(e) { console.log('[Sync] 工单快照跳过:', e.message?.substring(0,80)); }
  try {
    const wip = await syncPaged(fetchTaskOrderWip, db.insertTaskOrderWip, {max:500, polite:300, label:'TaskOrderWip'});
    if (wip.total) console.log(`[Sync] WIP快照 ${wip.total}`);
  } catch(e) { console.log('[Sync] WIP快照跳过:', e.message?.substring(0,80)); }
}

async function deriveRoutesFromProduction() {
  const mongodb = db.getDb();
  const prod = mongodb.collection('ai_production');
  const routeCol = mongodb.collection('ai_process_routes');
  const opCol = mongodb.collection('ai_work_operations');
  const groups = await prod.aggregate([
    {$match:db.prefixAi({line_name:{$ne:''},product_model:{$ne:''},work_operation_code:{$ne:''}})},
    {$group:{_id:{line:'$ai_line_name',product:'$ai_product_model',op:'$ai_work_operation_code'},count:{$sum:1},sort_no:{$min:'$ai_sort_no'},name:{$max:'$ai_work_operation_name'}}},
    {$group:{_id:{line:'$_id.line',product:'$_id.product'},ops:{$push:{code:'$_id.op',name:'$name',count:'$count',sort_no:'$sort_no'}},total:{$sum:'$count'}}}
  ]).toArray();
  let routeWritten = 0;
  const opMap = new Map();
  for (const g of groups) {
    // 已有 MES 权威路线的 (line,product) 跳过,不被 derived 覆盖(sortNo 漂移的 derived 不应盖掉权威 mes)
    const existing = db.stripAi(await routeCol.findOne(db.prefixAi({line_name:g._id.line, product_model:g._id.product}), {projection:{ai_source:1}}));
    if (existing && existing.source === 'mes') continue;
    const operations = (g.ops||[])
      .filter(o=>o.code)
      .sort((a,b)=>(a.sort_no??999)-(b.sort_no??999)||b.count-a.count)
      .map(o=>({name:o.code,sort_no:o.sort_no??999,source:'derived',sample_count:o.count}));
    if (!operations.length) continue;
    await routeCol.replaceOne(
      db.prefixAi({line_name:g._id.line,product_model:g._id.product}),
      db.prefixAi({line_name:g._id.line,product_model:g._id.product,operations,source:'derived_from_production',sample_total:g.total,synced_at:Date.now()}),
      {upsert:true}
    );
    routeWritten++;
    (g.ops||[]).forEach(o=>{
      if (!o.code) return;
      const name = o.name || o.code;
      const prev = opMap.get(o.code);
      if (!prev || (prev.name === prev.code && name !== o.code)) opMap.set(o.code,{name,sort_no:o.sort_no??999});
    });
  }
  for (const [code, meta] of opMap) {
    await opCol.updateOne(
      db.prefixAi({code}),
      db.prefixAi({$setOnInsert:{code,name:meta.name,source:'derived_from_production'},$set:{sort_no:meta.sort_no,derived_at:Date.now()}}),
      {upsert:true}
    );
  }
  if (routeWritten || opMap.size) console.log(`[Sync] 推导路线 ${routeWritten} 工位 ${opMap.size}`);
  return {routeWritten, opWritten:opMap.size};
}

// 同步 MES 权威工艺路线(TaskOrder/GetStageList):按近7天活跃 (line,product) 取最新任务单的工序列表+sortNo
// 解决 derived 路线 sort_no 跨产品漂移导致排序错乱的问题。derive 降级为兜底(覆盖未命中线体)。
async function syncTaskRoutes() {
  const mongodb = db.getDb();
  const prodCol = mongodb.collection('ai_production');
  const routeCol = mongodb.collection('ai_process_routes');
  // 1) 近30天活跃 (line,product) 组合 — 覆盖目标(扩大窗口;近30天无过站的停产线用 derived 兜底,不展示无影响)
  const sinceAgo = new Date(Date.now() - 30*86400000).toISOString().slice(0, 10);
  const active = await prodCol.aggregate([
    {$match:db.prefixAi({move_out_date:{$gte:sinceAgo}, line_name:{$ne:''}, product_model:{$ne:''}})},
    {$group:{_id:{line:'$ai_line_name', product:'$ai_product_model'}, cnt:{$sum:1}}},
    {$sort:{cnt:-1}}
  ]).toArray();
  const activeKeys = new Set(active.map(a => a._id.line + '|' + a._id.product));
  console.log(`[Sync] 权威路线:活跃(line,product) ${active.length} 个待覆盖`);
  if (!activeKeys.size) return { written:0, matched:0, failed:0 };
  // 2) 翻页取任务单,按 (lineCode, product) 取 creationTime 最新任务(cancel 跳过)
  const byKey = {}; // key -> {taskId, taskNo, bopVer, creationTime}
  let skip=0, pages=0, total=null;
  while (pages < 20) {
    const r = await fetchTaskOrderList(skip, 500);
    const items = r.items || [];
    if (total === null) total = r.totalCount || 0;
    if (!items.length) break;
    for (const t of items) {
      if (t.taskMesStatus === 19) continue; // 跳过 cancel
      const line = t.lineCode || '';
      const product = productModelFromPartName(t.productPartName);
      if (!line || !product) continue;
      const key = line + '|' + product;
      if (!activeKeys.has(key)) continue; // 只关心近7天活跃组合
      const ct = t.creationTime ? new Date(t.creationTime).getTime() : 0;
      const prev = byKey[key];
      if (!prev || ct > prev.creationTime) {
        byKey[key] = { taskId: t.id, taskNo: t.taskNo, bopVer: (t.bopId||'')+'/'+(t.bopVersion||''), creationTime: ct };
      }
    }
    skip += items.length;
    pages++;
    if (Object.keys(byKey).length >= activeKeys.size) break; // 全覆盖提前停
    if (items.length < 500) break;
    await sleep(300);
  }
  const matched = Object.keys(byKey).length;
  console.log(`[Sync] 权威路线:扫描任务单 ${skip} 条,匹配活跃组合 ${matched}/${activeKeys.size}`);
  // 3) 逐个调 GetStageList,写权威路线(source:mes)
  let written=0, failed=0;
  for (const [key, info] of Object.entries(byKey)) {
    const idx = key.indexOf('|');
    const line = key.slice(0, idx), product = key.slice(idx+1);
    try {
      const stages = await fetchTaskStageList(info.taskId);
      if (!stages.length) { failed++; continue; }
      const operations = stages
        .map(s => ({
          name: s.workOperationCode || '',
          display_name: s.workOperationName || s.workOperationCode || '',
          sort_no: s.sortNo ?? 999,
          work_operation_id: s.workOperationId || '',
          op_type: s.operationType ?? null,
          node_type: s.nodeType ?? null
        }))
        .filter(o => o.name)
        .sort((a,b) => (a.sort_no ?? 9999) - (b.sort_no ?? 9999));
      if (!operations.length) { failed++; continue; }
      await routeCol.replaceOne(
        db.prefixAi({line_name:line, product_model:product}),
        db.prefixAi({line_name:line, product_model:product, operations, source:'mes', task_no:info.taskNo, bop_version:info.bopVer, synced_at:Date.now()}),
        {upsert:true}
      );
      written++;
      await sleep(250);
    } catch(e) { failed++; console.log('[Sync] 权威路线失败 '+info.taskNo+':', (e.message||'').substring(0,60)); }
  }
  console.log(`[Sync] 权威路线写入 ${written} 失败 ${failed}`);
  return { written, matched, failed };
}

// ===== Sync =====
// 同步完整性记录
const syncLog = new Map(); // date -> {mesTotal, syncedTotal, complete}

async function syncRepairForDate(date) {
  let badTotal=0, page=0, mesTotal=null, retries=0;
  while(true) {
    const r = await fetchRepair(date,page,200);
    const items=r.list||[];
    if (mesTotal===null) mesTotal = r.total;
    if(!items.length) {
      // 如果MES声明有数据但返回空，重试一次
      if(mesTotal>0 && badTotal<mesTotal && retries<2) { retries++; await sleep(500); continue; }
      break;
    }
    retries=0;
    await db.insertBadRepair(items);
    badTotal+=items.length;
    page++;
    // 安全终止: 已拉取量>=MES声明总量 或 超过50页兜底
    if(mesTotal && mesTotal>0 && badTotal>=mesTotal) break;
    if(page>50) { console.log(`[Sync] 不良翻页超过50页，强制停止 date=${date}`); break; }
    await sleep(200);
  }
  const complete = (mesTotal==null||mesTotal===0) ? (badTotal===0) : (badTotal>=mesTotal);
  syncLog.set(date, {mesTotal:mesTotal||0, syncedTotal:badTotal, complete, time:Date.now()});
  if(!complete) console.log(`[Sync] ⚠ 不良数据不完整 date=${date} MES声明${mesTotal} 实际获取${badTotal}`);
  return badTotal;
}

async function syncData(date) {
  if (!mesCookies) { console.log('[Sync] 无cookie'); return; }
  console.log(`[Sync] ${date}...`);
  try {
    const tasks = await fetchTaskOrders();
    if (tasks.length) await db.insertTaskOrders(tasks);

    const start = `${date} 00:00:00`, end = `${date} 23:59:59`;
    let total=0, skip=0;
    while(true) { const r = await fetchMoveOut(start,end,skip,500); const items=r.items||[]; if(!items.length)break; await db.insertProduction(items); total+=items.length; skip+=items.length; if(items.length<500)break; await sleep(300); }

    // 不良数据同步（含翻页容错和完整性校验）
    const badTotal = await syncRepairForDate(date);

    const uph = await fetchUPH();
    for (const u of uph) { if(u.productModel&&u.uphValue>0) await db.saveProduct({product_model:u.productModel,cycle_time:Math.round(3600/u.uphValue),uph:u.uphValue,work_center:u.workCenterName||''}); }

    // 产能数据集(工序级·机型×工艺段×工序) — UPH目标基准, 随syncData同步(154条一次拉完, 轻量)
    try { const cap = await fetchCapacityData(); if (cap && cap.length) await db.saveCapacityData(cap); }
    catch(e) { console.log('[Sync] 产能数据集同步跳过:', e.message?.substring(0,80)); }

    // 任务单切换过站工时(moveOutWorkHours) — UPH实际分母, 拉最近1天增量(历史走backfill)
    try {
      const ds = date; const dsEnd = date;
      let skip=0, n=0;
      while(true) { const r = await fetchTaskMoveRecords(skip, 500); const items = r.items.filter(x => (x.produceDate||'').slice(0,10)===ds); if (items.length) n += await db.saveTaskMoveHours(items); skip += r.items.length; if (r.items.length<500 || skip>=r.totalCount) break; await sleep(200); }
      if (n) console.log(`[Sync] 过站工时 ${date} +${n}`);
    } catch(e) { console.log('[Sync] 过站工时同步跳过:', e.message?.substring(0,80)); }

    const lines = await fetchMESLines();
    for (const l of lines) await db.upsertLineFromMes({line_name:l.code,line_display:lineNameMap[l.code]||l.name});

    let syncedOpsFromMes = false;
    let syncedRoutesFromMes = false;

    // 同步工序数据
    try {
      const ops = await fetchWorkOperations();
      if (ops.length) {
        syncedOpsFromMes = true;
        const opCol = db.getDb().collection('ai_work_operations');
        for (const op of ops) {
          const code = op.code || op.workOperationCode || op.work_operation_code || op.operationCode || op.id || '';
          const name = op.name || op.workOperationName || op.work_operation_name || op.operationName || op.displayName || code;
          if (!code) continue;
          await opCol.replaceOne(db.prefixAi({code}),db.prefixAi({code,name,mes_id:op.id||'',sort_no:op.sortNo??op.sort_no??op.sequence??999,synced_at:Date.now(),source:'mes'}),{upsert:true});
        }
        console.log(`[Sync] 工序 ${ops.length}`);
      }
    } catch(e) { console.log('[Sync] 工序同步跳过:', e.message?.substring(0,60)); }

    // 同步工艺路线 — 权威源:TaskOrder/GetStageList(按任务单,sortNo 干净唯一)
    // ProcessRoute/GetProcessRoutes 对本账号返回空,故弃用;真实路线在 TaskOrder 模块下
    try {
      const r = await syncTaskRoutes();
      syncedRoutesFromMes = r.written > 0;
    } catch(e) { console.log('[Sync] 权威路线同步跳过:', e.message?.substring(0,80)); }
    // derive 兜底:仅覆盖 MES 未命中的 (line,product);已落 source:mes 的跳过不覆盖
    await deriveRoutesFromProduction().catch(e => console.log('[Sync] 推导兜底失败:', e.message?.substring(0,80)));

    // 同步设备停机
    try {
      const dtItems = await fetchEquipmentDowntime(start, end);
      if (dtItems.length) {
        for (const d of dtItems) {
          const dur = d.duration || (d.endTime && d.startTime ? Math.round((new Date(d.endTime)-new Date(d.startTime))/60000) : 0);
          await db.insertDowntime({line_name:d.lineCode||d.lineName||'',date,downtime_category:d.category||'breakdown',duration:dur,reason:d.reason||d.remark||'',start_time:d.startTime||'',source:'mes'});
        }
        console.log(`[Sync] 设备停机 ${dtItems.length}`);
      }
    } catch(e) { console.log('[Sync] 停机同步跳过:', e.message?.substring(0,60)); }

    // 同步设备清单
    try {
      const machines = await fetchMachines();
      if (machines.length) {
        const machCol = db.getDb().collection('ai_machines');
        for (const m of machines) await machCol.replaceOne(db.prefixAi({code:m.code}),db.prefixAi({code:m.code,name:m.name,line_name:m.lineCode||'',work_center:m.workCenterCode||'',status:m.status||'',synced_at:Date.now()}),{upsert:true});
        console.log(`[Sync] 设备 ${machines.length}`);
      }
    } catch(e) { console.log('[Sync] 设备同步跳过:', e.message?.substring(0,60)); }

    // 同步产品主数据
    try {
      const prods = await fetchProducts();
      if (prods.length) {
        for (const p of prods) await db.saveProduct({product_model:p.code||p.productModel,name:p.name||'',cycle_time:p.cycleTime||0,uph:p.uph||0,work_center:p.workCenterCode||''});
        console.log(`[Sync] 产品 ${prods.length}`);
      }
    } catch(e) { console.log('[Sync] 产品同步跳过:', e.message?.substring(0,60)); }

    // 同步工作中心
    try {
      const wcs = await fetchWorkCenters();
      if (wcs.length) {
        const wcCol = db.getDb().collection('ai_work_centers');
        for (const w of wcs) await wcCol.replaceOne(db.prefixAi({code:w.code}),db.prefixAi({code:w.code,name:w.name,line_name:w.lineCode||'',synced_at:Date.now()}),{upsert:true});
        console.log(`[Sync] 工作中心 ${wcs.length}`);
      }
    } catch(e) { console.log('[Sync] 工作中心同步跳过:', e.message?.substring(0,60)); }

    // 12-KPI Phase1: 质量域日期增量(维修报表)
    await syncRepairReportForDate(date).catch(()=>{});

    lastSyncTime = new Date().toISOString();
    syncCount++;
    badFastCache.clear();
    console.log(`[Sync] 完成: 工单${tasks.length} 过站${total} 不良${badTotal}`);
  } catch(e) { console.error('[Sync]', e.message); }
}

// 历史回补同步：回溯N天更新闭环状态和补充缺失数据
async function syncHistoryBackfill(days=7) {
  if (!mesCookies) return;
  // [诊断] 同步写日志确保崩溃前落盘(排查 ~8分43秒周期性无日志崩溃, 2026-06-26)
  // console.log 对文件 stdout 异步, 崩溃前最后一条可能丢失; appendFileSync 同步落盘。
  const _bfLog = (m) => { try { fs.appendFileSync(`${__dirname}/backfill_debug.log`, `[${new Date().toISOString()}] ${m}\n`); } catch(_){} };
  const t0 = Date.now();
  _bfLog(`=== Backfill 开始 days=${days} @+0ms ===`);
  console.log(`[Backfill] 回补最近${days}天...`);
  const today = new Date();
  for (let i=1; i<=days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate()-i);
    const dateStr = d.toISOString().split('T')[0];
    const tDay = Date.now();
    try {
      _bfLog(`day ${i}/${days} ${dateStr} syncRepairForDate 开始 @+${Date.now()-t0}ms`);
      await syncRepairForDate(dateStr);
      _bfLog(`day ${i}/${days} ${dateStr} syncRepairForDate 完成 @+${Date.now()-t0}ms 耗时${Date.now()-tDay}ms`);
      const tRep = Date.now();
      await syncRepairReportForDate(dateStr).catch((e)=>{ _bfLog(`day ${i}/${days} ${dateStr} repairReport 跳过: ${e?.message?.substring(0,80)}`); });
      _bfLog(`day ${i}/${days} ${dateStr} syncRepairReportForDate 完成 @+${Date.now()-t0}ms 耗时${Date.now()-tRep}ms`);
      await sleep(500);
    } catch(e) { _bfLog(`day ${i}/${days} ${dateStr} 异常跳过: ${e?.message?.substring(0,80)}`); console.log(`[Backfill] ${dateStr} 跳过: ${e.message?.substring(0,60)}`); }
    _bfLog(`day ${i}/${days} ${dateStr} 本日完成 @+${Date.now()-t0}ms 耗时${Date.now()-tDay}ms`);
  }
  _bfLog(`=== Backfill 全部完成 总耗时${Date.now()-t0}ms ===`);
  console.log('[Backfill] 完成');
}

// 仅回补产量历史(逐天 fetchMoveOut+insertProduction), 不含不良/路线等全局数据(已在当日syncData同步)
// 供 /api/uph-backfill 长周期产量回补用 — 解决 ai_production 只有运行天数深度的问题(月/季/半年/年产出更完整)
async function syncProductionForDate(date) {
  if (!mesCookies) return 0;
  const start = `${date} 00:00:00`, end = `${date} 23:59:59`;
  let total=0, skip=0;
  try {
    while(true) {
      const r = await fetchMoveOut(start, end, skip, 500);
      const items = r.items || [];
      if (!items.length) break;
      await db.insertProduction(items);
      total += items.length; skip += items.length;
      if (items.length < 500) break;
      await sleep(300);
    }
  } catch(e) { console.log(`[Backfill-Prod] ${date} 跳过: ${e.message?.substring(0,60)}`); }
  return total;
}

// ===== WIP SN Detail =====
async function getWipSnDetail(dateFrom, dateTo, opCode, lineName) {
  const mongodb = db.getDb();
  const prodCol = mongodb.collection('ai_production');
  const routeCol = mongodb.collection('ai_process_routes');

  const match = { move_out_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) match.line_name = lineName;

  // 每个SN的最后工序
  const snLastOp = await prodCol.aggregate([
    { $match: db.prefixAi(match) },
    { $sort: { ai_move_out_time: 1 } },
    { $group: { _id: '$ai_barcode', last_op: { $last: '$ai_work_operation_code' }, last_sort: { $last: '$ai_sort_no' }, line_name: { $last: '$ai_line_name' }, line_id: { $last: '$ai_line_id' }, product_model: { $last: '$ai_product_model' }, task_order_no: { $last: '$ai_task_order_no' }, mo_lot_no: { $last: '$ai_mo_lot_no' }, work_operation_id: { $last: '$ai_work_operation_id' }, next_work_operation_code: { $last: '$ai_next_work_operation_code' }, last_time: { $last: '$ai_move_out_time' } } }
  ]).toArray();

  // 工艺路线
  const routes = db.stripAi(await routeCol.find(db.prefixAi(lineName ? {line_name:lineName} : {})).toArray());
  const routeMap = {};
  for (const r of routes) routeMap[r.line_name+'|'+r.product_model] = r.operations;

  // 筛选停在该工序的SN
  const now = new Date();
  const sns = [];
  for (const sn of snLastOp) {
    if (sn.last_op !== opCode) continue;
    // 确认不是最后一道工序（已完工的不算WIP）
    const ops = routeMap[sn.line_name+'|'+sn.product_model] || [];
    const lastRouteOp = ops.length>0 ? ops[ops.length-1].name : null;
    if (lastRouteOp && sn.last_op === lastRouteOp) continue;
    // 计算滞留时间
    const moveTime = new Date(sn.last_time);
    const waitMin = Math.round((now - moveTime) / 60000);
    const wH = Math.floor(waitMin/60), wM = waitMin%60;
    sns.push({
      barcode: sn._id,
      product_model: sn.product_model,
      task_order_no: sn.task_order_no || '',
      mo_lot_no: sn.mo_lot_no || '',
      line_code: sn.line_name || '',
      line_name: lineNameMap[sn.line_name] || sn.line_name,
      line_id: sn.line_id || '',
      work_operation_code: sn.last_op || '',
      work_operation_id: sn.work_operation_id || '',
      next_work_operation_code: sn.next_work_operation_code || '',
      sort_no: sn.last_sort || 999,
      last_time: sn.last_time,
      wait_minutes: waitMin,
      wait_display: wH > 0 ? wH+'h'+wM+'m' : wM+'m'
    });
  }

  // 按滞留时间降序排
  sns.sort((a,b) => b.wait_minutes - a.wait_minutes);
  // 批次号:ai_production 的 ai_mo_lot_no 通常为空,通过 task_order_no 关联 ai_task_orders 工单表取 mo_lot_no
  const taskNos = [...new Set(sns.map(s=>s.task_order_no).filter(Boolean))];
  const moLotMap = {};
  if (taskNos.length) {
    const taskCol = mongodb.collection('ai_task_orders');
    try {
      const taskRows = db.stripAi(await taskCol.find(db.prefixAi({task_no:{$in:taskNos}}), {projection:{_id:0,ai_task_no:1,ai_mo_lot_no:1}}).toArray());
      taskRows.forEach(r=>{ if(r.mo_lot_no) moLotMap[r.task_no]=r.mo_lot_no; });
    } catch(e) { console.error('[WipDetail] task_orders 关联批次号失败:', e.message); }
  }
  sns.forEach(s=>{ s.mo_lot_no = s.mo_lot_no || moLotMap[s.task_order_no] || ''; });
  const orderMap = {};
  for (const sn of sns) {
    const key = sn.task_order_no || '未关联工单';
    if (!orderMap[key]) orderMap[key] = { task_order_no:key, count:0, max_wait_minutes:0 };
    orderMap[key].count++;
    orderMap[key].max_wait_minutes = Math.max(orderMap[key].max_wait_minutes, sn.wait_minutes || 0);
  }
  const orderSummary = Object.values(orderMap).sort((a,b)=>b.count-a.count||b.max_wait_minutes-a.max_wait_minutes).slice(0,5);
  const productMap = {};
  for (const sn of sns) {
    const key = sn.product_model || '未知型号';
    if (!productMap[key]) productMap[key] = { product_model:key, count:0, max_wait_minutes:0 };
    productMap[key].count++;
    productMap[key].max_wait_minutes = Math.max(productMap[key].max_wait_minutes, sn.wait_minutes || 0);
  }
  const productSummary = Object.values(productMap).sort((a,b)=>b.count-a.count||b.max_wait_minutes-a.max_wait_minutes).slice(0,5);

  return {
    operation: opCode,
    total: sns.length,
    avg_wait_min: sns.length>0 ? Math.round(sns.reduce((s,n)=>s+n.wait_minutes,0)/sns.length) : 0,
    max_wait_min: sns.length>0 ? sns[0].wait_minutes : 0,
    longest_item: sns[0] || null,
    order_summary: orderSummary,
    product_summary: productSummary,
    items: sns // 全量返回(路由层负责分页/截顶,避免分页只能取到前50)
  };
}

// ===== Compute WIP =====
async function computeWIP(dateFrom, dateTo, lineName, productModel) {
  const mongodb = db.getDb();
  const prodCol = mongodb.collection('ai_production');
  const routeCol = mongodb.collection('ai_process_routes');

  const match = { move_out_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) match.line_name = lineName;
  if (productModel) match.product_model = productModel;  // 机型过滤:只统计该机型 SN 的 WIP

  // 每个SN最后过的工序
  const snLastOp = await prodCol.aggregate([
    { $match: db.prefixAi(match) },
    { $sort: { ai_move_out_time: 1 } },
    { $group: { _id: '$ai_barcode', last_op: { $last: '$ai_work_operation_code' }, last_sort: { $last: '$ai_sort_no' }, line_name: { $last: '$ai_line_name' }, product_model: { $last: '$ai_product_model' }, last_time: { $last: '$ai_move_out_time' } } }
  ]).toArray();

  // 工艺路线
  const routes = db.stripAi(await routeCol.find(db.prefixAi(lineName ? {line_name:lineName} : {})).toArray());
  const routeMap = {};
  for (const r of routes) routeMap[r.line_name+'|'+r.product_model] = r.operations;

  // 判断WIP vs 完工
  const wipByOp = {};
  let completedCount = 0;
  const completedSns = [];
  const now = new Date();
  let wipWaitTotal = 0, wipWaitCount = 0;
  for (const sn of snLastOp) {
    const ops = routeMap[sn.line_name+'|'+sn.product_model] || [];
    const lastOp = ops.length>0 ? ops[ops.length-1].name : null;
    if (lastOp && sn.last_op === lastOp) {
      completedCount++;
      completedSns.push(sn._id);
    } else {
      const opName = sn.last_op || '未知';
      if (!wipByOp[opName]) wipByOp[opName] = { count: 0, sort_no: sn.last_sort || 999 };
      wipByOp[opName].count++;
      if (sn.last_time) {
        const waitH = (now - new Date(sn.last_time)) / 3600000;
        if (waitH > 0 && waitH < 720) { wipWaitTotal += waitH; wipWaitCount++; }
      }
    }
  }
  const avgWipWaitHours = wipWaitCount > 0 ? +(wipWaitTotal / wipWaitCount).toFixed(1) : null;

  // 制造周期：已完工SN的首工序到末工序时间差均值
  let mfgCycleHours = null;
  if (completedSns.length > 0) {
    const sample = completedSns.slice(0, 200);
    const snCycles = await prodCol.aggregate([
      { $match: db.prefixAi({ barcode: { $in: sample }, move_out_date: { $gte: dateFrom, $lte: dateTo } }) },
      { $group: { _id: '$ai_barcode', first_time: { $min: '$ai_move_out_time' }, last_time: { $max: '$ai_move_out_time' } } }
    ]).toArray();
    const validCycles = snCycles.filter(s => s.first_time && s.last_time && new Date(s.last_time) > new Date(s.first_time));
    if (validCycles.length > 0) {
      const totalH = validCycles.reduce((s, c) => s + (new Date(c.last_time) - new Date(c.first_time)) / 3600000, 0);
      mfgCycleHours = +(totalH / validCycles.length).toFixed(1);
    }
  }

  // 按 mes 路线归一化平均位置排序(跨产品稳定,解决 last_sort 漂移),赋连续 sort_no=1..N;
  // _norm_pos 保留供 factory-3d。单线时 1..N 为该线序号;全部产线时 by_operation 仅用于 KPI(用 count),sort_no 不影响
  const mesRoutesWip = routes.filter(r => r.source === 'mes');
  const byOperation = Object.entries(wipByOp)
    .map(([op, data]) => ({ operation: op, _norm_pos: opNormPos(mesRoutesWip, op), _last: data.sort_no, count: data.count }))
    .sort((a,b) => (a._norm_pos ?? 1.1) - (b._norm_pos ?? 1.1) || a._last - b._last)
    .map((o,i) => ({ operation: o.operation, sort_no: i+1, _norm_pos: o._norm_pos, count: o.count }));

  return {
    total_sns: snLastOp.length,
    wip_count: snLastOp.length - completedCount,
    completed_count: completedCount,
    by_operation: byOperation,
    has_routes: routes.length > 0,
    mfg_cycle_hours: mfgCycleHours,
    avg_wip_wait_hours: avgWipWaitHours
  };
}

// ===== 批次维度 WIP(计划工程师:每批次在制 SN 数 + 卡在哪工序 + 最久滞留)=====
async function computeWipByBatch(dateFrom, dateTo, lineName) {
  const mongodb = db.getDb();
  const prodCol = mongodb.collection('ai_production');
  const routeCol = mongodb.collection('ai_process_routes');
  const taskCol = mongodb.collection('ai_task_orders');

  // 工序中文名映射(复用引用缓存 db.getWorkOperations)
  const opMap = {};
  try { (await db.getWorkOperations()).forEach(o => { opMap[o.code] = o.name; }); } catch(e) {}

  const match = { move_out_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) match.line_name = lineName;

  // 每个 SN 最后工序 + 带 mo_lot_no(从 ai_production 取;为空则后续按 task_order_no 关联工单表补)
  const snLastOp = await prodCol.aggregate([
    { $match: db.prefixAi(match) },
    { $sort: { ai_move_out_time: 1 } },
    { $group: {
      _id: '$ai_barcode',
      last_op: { $last: '$ai_work_operation_code' },
      last_sort: { $last: '$ai_sort_no' },
      line_name: { $last: '$ai_line_name' },
      product_model: { $last: '$ai_product_model' },
      task_order_no: { $last: '$ai_task_order_no' },
      mo_lot_no: { $last: '$ai_mo_lot_no' },
      last_time: { $last: '$ai_move_out_time' }
    }}
  ]).toArray();

  // 工艺路线(判断 WIP vs 完工)
  const routes = db.stripAi(await routeCol.find(db.prefixAi(lineName ? {line_name:lineName} : {})).toArray());
  const routeMap = {};
  for (const r of routes) routeMap[r.line_name+'|'+r.product_model] = r.operations;

  // mo_lot_no 缺失的,通过 task_order_no 关联 ai_task_orders 补
  const taskNos = [...new Set(snLastOp.filter(s=>!s.mo_lot_no && s.task_order_no).map(s=>s.task_order_no))];
  const moLotMap = {};
  if (taskNos.length) {
    const taskRows = db.stripAi(await taskCol.find(db.prefixAi({task_no:{$in:taskNos}}), {projection:{_id:0,ai_task_no:1,ai_mo_lot_no:1}}).toArray());
    taskRows.forEach(r=>{ if(r.mo_lot_no) moLotMap[r.task_no]=r.mo_lot_no; });
  }

  // 按批次聚合 WIP(未完工 SN:最后工序≠路线末工序)
  const now = new Date();
  const batchMap = {};  // mo_lot_no -> {mo_lot_no, wip:[], by_op:{}, max_wait_min}
  for (const sn of snLastOp) {
    const ops = routeMap[sn.line_name+'|'+sn.product_model] || [];
    const lastRouteOp = ops.length>0 ? ops[ops.length-1].name : null;
    // 完工(SN 已到末工序)不计入 WIP
    if (lastRouteOp && sn.last_op === lastRouteOp) continue;
    const lot = sn.mo_lot_no || moLotMap[sn.task_order_no] || '';
    const key = lot || '(无批次)';
    if (!batchMap[key]) batchMap[key] = { mo_lot_no: lot, task_order_nos: new Set(), by_op: {}, wip_count: 0, max_wait_min: 0, line_names: new Set(), product_models: new Set() };
    const b = batchMap[key];
    b.wip_count++;
    if (sn.task_order_no) b.task_order_nos.add(sn.task_order_no);
    if (sn.line_name) b.line_names.add(sn.line_name);
    if (sn.product_model) b.product_models.add(sn.product_model);
    const opName = sn.last_op || '未知';
    b.by_op[opName] = (b.by_op[opName]||0) + 1;
    if (sn.last_time) {
      const waitMin = Math.round((now - new Date(sn.last_time)) / 60000);
      if (waitMin > b.max_wait_min) b.max_wait_min = waitMin;
    }
  }

  // 转数组 + 派生:主要卡点工序(max by_op)、涉及工单数/产线/型号
  const batches = Object.values(batchMap).map(b => {
    const ops = Object.entries(b.by_op).sort((a,c)=>c[1]-a[1]);
    return {
      mo_lot_no: b.mo_lot_no,
      wip_count: b.wip_count,
      task_order_count: b.task_order_nos.size,
      task_order_nos: [...b.task_order_nos],
      line_names: [...b.line_names],
      product_models: [...b.product_models],
      by_operation: ops.map(([op,c])=>({operation:op,operation_name:opMap[op]||op,count:c})),
      primary_operation: ops.length ? (opMap[ops[0][0]]||ops[0][0]) : '--',   // 卡住最多 SN 的工序(中文名)
      max_wait_min: b.max_wait_min
    };
  }).sort((a,b)=>b.wip_count-a.wip_count || b.max_wait_min-a.max_wait_min);  // 在制多/滞留久在前

  return {
    total_batches: batches.length,
    total_wip: batches.reduce((s,b)=>s+b.wip_count,0),
    batches: batches.slice(0, 50)  // 截顶 50 批(计划工程师关注 Top 在制)
  };
}

async function computeQuality(dateFrom, dateTo, lineName='') {
  const mdb = db.getDb();
  const lineFilter = lineName ? { line_name: lineName } : {};

  // 产量基数
  const prodTotal = await mdb.collection('ai_production').countDocuments(db.prefixAi({ move_out_date: { $gte: dateFrom, $lte: dateTo }, ...lineFilter }));

  // 返工率: ai_repair_report 按 test_date，按 SN 求 max(repair_total)，>1 即返工
  // repair_total 历史可能存成字符串，用 $convert 统一转 double 防类型坑
  const repairMatch = { test_date: { $gte: dateFrom, $lte: dateTo }, ...lineFilter };
  const repairBySn = await mdb.collection('ai_repair_report').aggregate([
    { $match: db.prefixAi(repairMatch) },
    { $addFields: { _rt_num: { $convert: { input: '$ai_repair_total', to: 'double', onError: 0, onNull: 0 } } } },
    { $group: { _id: '$ai_sn_code', max_repair: { $max: '$_rt_num' }, line: { $first: '$ai_line_name' }, category: { $first: '$ai_category_name' } } }
  ]).toArray();
  const totalSn = repairBySn.length;
  const reworkSn = repairBySn.filter(s => (Number(s.max_repair) || 0) > 1).length;
  const reworkRate = totalSn > 0 ? +((reworkSn / totalSn) * 100).toFixed(1) : null;

  // 返工按不良分类
  const reworkByCategory = await mdb.collection('ai_repair_report').aggregate([
    { $match: db.prefixAi(repairMatch) },
    { $addFields: { _rt_num: { $convert: { input: '$ai_repair_total', to: 'double', onError: 0, onNull: 0 } } } },
    { $group: { _id: { $ifNull: ['$ai_category_name', '未分类'] }, count: { $sum: 1 }, rework_sn: { $sum: { $cond: [{ $gt: ['$_rt_num', 1] }, 1, 0] } } } },
    { $project: { _id: 0, category: '$_id', count: 1, rework_sn: 1 } },
    { $sort: { count: -1 } }, { $limit: 15 }
  ]).toArray();

  // 直通率(复用现有口径): (产量 - 不良SN数) / 产量
  const badSnCount = await mdb.collection('ai_bad_repair').distinct('ai_barcode', db.prefixAi({ test_date: { $gte: dateFrom, $lte: dateTo }, ...lineFilter }));
  const fpy = prodTotal > 0 ? +(((prodTotal - badSnCount.length) / prodTotal) * 100).toFixed(1) : null;

  return {
    fpy,
    rework_rate: reworkRate, rework_sn_count: reworkSn, total_sn_count: totalSn,
    prod_total: prodTotal,
    rework_by_category: reworkByCategory
  };
}

// ===== 12-KPI Phase1: 交付域计算 (计划达成率/在制周期) =====
async function computeDelivery(dateFrom, dateTo, lineName='') {
  const mdb = db.getDb();

  // 工单(MoOrder 快照) — 全量
  const moOrders = db.stripAi(await mdb.collection('ai_mo_orders').find({}).toArray());

  // line_id → line_name(code) 映射: ai_task_order_wip 只有 line_id(hash),需转成产线 code 再转中文名
  // 从 ai_production 建(line_id + line_name 都有),缓存引用
  const prodCol = mdb.collection('ai_production');
  const lineIdRows = db.stripAi(await prodCol.find({}, {projection:{_id:0,ai_line_id:1,ai_line_name:1}}).toArray());
  const lineIdToName = {};
  lineIdRows.forEach(r => { if(r.line_id && r.line_name) lineIdToName[r.line_id] = r.line_name; });

  // 计划达成率: 全部在制工单 Σ(reported_completed_qty) / Σ(qty)
  const planTotalQty = moOrders.reduce((s, o) => s + (o.qty || 0), 0);
  const planCompletedQty = moOrders.reduce((s, o) => s + (o.reported_completed_qty || 0), 0);
  const planRate = planTotalQty > 0 ? +((planCompletedQty / planTotalQty) * 100).toFixed(1) : null;

  // 在制周期: ai_task_order_wip 中 wip_qty>0 的任务单，avg(now - plan_start_time)，>720h剔除(陈旧滞留)
  const wipRows = db.stripAi(await mdb.collection('ai_task_order_wip').find(db.prefixAi({ wip_qty: { $gt: 0 }, plan_start_time: { $ne: '' } })).toArray());
  const now = Date.now();
  let wipSum = 0, wipCnt = 0;
  const byLine = {};
  for (const w of wipRows) {
    const start = new Date(w.plan_start_time).getTime();
    if (isNaN(start)) continue;
    const h = (now - start) / 3600000;
    if (h <= 0 || h > 720) continue;
    wipSum += h; wipCnt++;
    const lineKey = w.line_id || '未知';
    if (!byLine[lineKey]) byLine[lineKey] = { sum: 0, cnt: 0, wip_qty: 0 };
    byLine[lineKey].sum += h; byLine[lineKey].cnt++; byLine[lineKey].wip_qty += (w.wip_qty || 0);
  }
  const wipCycleHours = wipCnt > 0 ? +(wipSum / wipCnt).toFixed(1) : null;
  const byLineArr = Object.entries(byLine).map(([line_id, v]) => {
    const lineName = lineIdToName[line_id] || '';        // hash → 产线 code(如 ASS_Line3)
    const lineDisplay = lineNameMap[lineName] || lineName || line_id;  // code → 中文名(如 整机3线),无则 fallback
    return {
      line: lineDisplay, line_id, line_name: lineName,
      wip_cycle_hours: v.cnt > 0 ? +(v.sum / v.cnt).toFixed(1) : null,
      wip_count: v.cnt, wip_qty: v.wip_qty
    };
  }).sort((a, b) => (b.wip_qty || 0) - (a.wip_qty || 0));

  return {
    plan_rate: planRate, plan_total_qty: planTotalQty, plan_completed_qty: planCompletedQty,
    wip_cycle_hours: wipCycleHours, wip_count: wipCnt,
    by_line: byLineArr
  };
}

// ===== Compute =====
async function computeDashboard(dateFrom, dateTo, lineName='') {
  const [prodByLine, badItems, badStats, tasks, products, hourly, offlineOutput] = await Promise.all([
    db.queryProductionByLine(dateFrom, dateTo),
    db.queryBadItems(dateFrom, dateTo, lineName),
    db.queryBadStats(dateFrom, dateTo, lineName),
    db.getTaskOrders(),
    db.getProducts(),
    db.queryProductionByHour(dateFrom, dateTo, lineName),
    db.queryOfflineOutput(dateFrom, dateTo, lineName)
  ]);
  const scopedProdByLine = lineName ? prodByLine.filter(l => l.line_name === lineName) : prodByLine;

  const totalOutput = scopedProdByLine.reduce((s,l)=>s+l.total,0);

  // 按唯一SN去重计算不良(避免同一SN多条维修记录重复计数)
  const uniqueBadBarcodes = new Set(badItems.map(b=>b.barcode).filter(Boolean));
  const uniqueBadCount = uniqueBadBarcodes.size;
  const mistestCount = badItems.filter(b => isMistest(b)).length;
  const uniqueRealBadBarcodes = new Set(badItems.filter(b=>!isMistest(b)).map(b=>b.barcode).filter(Boolean));
  const realNG = uniqueRealBadBarcodes.size;
  const totalProd = await db.queryProductionTotal(dateFrom, dateTo, lineName);

  const fpy = totalProd>0 ? +((totalProd-uniqueBadCount)/totalProd*100).toFixed(2) : null;
  const mistestRate = badItems.length>0 ? +(mistestCount/badItems.length*100).toFixed(2) : null;
  const ppm = totalProd>0 ? +(realNG/totalProd*1000000).toFixed(0) : null;

  // OEE
  const oeeData = await db.computeOEE(dateFrom, dateTo, lineName);
  let oee = {availability:null,performance:null,quality:null,oee:null};
  // 多线聚合按产量加权(小产量/0产量线不应与主力线等权); 全线0产量时回退简单平均
  if(oeeData.length>0){ const _wavg=(k)=>{const v=oeeData.filter(o=>o[k]!=null);if(!v.length)return null;const w=v.reduce((s,o)=>s+(o.total_output||0),0);return +(w>0?v.reduce((s,o)=>s+o[k]*(o.total_output||0),0)/w:v.reduce((s,o)=>s+o[k],0)/v.length).toFixed(1);}; oee.availability=_wavg('availability'); oee.performance=_wavg('performance'); oee.quality=_wavg('quality'); oee.oee=_wavg('oee'); }

  // UPPH + 目标UPH: 班次配置取真实时长, 出勤取真实人数; 目标按线实际做产品产量加权匹配product_config.uph
  // 缺数据返null并披露(不用全产品平均/默认人数估算顶替)
  let totalPeople = 0, totalHours = 0;
  const shiftConfigs = await db.getShiftConfigs();
  const attendanceRows = await db.getAttendance({date: dateFrom});

  // 各线当天实际做型号(去重SN产量), 用于匹配目标UPH(product_config); cnt=去重SN数, 与totalOutput同口径
  const lineModelRows = await db.getDb().collection('ai_production').aggregate([
    { $match: db.prefixAi({ move_out_date: { $gte: dateFrom, $lte: dateTo }, line_name: { $nin: [null, ''] }, product_model: { $nin: [null, ''] }, barcode: { $nin: [null, ''] } }) },
    { $group: { _id: { line: '$ai_line_name', model: '$ai_product_model', sn: '$ai_barcode' } } },
    { $group: { _id: { line: '$_id.line', model: '$_id.model' }, cnt: { $sum: 1 } } }
  ]).toArray();
  const lineModelsMap = {};
  lineModelRows.forEach(r => { (lineModelsMap[r._id.line] = lineModelsMap[r._id.line] || []).push({ model: r._id.model, cnt: r.cnt }); });
  const uphByModel = {}; products.forEach(p => { if (p.uph > 0) uphByModel[p.product_model] = p.uph; });

  // 逐线: 人数/工时/目标UPH(产量加权匹配配置)
  const lineMeta = {};
  let matchedOutput = 0;
  for (const pl of scopedProdByLine) {
    const shift = shiftConfigs.find(s => s.line_name === pl.line_name) || shiftConfigs.find(s => !s.line_name);
    const shiftMin = shift ? (() => {
      const [sh, sm] = (shift.shift_start || '08:00').split(':').map(Number);
      const [eh, em] = (shift.shift_end || '20:00').split(':').map(Number);
      return (eh * 60 + em) - (sh * 60 + sm) - (shift.break_time || 60);
    })() : null; // 无班次配置→null(不用10.5*60兜底)
    const hours = shiftMin != null ? shiftMin / 60 : null;
    const linePeople = attendanceRows.filter(a => a.line_name === pl.line_name).reduce((s, a) => s + (a.headcount || a.on_duty_count || 0), 0);
    // 该线目标UPH = 实际做型号的uph产量加权(仅匹配product_config的型号); 无匹配→null
    const models = lineModelsMap[pl.line_name] || [];
    let wSum = 0, wCnt = 0;
    models.forEach(m => { const u = uphByModel[m.model]; if (u > 0) { wSum += u * m.cnt; wCnt += m.cnt; } });
    const targetUph = wCnt > 0 ? +(wSum / wCnt).toFixed(1) : null;
    matchedOutput += wCnt;
    lineMeta[pl.line_name] = { people: linePeople, hours, targetUph, output: pl.total };
    if (linePeople > 0 && hours > 0) { totalPeople += linePeople; totalHours += hours; }
  }

  // UPPH实际值: 有出勤才算; 有产量无出勤→null(不估算)
  let upph = null, upphDataQuality = 'missing_data';
  if (totalPeople > 0) {
    upph = totalOutput > 0 ? +(totalOutput / (totalPeople * (totalHours / Math.max(scopedProdByLine.filter(pl => lineMeta[pl.line_name]?.people > 0).length, 1)))).toFixed(2) : null;
    upphDataQuality = 'from_attendance';
  } else if (totalOutput > 0) {
    upphDataQuality = 'missing_attendance'; // 有产量无出勤: 返回null, 不用默认人数估算
  }
  // 目标UPH(台/小时): 产出加权(仅配置线), 全无配置→null
  let targetWSum = 0, targetWOut = 0, configuredLines = 0;
  for (const ln of Object.keys(lineMeta)) {
    const m = lineMeta[ln];
    if (m.targetUph != null) { targetWSum += m.targetUph * m.output; targetWOut += m.output; configuredLines++; }
  }
  const uphTarget = targetWOut > 0 ? +(targetWSum / targetWOut).toFixed(1) : null;
  const targetMatchRate = totalOutput > 0 ? +(matchedOutput / totalOutput * 100).toFixed(0) : 0;
  // 平均班次工时(配置线), 供upph.hours; 无配置→null
  const hoursLines = scopedProdByLine.filter(pl => lineMeta[pl.line_name]?.hours != null);
  const upphHours = hoursLines.length > 0 ? +(hoursLines.reduce((s, pl) => s + lineMeta[pl.line_name].hours, 0) / hoursLines.length).toFixed(1) : null;

  // Line utilization: 用班次配置的实际工时计算(非硬编码10.5h)
  const lineUtil = {};
  for (const pl of scopedProdByLine) {
    const name = lineNameMap[pl.line_name]||pl.line_name;
    if(pl.first_time&&pl.last_time){
      const shift = shiftConfigs.find(s => s.line_name === pl.line_name) || shiftConfigs.find(s => !s.line_name);
      const shiftHours = shift ? (() => {
        const [sh, sm] = (shift.shift_start || '08:00').split(':').map(Number);
        const [eh, em] = (shift.shift_end || '20:00').split(':').map(Number);
        return ((eh * 60 + em) - (sh * 60 + sm) - (shift.break_time || 60)) / 60;
      })() : null; // 无班次配置→null, 利用率不可算(不用10.5兜底)
      const h=(new Date(pl.last_time)-new Date(pl.first_time))/3600000;
      lineUtil[name]={utilization: shiftHours!=null ? +Math.min(h/shiftHours*100,100).toFixed(1) : null, run_hours:+h.toFixed(2), shift_hours: shiftHours, output:pl.total};
    }
  }

  // Repair by category
  const repairTop = badStats.slice(0,8).map(b=>({name:b.category||'未知',count:b.total}));
  const lineSummary = scopedProdByLine.map(pl=>({code:pl.line_name,name:lineNameMap[pl.line_name]||pl.line_name,output:pl.total,target_uph:lineMeta[pl.line_name]?.targetUph ?? null,shift_hours:lineMeta[pl.line_name]?.hours ?? null})).sort((a,b)=>b.output-a.output);
  const taskList = tasks.slice(0,15).map(t=>({taskNo:t.task_no,moLotNo:t.mo_lot_no,productModel:t.product_model,qty:t.qty,completedQty:t.completed_qty,progress:t.qty>0?+((t.completed_qty||0)/t.qty*100).toFixed(1):0,status:t.task_mes_status}));

  // Mistest by operation
  const mistestByOp = {};
  for(const b of badItems){ const op=b.work_operation_name||'未知'; if(!mistestByOp[op])mistestByOp[op]={total:0,mistest:0}; mistestByOp[op].total++; if(isMistest(b))mistestByOp[op].mistest++; }

  return {
    date: dateFrom, update_time: new Date().toISOString(),
    oee, oee_by_line: oeeData.map(o=>({...o,line_display:lineNameMap[o.line_name]||o.line_name})),
    upph: {value:upph,target:uphTarget,total_output:totalOutput,offline_output:offlineOutput,total_people:totalPeople,hours:upphHours,target_match_rate:targetMatchRate,configured_lines:configuredLines,run_time_source:'estimated_shift_config',data_quality:upphDataQuality},
    fpy: {value:fpy,total_tested:totalProd,total_ng:uniqueBadCount},
    mistest_rate: {value:mistestRate,total_repairs:badItems.length,total_ng:uniqueBadCount,mistest_count:mistestCount,by_operation:mistestByOp},
    ppm: {value:+ppm,real_ng:realNG,total_output:totalProd},
    line_utilization: lineUtil, hourly_output: hourly,
    repair_top: repairTop, line_summary: lineSummary, task_orders: taskList,
    mtbf_mttr: (()=>{ const bd=oeeData.filter(o=>o.breakdown_count>0); const tbd=bd.reduce((s,o)=>s+o.breakdown_count,0); return tbd>0?{mtbf:+(bd.reduce((s,o)=>s+(o.mtbf||0)*o.breakdown_count,0)/tbd).toFixed(1),mttr:+(bd.reduce((s,o)=>s+(o.mttr||0)*o.breakdown_count,0)/tbd).toFixed(1)}:{mtbf:null,mttr:null}; })(),
    data_quality: {
      production: totalProd>0 ? 'real' : 'empty',
      fpy: totalProd>0 ? 'real' : 'empty',
      upph: upphDataQuality,
      oee: oeeData.length>0 ? 'computed' : 'empty',
      oee_details: oeeData.map(o => ({ line_name:o.line_name, data_quality:o.data_quality }))
    }
  };
}

// ===== HTTP Server =====
const MAX_BODY_BYTES = 1024*1024; // 1MB, 防 body 内存 DoS(超限丢弃返回空对象, 不崩溃不放大)
function readBody(req) { return new Promise(r=>{ let b='',n=0,over=false; req.on('data',c=>{ if(over)return; n+=c.length; if(n>MAX_BODY_BYTES){ over=true; r({}); return; } b+=c; }); req.on('end',()=>{ if(over)return; try{r(JSON.parse(b))}catch(e){r({})} }); req.on('error',()=>r({})); }); }

const MIME = {'.html':'text/html;charset=utf-8','.js':'application/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon','.woff2':'font/woff2'};

// 轻量运行统计(供 /api/admin/log-stats, 替代原写死的 errorsToday:0/requestsLastHour:0 假数据):
//   errorsToday    — 今日(本地日)错误数, 跨日清零; 在请求 catch + process 级兜底处 +1
//   requestsLastHour — 近 60 分钟请求数, 60 个分钟桶滑动窗口(内存常驻 60 个数字, 有界)
//   errLog         — 最近 200 条错误事件环形缓冲(供 /api/admin/logs 展示真实近期错误, 非假空响应)
const _stats = { errDate: '', errCount: 0, reqBuckets: new Array(60).fill(0), reqBucketMin: -1, errLog: [] };
function _statsErrInc(ctx) {
  const d = localDate();
  if (_stats.errDate !== d) { _stats.errDate = d; _stats.errCount = 0; }
  _stats.errCount++;
  _stats.errLog.push({ time: new Date().toISOString(), level: 'error', path: (ctx && ctx.path) || null, message: (ctx && ctx.message) || 'unknown' });
  if (_stats.errLog.length > 200) _stats.errLog.shift(); // 环形, 有界
}
function _statsRollReq() {
  const now = new Date();
  const min = now.getHours()*60 + now.getMinutes(); // 本地分钟(0-1439)
  if (_stats.reqBucketMin < 0) { _stats.reqBucketMin = min; }
  // 推进跨过的分钟桶(清零), 最多推进 120 分钟防异常时钟跳变死循环
  let guard = 0;
  while (_stats.reqBucketMin !== min && guard < 120) {
    _stats.reqBucketMin = (_stats.reqBucketMin + 1) % 1440;
    _stats.reqBuckets[_stats.reqBucketMin % 60] = 0;
    guard++;
  }
  _stats.reqBuckets[min % 60]++;
}
function _statsReqLastHour() { return _stats.reqBuckets.reduce((a,b)=>a+b, 0); }


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;
  const params = url.searchParams;

  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(method==='OPTIONS'){res.writeHead(204);res.end();return;}

  const json = (data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const today = ()=> localDate();

  // --- Auth ---
  const desktopAllowed = isWipDesktopAllowed(req, path);
  if(!desktopAllowed && !isWhitelisted(path) && path.startsWith('/api/') && !isAuth(req)){json({error:'unauthorized'},401);return;}
  if(!desktopAllowed && !isWhitelisted(path) && !path.startsWith('/api/') && !isAuth(req)){res.writeHead(302,{'Location':'/login.html'});res.end();return;}
  _statsRollReq(); // 统计近1h请求数(白名单/鉴权请求也计入, 反映真实流量)

  try {
    // ===== AUTH ROUTES =====
    if(path==='/api/login'&&method==='POST'){ const b=await readBody(req); if(b.username===USERNAME&&b.password===PASSWORD){const t=crypto.randomBytes(32).toString('hex');sessions.set(t,{user:b.username,role:'user',created:Date.now()});res.setHeader('Set-Cookie',`session=${t};Path=/;HttpOnly;SameSite=Lax;Max-Age=${SESSION_TTL/1000}`);json({success:true,user:b.username})}else{json({success:false,error:'账号或密码错误'})} return;}
    if(path==='/api/admin-login'&&method==='POST'){ const b=await readBody(req); if(b.key===ADMIN_KEY){const t=crypto.randomBytes(32).toString('hex');sessions.set(t,{user:'admin',role:'admin',created:Date.now()});res.setHeader('Set-Cookie',`session=${t};Path=/;HttpOnly;SameSite=Lax;Max-Age=${SESSION_TTL/1000}`);json({success:true,user:'admin'})}else{json({success:false,error:'Invalid key'})} return;}
    if(path==='/api/logout'){const c=parseCookies(req.headers.cookie);if(c.session)sessions.delete(c.session);res.setHeader('Set-Cookie','session=;Path=/;HttpOnly;Max-Age=0');json({success:true});return;}
    if(path==='/api/me'){const s=isAuth(req);json(s?{user:s.user,role:s.role}:{user:null});return;}
    if(path==='/api/health'||path==='/api/health/ping'){json({status:'ok',time:new Date().toISOString(),hasCookie:!!mesCookies,desktopMode:WIP_DESKTOP_MODE});return;}
    // 诊断: 查看缓存命中情况(开发用)
    if(path==='/api/_cacheprobe' && isAuth(req)?.role==='admin'){
      const k=params.get('key')||'';
      if(k){ const h=dashCache.getWithMeta(k); const th=trendCache.getWithMeta(k); json({key:k, dashHit:h.hit, dashAge:h.age, trendHit:th.hit}); return; }
      json({dashKeys:[...dashCache.store.keys()], trendKeys:[...trendCache.store.keys()], prewarmBusy:_prewarmLock.busy, lastSync:lastSyncTime}); return;
    }
    // 系统状态(普通登录可读,供大屏 health 屏;非 admin 路由,避免普通用户 403)
    if(path==='/api/system-status'){
      const mem=process.memoryUsage(),s=isAuth(req);
      json({success:true,data:{uptime:process.uptime(),memoryUsage:{rss:Math.round(mem.rss/1024/1024),heapUsed:Math.round(mem.heapUsed/1024/1024)},mesCookie:!!mesCookies,lastSync:lastSyncTime,syncCount,wsClients:(wss&&wss.clients&&wss.clients.size)||0,sessions:sessions.size,nodeVersion:process.version,user:s?s.user:null}});
      return;
    }

    // ===== DATA ROUTES =====
    if(path==='/api/dashboard-all'||path==='/api/dashboard'){
      const started=Date.now();
      const df=params.get('dateFrom')||today(), dt=params.get('dateTo')||df;
      const lineId=resolveLineName(params.get('lineId')||params.get('lineName')||'');
      const {val:d, cached} = await computeDashboardCached(df,dt,lineId);
      // 兼容知识城前端格式
      const lineDisplay = lineId ? (lineNameMap[lineId]||lineId) : '';
      // 明细缓存(badItems/hourStats 单独 TTL, 避免每次重查; key 含 line)
      const extrasKey=`extras|${df}|${dt}|${lineId}`;
      let extras=dashCache.getWithMeta(extrasKey);
      let badItems, hourStats;
      if(extras.hit){ badItems=extras.val.badItems; hourStats=extras.val.hourStats; }
      else{
        [badItems, hourStats] = await Promise.all([
          db.queryBadItems(df,dt,badLineMatch(lineId)),
          db.queryProductionByHour(df,dt,lineId)
        ]);
        dashCache.set(extrasKey, {badItems, hourStats}, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
      }
      json({
        ...d,
        cached,
        elapsed_ms:Date.now()-started,
        productionTotal: d.upph.total_output,
        productionOffline: d.upph.offline_output,
        badTotal: d.fpy.total_ng,
        badItems: badItems.map(b=>({...b, workOprationName:b.work_operation_name, badItems:b.bad_items, repairTotal: b.repair_total != null ? b.repair_total : null, line_name:lineNameMap[b.line_name]||b.line_name, lineName:lineNameMap[b.line_name]||b.line_name, testTime:b.test_time, repairStateCode:b.repair_state_code, containerBarcode:b.barcode})),
        badByProcess: (()=>{const m={};badItems.forEach(b=>{const p=b.work_operation_name||'未知';m[p]=(m[p]||0)+1;});return Object.entries(m).map(([process,count])=>({process,count})).sort((a,b)=>b.count-a.count);})(),
        badByDefect: (()=>{const m={};badItems.forEach(b=>{const d2=b.bad_items||'未知';m[d2]=(m[d2]||0)+1;});return Object.entries(m).map(([defect,count])=>({defect,count})).sort((a,b)=>b.count-a.count);})(),
        hourStats: hourStats.map(h=>({hour:h.hour, cnt:h.total})),
        lineStats: d.line_summary.map(l=>({line_name:l.name, cnt:l.output})),
        prodByDay: await (async()=>{
          if(df===dt) return [{date:df, total:d.upph.total_output}];
          const prodCol = db.getDb().collection('ai_production');
          const daily = await prodCol.aggregate([
            {$match:db.prefixAi({move_out_date:{$gte:df,$lte:dt}})},
            {$group:{_id:'$ai_move_out_date',total:{$sum:1}}},
            {$sort:{_id:1}}
          ]).toArray();
          return daily.map(x=>({date:x._id, total:x.total}));
        })(),
        oeeByLine: d.oee_by_line||[],
      }); return;
    }
    if(path==='/api/dashboard-kpi'){
      const started=Date.now();
      const df=params.get('dateFrom')||today(), dt=params.get('dateTo')||df;
      const kpiKey=`kpi|${df}|${dt}`;
      const kpiHit=dashCache.getWithMeta(kpiKey);
      if(kpiHit.hit){ json({...kpiHit.val, cached:true, elapsed_ms:Date.now()-started}); return; }
      const {val:d} = await computeDashboardCached(df,dt);
      // 3 个独立查询并行(原为 serial await)
      const [openExc, pendingAct, downtimeCount] = await Promise.all([
        db.getExceptions({status:'open'}).then(r=>r.length),
        db.getActionItems({status:{$ne:'done'}}).then(r=>r.length),
        db.getDowntimeRecords(df,dt).then(r=>r.length),
      ]);
      const result={success:true,oee:(d.oee.oee!=null?d.oee.oee:null),fpy:d.fpy.value,ppm:d.ppm.value,upph:d.upph.value,mistest:d.mistest_rate.value,output:d.upph.total_output,output_offline:d.upph.offline_output,openExceptions:openExc,pendingActions:pendingAct,downtimeCount,data_quality:d.data_quality};
      dashCache.set(kpiKey, result, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
      json({...result, cached:false, elapsed_ms:Date.now()-started});return;
    }
    if(path==='/api/dashboard-trend'){
      const started=Date.now();
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||today();
      const prevDf=params.get('prevFrom')||'',prevDt=params.get('prevTo')||'';
      const totalDays=Math.round((new Date(dt)-new Date(df))/86400000)+1;
      // Auto granularity: <=31 days=daily, <=120=weekly, else monthly
      const gran = totalDays<=31?'day':totalDays<=120?'week':'month';

      // 单聚合拉取整段每日 production + bad 计数(原为 N+1 日循环: 每天 2 次往返)
      async function fetchPeriodData(from, to) {
        const mongodb = db.getDb();
        const prodCol = mongodb.collection('ai_production');
        const badCol = mongodb.collection('ai_bad_repair');
        // 并行: 每日产量(去重SN) + 每日不良全量明细(用于 JS 精确去重 + isMistest 精修)
        const [prodByDay, badItemsRaw] = await Promise.all([
          prodCol.aggregate([
            {$match:db.prefixAi({move_out_date:{$gte:from,$lte:to}})},
            {$group:{_id:{date:'$ai_move_out_date',sn:'$ai_barcode'}}},
            {$group:{_id:'$_id.date',total:{$sum:1}}},
            {$project:{_id:0,date:'$_id',total:1}}
          ]).toArray(),
          // 一次拉取全段不良明细(投影最小字段), 在 JS 侧按日去重 + 扣误测
          badCol.find(db.prefixAi({test_date:{$gte:from,$lte:to}}),
            {projection:db.prefixAi({_id:0, test_date:1, barcode:1, content_name:1, causes_name:1, remark:1})}
          ).toArray(),
        ]);
        const badItems = db.stripAi(badItemsRaw);
        const prodMap = {}; prodByDay.forEach(d=>{prodMap[d.date]=d.total;});
        const badMap = {};       // 每日不良 SN 去重总数
        const realBadMap = {};   // 每日真不良(扣误测) SN 去重总数
        const seenBad = {}, seenReal = {};
        badItems.forEach(b=>{
          const date = b.test_date; if(!date) return;
          const sn = b.barcode || ('_'+(b.content_name||'')+'_'+(b.causes_name||'')+'_'+(b.remark||''));
          const kb = date+'|'+sn;
          if(!seenBad[kb]){ seenBad[kb]=1; badMap[date]=(badMap[date]||0)+1; }
          if(!isMistest(b) && !seenReal[kb]){ seenReal[kb]=1; realBadMap[date]=(realBadMap[date]||0)+1; }
        });
        const rawDays=[];
        const d1=new Date(from),d2=new Date(to);
        for(let dd=new Date(d1);dd<=d2;dd.setDate(dd.getDate()+1)){
          const ds=dd.toISOString().split('T')[0];
          const prod=prodMap[ds]||0;
          const badCnt=badMap[ds]||0;
          const realBad=realBadMap[ds]||0;
          rawDays.push({date:ds,output:prod,bad:badCnt,realBad,rate:prod>0?+((prod-badCnt)/prod*100).toFixed(2):null,ppm:prod>0?Math.round(realBad/prod*1000000):null});
        }
        // Aggregate if needed
        if(gran==='day') return rawDays;
        const buckets={};
        rawDays.forEach(d=>{
          let key;
          if(gran==='week'){
            const dt2=new Date(d.date),wd=dt2.getDay()||7;
            const mon=new Date(dt2);mon.setDate(mon.getDate()-wd+1);
            key=mon.toISOString().split('T')[0];
          } else {
            key=d.date.substring(0,7);
          }
          if(!buckets[key]) buckets[key]={date:key,output:0,bad:0,realBad:0};
          buckets[key].output+=d.output; buckets[key].bad+=d.bad; buckets[key].realBad+=d.realBad;
        });
        return Object.values(buckets).map(b=>({
          date:b.date,output:b.output,bad:b.bad,realBad:b.realBad,
          rate:b.output>0?+((b.output-b.bad)/b.output*100).toFixed(2):null,
          ppm:b.output>0?Math.round(b.realBad/b.output*1000000):null
        })).sort((a,b)=>a.date.localeCompare(b.date));
      }

      // 趋势缓存(20s); 过去日期范围长 TTL
      const tKey=`${df}|${dt}|${prevDf}|${prevDt}`;
      let trendHit = trendCache.getWithMeta(tKey);
      let result;
      if (trendHit.hit) {
        result = trendHit.val;
        result = {...result, cached:true, elapsed_ms:Date.now()-started};
      } else {
        const days=await fetchPeriodData(df,dt);
        const prevDays=(prevDf&&prevDt)?await fetchPeriodData(prevDf,prevDt):[];
        const curTotal=days.reduce((s,d)=>s+d.output,0), curBad=days.reduce((s,d)=>s+d.bad,0), curRealBad=days.reduce((s,d)=>s+(d.realBad||0),0);
        const prevTotal=prevDays.reduce((s,d)=>s+d.output,0), prevBad=prevDays.reduce((s,d)=>s+d.bad,0), prevRealBad=prevDays.reduce((s,d)=>s+(d.realBad||0),0);
        const curRate=curTotal>0?+((curTotal-curBad)/curTotal*100).toFixed(2):null;
        const prevRate=prevTotal>0?+((prevTotal-prevBad)/prevTotal*100).toFixed(2):null;
        const curPpm=curTotal>0?Math.round(curRealBad/curTotal*1000000):null;
        const prevPpm=prevTotal>0?Math.round(prevRealBad/prevTotal*1000000):null;
        result = {
          granularity:gran,
          current:{days,total:curTotal,bad:curBad,realBad:curRealBad,rate:curRate,ppm:curPpm,avgDaily:totalDays>0?Math.round(curTotal/totalDays):0},
          previous:{days:prevDays,total:prevTotal,bad:prevBad,realBad:prevRealBad,rate:prevRate,ppm:prevPpm,avgDaily:prevDays.length>0?Math.round(prevTotal/prevDays.length):0},
          change:{output:prevTotal>0?+((curTotal-prevTotal)/prevTotal*100).toFixed(1):null,rate:(prevRate!=null&&curRate!=null)?+(curRate-prevRate).toFixed(2):null,ppm:prevPpm>0?curPpm-prevPpm:null},
          cached:false, elapsed_ms:Date.now()-started
        };
        trendCache.set(tKey, result, isPastDate(dt) ? DASH_TTL_PAST : TREND_TTL);
      }
      json(result);return;
    }
    if(path==='/api/oee'){
      const started=Date.now();
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||'');
      const oeeKey=`oee|${df}|${dt}|${line}`;
      const oeeHit = dashCache.getWithMeta(oeeKey);
      if (oeeHit.hit) { json({...oeeHit.val, cached:true, elapsed_ms:Date.now()-started}); return; }
      const result = await computeOeeResult(df,dt,line);
      json({...result, cached:false, elapsed_ms:Date.now()-started});return;
    }
    if(path==='/api/oee/downtime'){
      if(method==='GET'){const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||'');const _rows=await db.getDowntimeRecords(df,dt,line);const _mapped=_rows.map(function(r){return Object.assign({},r,{line_display:(typeof lineNameMap!=="undefined"&&lineNameMap[r.line_name])||r.line_name});});
      // 分页(可选): 带 page/pageSize 时包成统一 envelope {success,data:{items,total,page,pageSize}}; 不带则保持裸数组(向后兼容)
      if(params.get('page')!=null){const page=parseInt(params.get('page'),10)||1,pageSize=parseInt(params.get('pageSize'),10)||50;const total=_mapped.length;const items=_mapped.slice((page-1)*pageSize,(page-1)*pageSize+pageSize);json({success:true,data:{items,total,page,pageSize}});return;}
      json(_mapped);return;}
      if(method==='POST'){const b=await readBody(req);await db.insertDowntime(b);dashCache.clear();json({success:true});return;}
      if(method==='PUT'){const b=await readBody(req);const id=b._id;delete b._id;await db.updateDowntime(id,b);dashCache.clear();json({success:true});return;}
      if(method==='DELETE'){const id=params.get('id');await db.deleteDowntime(id);dashCache.clear();json({success:true});return;}
    }
    if(path==='/api/shift-config'){
      if(method==='GET'){json({success:true,items:await db.getShiftConfigs()});return;}
      if(method==='POST'||method==='PUT'){const b=await readBody(req);await db.saveShiftConfig(b);json({success:true});return;}
      if(method==='DELETE'){const id=params.get('id');await db.deleteShiftConfig(id);json({success:true});return;}
    }
    if(path==='/api/shift-override'){
      if(method==='GET'){const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||'');json({success:true,items:await db.getShiftOverrides(df,dt,line)});return;}
      if(method==='POST'||method==='PUT'){const b=await readBody(req);await db.saveShiftOverride(b);json({success:true});return;}
      if(method==='DELETE'){const id=params.get('id');await db.deleteShiftOverride(id);json({success:true});return;}
    }
    if(path==='/api/downtime-categories'){
      if(method==='GET'){json({success:true,categories:await db.getDowntimeCategories()});return;}
      if(method==='PUT'||method==='POST'){const b=await readBody(req);await db.saveDowntimeCategories(b);json({success:true});return;}
    }
    if(path==='/api/oee/mtbf-mttr'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||'');
      const oee=await db.computeOEE(df,dt,line);
      json(oee.map(o=>({line_name:o.line_name,line_display:lineNameMap[o.line_name]||o.line_name,mtbf:o.mtbf,mttr:o.mttr,breakdown_count:o.breakdown_count})));return;
    }
    if(path==='/api/lines'||path==='/api/admin/lines'){
      if(method==='GET'){const lines=await db.getLines();json({items:lines.map(l=>({id:l.line_name,code:l.line_name,name:l.line_display||lineNameMap[l.line_name]||l.line_name}))});return;}
      if(method==='POST'){const b=await readBody(req);await db.saveLine(b);json({success:true});return;}
    }
    if(path==='/api/bad/sync-status'){
      const entries = [];
      for(const [date,info] of syncLog) entries.push({date,...info});
      entries.sort((a,b)=>b.date.localeCompare(a.date));
      json({success:true, entries:entries.slice(0,30)});return;
    }

    // ===== BAD ANALYSIS ROUTES =====
    if(path==='/api/bad/fast'){
      const started=Date.now();
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('lineName')||params.get('lineId')||params.get('line')||'');
      const cacheKey=[df,dt,line].join('|');
      const cached=badFastCache.get(cacheKey);
      // 分页参数(可选): 不带则全量 badItems(向后兼容); 带则切片 — 缓存存全量, 命中后再切(避免 page2 命中 page1 缓存)
      const _hasPage=params.get('page')!=null;
      const _page=parseInt(params.get('page'),10)||1,_pageSize=parseInt(params.get('pageSize'),10)||50;
      function _sliceBadItems(payload){
        if(!_hasPage) return payload;
        const all=payload.badItems||[];const total=payload.badItemsTotal!=null?payload.badItemsTotal:all.length;
        const items=all.slice((_page-1)*_pageSize,(_page-1)*_pageSize+_pageSize);
        return Object.assign({},payload,{badItems:items,badItemsTotal:total,page:_page,pageSize:_pageSize});
      }
      if(cached&&Date.now()-cached.at<5000){json(_sliceBadItems({...cached.payload,cached:true,elapsed_ms:Date.now()-started}));return;}
      const mongodb=db.getDb();
      const prodCol=mongodb.collection('ai_production');
      const badCol=mongodb.collection('ai_bad_repair');
      const prodMatch={move_out_date:{$gte:df,$lte:dt}};
      const badMatch={test_date:{$gte:df,$lte:dt}};
      if(line){prodMatch.line_name=line;badMatch.line_name=badLineMatch(line);}
      const [prodByDay,badItemsRaw]=await Promise.all([
        prodCol.aggregate([
          {$match:db.prefixAi(prodMatch)},
          {$group:{_id:'$ai_move_out_date',total:{$sum:1}}},
          {$sort:{_id:1}}
        ]).toArray(),
        badCol.find(db.prefixAi(badMatch),{
          projection:db.prefixAi({
            _id:0, id:1, barcode:1, line_name:1, product_model:1, work_operation_name:1,
            bad_items:1, category_name:1, content_name:1, causes_name:1, remark:1,
            repair_state_code:1, repair_man:1, repair_time:1, test_user:1,
            quality_inspector:1, mo_lot_no:1, task_order_no:1, item_number:1,
            repair_total:1, test_time:1, test_date:1
          })
        }).sort({ai_test_time:-1}).toArray()
      ]);
      const badItems = db.stripAi(badItemsRaw);
      const mappedBad=badItems.map(b=>({
        lineName:lineNameMap[b.line_name]||b.line_name||'',
        lineCode:b.line_name||'',
        productModel:b.product_model||'',
        workOprationName:b.work_operation_name||'',
        badItems:b.bad_items||'',
        categoryName:b.category_name||'',
        contentName:b.content_name||'',
        causesName:b.causes_name||'',
        remark:b.remark||'',
        repairTotal: b.repair_total != null ? Number(b.repair_total) : null,
        repairStateCode: b.repair_state_code != null ? b.repair_state_code : null,
        testTime:b.test_time||'',
        testDate:b.test_date||'',
        barcode:b.barcode||'',
        repairMan:b.repair_man||'',
        repairTime:b.repair_time||'',
        testUser:b.test_user||'',
        qualityInspector:b.quality_inspector||'',
        moLotNo:b.mo_lot_no||'',
        taskOrderNo:b.task_order_no||'',
        itemNumber:b.item_number||''
      }));
      const uniqueSNs=new Set();
      const byProcess={},byDefect={},byDay={};
      mappedBad.forEach(item=>{
        if(item.barcode)uniqueSNs.add(item.barcode);
        const proc=item.workOprationName||'未知';
        if(!byProcess[proc])byProcess[proc]=new Set();
        byProcess[proc].add(item.barcode||(item.testTime+'|'+item.badItems));
        const def=item.badItems||'未知';
        byDefect[def]=(byDefect[def]||0)+1;
        const day=item.testDate||(item.testTime||'').slice(0,10); // 优先运营日 test_date(与全站口径一致), 缺失才回退 UTC 日
        if(day)byDay[day]=(byDay[day]||0)+1;
      });
      const productionTotal=prodByDay.reduce((s,d)=>s+d.total,0);
      // 缓存存全量 badItems(供分页命中后切片); 响应时由 _sliceBadItems 决定全量或切片
      const payload={
        success:true,
        source:'mongo:ai_production+ai_bad_repair',
        cached:false,
        lineName:line,
        productionTotal,
        badTotal:uniqueSNs.size||mappedBad.length,
        badItems:mappedBad,
        badItemsTotal:mappedBad.length,
        prodByDay:prodByDay.map(d=>({date:d._id,total:d.total})),
        badByProcess:Object.entries(byProcess).map(([process,set])=>({process,count:set.size})).sort((a,b)=>b.count-a.count),
        badByDefect:Object.entries(byDefect).map(([defect,count])=>({defect,count})).sort((a,b)=>b.count-a.count),
        badByDay:Object.entries(byDay).map(([date,count])=>({date,count})).sort((a,b)=>a.date.localeCompare(b.date)),
        data_quality:{production:productionTotal>0?'real':'empty',bad:mappedBad.length>0?'real':'empty',scope:line?'single_line':'all_lines'},
        elapsed_ms:Date.now()-started
      };
      if(badFastCache.size>100){const _k=badFastCache.keys().next().value;badFastCache.delete(_k);} // LRU 上限 100, 防枚举日期参数致 Map 无限增长 OOM
      badFastCache.set(cacheKey,{at:Date.now(),payload});
      json(_sliceBadItems(payload));return;
    }
    if(path==='/api/bad/summary'){
      const started=Date.now();
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||params.get('lineId')||'');
      const excludeMisce=params.get('excludeMisce')==='1';
      const stage=params.get('stage')||'all', type=params.get('type')||'all';
      const bsKey=`badSum|${df}|${dt}|${line}|${excludeMisce?1:0}|${stage}|${type}`;
      const bsHit=dashCache.getWithMeta(bsKey);
      if(bsHit.hit){ json({...bsHit.val, cached:true, elapsed_ms:Date.now()-started}); return; }
      const [summary, prodTotal, trend, quality] = await Promise.all([
        db.queryBadSummary(df,dt,badLineMatch(line),excludeMisce,stage,type),
        db.queryProductionTotal(df,dt,line),
        db.queryBadTrend(df,dt,badLineMatch(line),null,stage,type),
        computeQuality(df,dt,badLineMatch(line)).catch(()=>null)
      ]);
      const uniqueBad = summary.barcodes ? summary.barcodes.filter(b=>b).length : 0;
      const fpy = prodTotal>0 ? +((prodTotal-uniqueBad)/prodTotal*100).toFixed(2) : null;
      const badRate = prodTotal>0 ? +(uniqueBad/prodTotal*100).toFixed(2) : 0;
      // 闭环率用 unique-SN 口径(summary 已算好), 与前端 KPI/焦点壳一致
      const closureRate = summary.closureRate != null ? summary.closureRate : (summary.total>0 ? +(summary.closed/summary.total*100).toFixed(1) : 0);
      const days = trend.length || 1;
      const dailyAvg = Math.round(uniqueBad/days);
      // TOP defects
      const defMap={};
      (summary.topDefects||[]).forEach(d=>{defMap[d]=(defMap[d]||0)+1;});
      const topDefects=Object.entries(defMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,count])=>({name,count}));
      // Compare vs previous period
      const rangeDays = Math.max(1, Math.round((new Date(dt)-new Date(df))/86400000)+1);
      const prevTo = new Date(new Date(df).getTime()-86400000).toISOString().split('T')[0];
      const prevFrom = new Date(new Date(prevTo).getTime()-(rangeDays-1)*86400000).toISOString().split('T')[0];
      const [prevSummary, prevProd] = await Promise.all([
        db.queryBadSummary(prevFrom,prevTo,badLineMatch(line),excludeMisce,stage,type),
        db.queryProductionTotal(prevFrom,prevTo,line)
      ]);
      const prevUniqueBad = prevSummary.barcodes ? prevSummary.barcodes.filter(b=>b).length : 0;
      const prevFpy = prevProd>0 ? +((prevProd-prevUniqueBad)/prevProd*100).toFixed(2) : null;
      const prevBadRate = prevProd>0 ? +(prevUniqueBad/prevProd*100).toFixed(2) : 0;
      // 闭环率环比: prevClosureRate(unique-SN 口径, 与本期同口径) + delta, 供对比卡显示
      const prevClosureRate = prevSummary.closureRate != null ? prevSummary.closureRate : (prevSummary.total>0 ? +(prevSummary.closed/prevSummary.total*100).toFixed(1) : null);
      const closureRateDelta = (closureRate != null && prevClosureRate != null) ? +(closureRate - prevClosureRate).toFixed(1) : null;
      const _result={
        success:true, fpy, badRate, badTotal:uniqueBad, closureRate, dailyAvg, days,
        productionTotal:prodTotal, closedCount:summary.closed, totalRecords:summary.total,
        bad_unique:summary.bad_unique, closed_unique:summary.closed_unique, // 供前端 KPI/焦点壳 unique-SN 副信息(与 closureRate 同口径)
        topDefects, stage, type,
        closureAvgHours: summary.closureAvgHours, closureP50Hours: summary.closureP50Hours,
        closureP90Hours: summary.closureP90Hours, closureCount: summary.closureCount,
        data_quality:{production:prodTotal>0?'real':'empty',fpy:prodTotal>0?'real':'empty'},
        compare:{ prevFpy, prevBadRate, prevBadTotal:prevUniqueBad, fpyDelta:(fpy!=null&&prevFpy!=null)?+(fpy-prevFpy).toFixed(2):null, badRateDelta:+(badRate-prevBadRate).toFixed(2), prevClosureRate, closureRateDelta },
        rework: quality ? { rate: quality.rework_rate, sn_count: quality.rework_sn_count, total_sn: quality.total_sn_count, by_category: quality.rework_by_category || [] } : null
      };
      dashCache.set(bsKey, _result, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
      json({..._result, cached:false, elapsed_ms:Date.now()-started});return;
    }
    if(path==='/api/bad/trend'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||params.get('lineId')||'');
      const stage=params.get('stage')||'all', type=params.get('type')||'all';
      const trend = await db.queryBadTrend(df,dt,badLineMatch(line),null,stage,type);
      const prodCol = db.getDb().collection('ai_production');
      const dailyProd = await prodCol.aggregate([
        {$match:db.prefixAi({move_out_date:{$gte:df,$lte:dt}})},
        {$group:{_id:'$ai_move_out_date',total:{$sum:1}}},
        {$sort:{_id:1}}
      ]).toArray();
      const prodMap = {};
      dailyProd.forEach(d=>{prodMap[d._id]=d.total;});
      const data = trend.map(t=>({
        date:t.date, badCount:t.unique_count, records:t.count, closed:t.closed,
        production:prodMap[t.date]||0,
        fpy: (prodMap[t.date]||0)>0 ? +(((prodMap[t.date]-t.unique_count)/(prodMap[t.date]))*100).toFixed(2) : null
      }));
      json({success:true, data});return;
    }
    if(path==='/api/bad/by-shift'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||params.get('lineId')||'');
      const r = await db.queryBadByShift(df,dt,line);
      json({success:true, data:r.data, total:r.total});return;
    }
    if(path==='/api/bad/pareto'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||params.get('lineId')||'');
      const groupBy=params.get('groupBy')||'defect';
      const stage=params.get('stage')||'all', type=params.get('type')||'all';
      const data = await db.queryBadPareto(df,dt,badLineMatch(line),groupBy,stage,type);
      json({success:true, data});return;
    }
    if(path==='/api/bad/spc'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||params.get('lineId')||'');
      const stage=params.get('stage')||'all', type=params.get('type')||'all';
      const badByDay = await db.queryBadSPC(df,dt,badLineMatch(line),stage,type);
      const prodCol = db.getDb().collection('ai_production');
      const dailyProd = await prodCol.aggregate([
        {$match:db.prefixAi({move_out_date:{$gte:df,$lte:dt}})},
        {$group:{_id:'$ai_move_out_date',total:{$sum:1}}},
        {$sort:{_id:1}}
      ]).toArray();
      const prodMap = {};
      dailyProd.forEach(d=>{prodMap[d._id]=d.total;});
      // P-chart: proportion defective
      const points = badByDay.map(d=>{
        const n = prodMap[d.date]||0;
        const p = n>0 ? d.unique_bad/n : 0;
        return {date:d.date, p:+p.toFixed(6), n, defects:d.unique_bad};
      }).filter(d=>d.n>0);
      const totalN = points.reduce((s,p)=>s+p.n,0);
      const totalD = points.reduce((s,p)=>s+p.defects,0);
      const pBar = totalN>0 ? totalD/totalN : 0;
      const spcData = points.map(p=>{
        const sigma = Math.sqrt(pBar*(1-pBar)/p.n);
        return {...p, cl:+pBar.toFixed(6), ucl:+Math.min(pBar+3*sigma,1).toFixed(6), lcl:+Math.max(pBar-3*sigma,0).toFixed(6)};
      });
      // Western Electric Rules violations
      const violations = [];
      for(let i=0;i<spcData.length;i++){
        const pt=spcData[i];
        if(pt.p>pt.ucl||pt.p<pt.lcl) violations.push({index:i,date:pt.date,rule:'out_of_limits',value:pt.p});
        if(i>=6){
          const last7=spcData.slice(i-6,i+1);
          if(last7.every(x=>x.p>x.cl)) violations.push({index:i,date:pt.date,rule:'7_above_cl'});
          if(last7.every(x=>x.p<x.cl)) violations.push({index:i,date:pt.date,rule:'7_below_cl'});
        }
      }
      json({success:true, pBar:+pBar.toFixed(6), points:spcData, violations});return;
    }
    if(path==='/api/bad/correlation'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||params.get('lineId')||'');
      const stage=params.get('stage')||'all', type=params.get('type')||'all';
      const data = await db.queryBadCorrelation(df,dt,badLineMatch(line),stage,type);
      json({success:true,...data});return;
    }
    if(path==='/api/bad/ai-analysis'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('line')||params.get('lineName')||params.get('lineId')||'');
      const stage=params.get('stage')||'all', type=params.get('type')||'all';
      // excludeMisce 由 type 推导(与前端 fetchAdvancedData 同口径), 避免 type=all 时 AI 用扣误测子集
      // 而主 summary 用全集, 导致同屏闭环率 0% vs 53% 矛盾
      const aiExcludeMisce = (type==='real' || type==='abnormal');
      const [summary, trend, pareto, correlation] = await Promise.all([
        db.queryBadSummary(df,dt,badLineMatch(line),aiExcludeMisce,stage,type),
        db.queryBadTrend(df,dt,badLineMatch(line),null,stage,type),
        db.queryBadPareto(df,dt,badLineMatch(line),'defect',stage,type),
        db.queryBadCorrelation(df,dt,badLineMatch(line),stage,type)
      ]);
      const prodTotal = await db.queryProductionTotal(df,dt,line);
      const uniqueBad = summary.barcodes ? summary.barcodes.filter(b=>b).length : 0;
      const badRate = prodTotal>0 ? (uniqueBad/prodTotal*100) : 0;
      const insights = [];
      // Trend analysis
      if(trend.length>=3){
        const recent3=trend.slice(-3);
        const avg3=recent3.reduce((s,t)=>s+t.unique_count,0)/3;
        const earlier=trend.slice(0,-3);
        if(earlier.length>=3){
          const earlyAvg=earlier.reduce((s,t)=>s+t.unique_count,0)/earlier.length;
          if(avg3>earlyAvg*1.5) insights.push({level:'danger',title:'不良上升趋势',detail:`近3天日均不良${Math.round(avg3)}件，较前期均值${Math.round(earlyAvg)}件上升${Math.round((avg3/earlyAvg-1)*100)}%`,suggestion:'建议立即排查TOP不良项根因'});
          else if(avg3<earlyAvg*0.7) insights.push({level:'success',title:'不良持续改善',detail:`近3天日均${Math.round(avg3)}件，较前期下降${Math.round((1-avg3/earlyAvg)*100)}%`});
        }
      }
      // Top defect concentration
      if(pareto.length>=1){
        const top1Pct = summary.total>0 ? (pareto[0].count/summary.total*100) : 0;
        if(top1Pct>30) insights.push({level:'warning',title:`TOP1不良集中度高`,detail:`"${pareto[0].name}"占比${top1Pct.toFixed(1)}%，建议专项改善`,suggestion:`聚焦"${pareto[0].name}"进行8D分析`});
      }
      // Repeat NG
      if(correlation.repeatSN&&correlation.repeatSN.length>5){
        insights.push({level:'warning',title:'重复不良较多',detail:`${correlation.repeatSN.length}个条码出现多次NG，最高${correlation.repeatSN[0].count}次`,suggestion:'检查维修质量，关注返修后复测流程'});
      }
      // Closure rate — 用 unique-SN 口径(summary.closureRate), 与 KPI/对比卡一致; record-based 作兜底
      const closureRate = summary.closureRate != null ? summary.closureRate : (summary.total>0 ? (summary.closed/summary.total*100) : null);
      const openUnique = (summary.bad_unique||0) - (summary.closed_unique||0);
      if(closureRate!=null&&closureRate<60) insights.push({level:'danger',title:`闭环率仅${closureRate.toFixed(1)}%`,detail:`${openUnique}个条码未闭环`,suggestion:'督促维修人员及时录入维修结果'});
      // Bad rate check
      if(badRate>5) insights.push({level:'danger',title:`不良率${badRate.toFixed(2)}%超标`,detail:`目标<5%，当前${uniqueBad}/${prodTotal}`,suggestion:'建议召开品质异常会议'});
      else if(badRate<1&&prodTotal>100) insights.push({level:'success',title:`不良率${badRate.toFixed(2)}%`,detail:'品质表现优秀'});
      // Time pattern
      if(correlation.byHour&&correlation.byHour.length>0){
        const peakHour = correlation.byHour[0];
        if(peakHour.count>5) insights.push({level:'info',title:`${peakHour.hour}时不良高发`,detail:`"${peakHour.defect}"在${peakHour.hour}时出现${peakHour.count}次`,suggestion:'关注该时段设备/人员状态'});
      }
      if(insights.length===0) insights.push({level:'info',title:prodTotal>0?'暂无异常':'暂无真实生产数据',detail:prodTotal>0?'各项品质指标正常运行':'当前日期范围没有 MES 过站数据，品质规则不生成结论'});
      json({success:true,source:'rule-engine',data_quality:{production:prodTotal>0?'real':'empty'},insights});return;
    }
    if(path==='/api/task-orders'){json(await db.getTaskOrders());return;}
    if(path==='/api/products'||path.startsWith('/api/products/')){
      if(method==='GET'){
        const items=(await db.getProducts()).map(p=>({
          id:p.product_model,
          model:p.product_model,
          name:p.product_name||p.product_model,
          cycle_time:p.cycle_time,
          uph:p.uph,
          source:'mongo:ai_product_config'
        })).filter(p=>p.id||p.model);
        json({success:true,items,data:items,source:'mongo:ai_product_config'});return;
      }
      if(method==='POST'||method==='PUT'){
        const b=await readBody(req);
        if(!b.product_model){json({success:false,error:'product_model必填'});return;}
        await db.saveProduct({product_model:b.product_model, product_name:b.product_name||b.name||b.product_model, cycle_time:b.cycle_time||0, uph:b.uph||0});
        json({success:true});return;
      }
      if(method==='DELETE'){
        const model=decodeURIComponent(path.split('/api/products/')[1]||'');
        if(!model){json({success:false,error:'需要产品型号'});return;}
        await db.deleteProduct(model);
        json({success:true});return;
      }
    }
    if(path==='/api/work-operations'){
      const items=(await db.getWorkOperations()).map(w=>({
        id:w.code||w.work_operation_code||w.name,
        code:w.code||w.work_operation_code||'',
        name:w.name||w.work_operation_name||w.code||'',
        line_name:w.line_name||'',
        source:'mongo:ai_work_operations'
      })).filter(w=>w.id||w.name);
      json({success:true,items,data:items,source:'mongo:ai_work_operations'});return;
    }
    if(path==='/api/equipment'){
      const items=(await db.getEquipment()).map(e=>({
        id:e.code||e.machine_code||e.name,
        code:e.code||e.machine_code||'',
        name:e.name||e.machine_name||e.code||'',
        line_name:e.line_name||e.lineName||'',
        source:'mongo:ai_machines'
      })).filter(e=>e.id||e.name);
      json({success:true,items,data:items,source:'mongo:ai_machines'});return;
    }
    if(path==='/api/wip/overview'){
      const df=today(),dt=df;
      const wipData=await computeWIP(df,dt,'');
      const lines=await db.getLines();
      json({success:true,data:{totalWip:wipData.wip_count,lineCount:lines.length,exceededCount:null,data_quality:{exceededCount:'not_configured'}}});return;
    }

    // ===== AI ANNOUNCEMENTS =====
    if(path==='/api/announcements'){
      const started=Date.now();
      const days=parseInt(params.get('days'))||7;
      const todayStr=today();
      // 构建日期列表(今天→过去)
      const dateList=[];
      for(let i=0;i<days;i++){const d=new Date();d.setDate(d.getDate()-i);dateList.push(d.toISOString().split('T')[0]);}

      // 按天并行计算(原为串行 N+1, days=30=22.7s); 过去天命中 6h 缓存, 今天命中 15s 预热缓存
      async function buildDayItem(dateStr){
        const cacheKey='announce_'+dateStr;
        // 过去天: 优先用已缓存的完整 item(含 _raw 比对数据)
        if(dateStr!==todayStr){
          try{
            const cached=await db.col.cache.findOne({ai_key:cacheKey});
            if(cached&&cached.ai_data){return cached.ai_data;}
          }catch(e){}
        }
        // computeDashboard 命中缓存(过去天 6h, 今天 15s 预热)
        const {val:data} = await computeDashboardCached(dateStr,dateStr);
        // 前一天对比数据
        let prev=null;
        try{
          const d=new Date(dateStr+'T00:00:00');d.setDate(d.getDate()-1);
          const prevStr=d.toISOString().split('T')[0];
          const prevCache=await db.col.cache.findOne({ai_key:'announce_'+prevStr});
          if(prevCache&&prevCache.ai_data&&prevCache.ai_data._raw) prev=prevCache.ai_data._raw;
          else { const {val:pd}=await computeDashboardCached(prevStr,prevStr); prev=pd; }
        }catch(e){}

        const highlights=[];
        let level='good';
        if(data.upph.total_output>0) highlights.push({icon:'📦',text:`产量 ${data.upph.total_output}`,color:'blue'});
        if(data.fpy.value>0){
          highlights.push({icon:'✅',text:`直通率 ${data.fpy.value}%`,color:data.fpy.value>=95?'green':'orange'});
          if(data.fpy.value<95) level='warn';
        }
        if(data.oee.oee>0){
          highlights.push({icon:'⚙️',text:`OEE ${data.oee.oee}%`,color:data.oee.oee>=80?'green':data.oee.oee>=60?'orange':'red'});
          if(data.oee.oee<60) level='bad';
        }
        if(data.ppm.value>0){
          highlights.push({icon:'🔍',text:`PPM ${data.ppm.value}`,color:data.ppm.value<=1000?'green':data.ppm.value<=2000?'orange':'red'});
          if(data.ppm.value>=2000) level='bad';
        }
        if(data.fpy.total_ng>0) highlights.push({icon:'⚠️',text:`不良 ${data.fpy.total_ng} 件`,color:data.fpy.total_ng>20?'red':'orange'});
        if(data.mistest_rate.value>30) highlights.push({icon:'🔧',text:`误测率 ${data.mistest_rate.value}%`,color:'orange'});

        // Comparison with previous day
        const comparison=[];
        if(prev&&prev.upph&&prev.upph.total_output>0&&data.upph.total_output>0){
          const diff=data.upph.total_output-prev.upph.total_output;
          const pct=((diff/prev.upph.total_output)*100).toFixed(1);
          comparison.push({metric:'产量',diff,pct:+pct,direction:diff>=0?'up':'down'});
        }
        if(prev&&prev.fpy&&prev.fpy.value>0&&data.fpy.value>0){
          const diff=+(data.fpy.value-prev.fpy.value).toFixed(2);
          comparison.push({metric:'直通率',diff,pct:diff,unit:'%',direction:diff>=0?'up':'down'});
        }
        if(prev&&prev.oee&&prev.oee.oee>0&&data.oee.oee>0){
          const diff=+(data.oee.oee-prev.oee.oee).toFixed(1);
          comparison.push({metric:'OEE',diff,pct:diff,unit:'%',direction:diff>=0?'up':'down'});
        }

        // TOP defects
        const topDefects=data.repair_top.slice(0,3).map(r=>({name:r.name,count:r.count}));

        // Line status breakdown
        const lines=data.line_summary.map(l=>{
          const oeeItem=data.oee_by_line.find(o=>o.line_name===l.code);
          return {name:l.name,output:l.output,oee:oeeItem?oeeItem.oee:null,status:oeeItem?(oeeItem.oee>=80?'good':oeeItem.oee>=60?'warn':'bad'):(l.output>0?'good':'neutral')};
        });

        let summary='';
        if(data.upph.total_output===0){summary='当日无生产数据';level='neutral';}
        else{
          const parts=[];
          parts.push(`产量${data.upph.total_output}`);
          if(data.fpy.value>0)parts.push(`直通率${data.fpy.value}%`);
          if(data.oee.oee>0)parts.push(`OEE${data.oee.oee}%`);
          summary=parts.join('，');
          if(level==='good')summary+='，各项指标正常运行';
          else if(level==='bad')summary+='，存在需关注的异常项';
          else if(level==='warn')summary+='，部分指标未达标';
        }
        const dd=new Date(dateStr+'T00:00:00');
        const weekdays=['日','一','二','三','四','五','六'];
        const title=`${dateStr.slice(5)} 周${weekdays[dd.getDay()]} 生产日报`;
        const item={date:dateStr,title,summary,highlights,level,comparison,topDefects,lines,_raw:{upph:data.upph,fpy:data.fpy,oee:data.oee,ppm:data.ppm}};
        // Cache past days
        if(dateStr!==todayStr){
          try{await db.col.cache.updateOne({ai_key:cacheKey},{ $set:{ai_key:cacheKey,ai_data:item,ai_updated_at:Date.now()} },{upsert:true});}catch(e){}
        }
        return item;
      }
      // 并行(限并发 6, 避免打满远程连接池)
      const CONC=6; let idx=0;
      const runners=Array.from({length:Math.min(CONC,days)},async()=>{
        const out=[];
        while(idx<dateList.length){const cur=dateList[idx++]; out.push(await buildDayItem(cur).catch(()=>({date:cur,title:`${cur.slice(5)} 数据异常`,summary:'数据加载失败',highlights:[],level:'neutral',comparison:[],topDefects:[],lines:[]}))); }
        return out;
      });
      const chunks=await Promise.all(runners);
      const announcements=chunks.flat().sort((a,b)=>b.date.localeCompare(a.date));
      // Generate AI suggestions based on multi-day patterns
      const withData=announcements.filter(a=>a._raw&&a._raw.upph.total_output>0);
      const suggestions=[];
      if(withData.length>=3){
        const recentPPMs=withData.slice(0,3).map(a=>a._raw.ppm.value);
        if(recentPPMs.every(v=>v>=2000))suggestions.push({level:'danger',text:'连续'+recentPPMs.length+'天PPM≥2000，建议召开品质专项会议'});
        const recentFpy=withData.slice(0,3).map(a=>a._raw.fpy.value);
        if(recentFpy.every(v=>v<95))suggestions.push({level:'warning',text:'连续'+recentFpy.length+'天直通率<95%，建议排查TOP不良项'});
        const recentOee=withData.slice(0,3).map(a=>a._raw.oee.oee);
        if(recentOee.every(v=>v>0&&v<60))suggestions.push({level:'warning',text:'连续'+recentOee.length+'天OEE<60%，建议分析停机和节拍损失'});
        const outputs=withData.slice(0,5).map(a=>a._raw.upph.total_output);
        if(outputs.length>=3){
          const trend=outputs[0]-outputs[outputs.length-1];
          if(trend<0&&Math.abs(trend)>outputs[outputs.length-1]*0.2)suggestions.push({level:'info',text:'近期产量呈下降趋势，建议关注产能瓶颈'});
        }
      }
      if(suggestions.length===0&&withData.length>0)suggestions.push({level:'success',text:'近期生产运行平稳，继续保持'});

      // Weekly summary
      const weeklyData=withData.slice(0,7);
      let weekly=null;
      if(weeklyData.length>=2){
        const avgOutput=+(weeklyData.reduce((s,a)=>s+a._raw.upph.total_output,0)/weeklyData.length).toFixed(0);
        const avgFpy=+(weeklyData.reduce((s,a)=>s+a._raw.fpy.value,0)/weeklyData.length).toFixed(2);
        const avgOee=+(weeklyData.reduce((s,a)=>s+a._raw.oee.oee,0)/weeklyData.length).toFixed(1);
        const totalOutput=weeklyData.reduce((s,a)=>s+a._raw.upph.total_output,0);
        const totalNG=weeklyData.reduce((s,a)=>s+a._raw.fpy.total_ng,0);
        const goodDays=weeklyData.filter(a=>a.level==='good').length;
        const warnDays=weeklyData.filter(a=>a.level==='warn').length;
        const badDays=weeklyData.filter(a=>a.level==='bad').length;
        // Trend: compare first half vs second half
        const half=Math.floor(weeklyData.length/2);
        const firstHalf=weeklyData.slice(0,half),secondHalf=weeklyData.slice(half);
        const trendOutput=firstHalf.length&&secondHalf.length?((firstHalf.reduce((s,a)=>s+a._raw.upph.total_output,0)/firstHalf.length)-(secondHalf.reduce((s,a)=>s+a._raw.upph.total_output,0)/secondHalf.length)):0;
        weekly={days:weeklyData.length,totalOutput,totalNG,avgOutput,avgFpy,avgOee,goodDays,warnDays,badDays,outputTrend:trendOutput>0?'up':trendOutput<0?'down':'flat',
          sparkOutput:weeklyData.map(a=>a._raw.upph.total_output).reverse(),
          sparkFpy:weeklyData.map(a=>a._raw.fpy.value).reverse(),
          sparkOee:weeklyData.map(a=>a._raw.oee.oee).reverse()
        };
      }

      // Strip _raw from response
      const clean=announcements.map(a=>{const{_raw,...rest}=a;return rest;});
      json({success:true,announcements:clean,suggestions,weekly});return;
    }

    // ===== AI INSIGHTS =====
    if(path==='/api/ai-insights'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df;
      const {val:d} = await computeDashboardCached(df,dt);
      const insights=[];
      const pageOf=(t,det)=>{const s=(t||'')+(det||'');if(/误测|PPM|直通率|不良/.test(s))return'bad';if(/OEE|UPPH|停机|UPH/.test(s))return'oee';if(/WIP/.test(s))return'wip';if(/连接|同步|内存/.test(s))return'health';return'oee';};
      if(d.mistest_rate.value>50)insights.push({level:'danger',title:`误测率 ${d.mistest_rate.value}%`,detail:'ATE/EOL测试设备需要校准',suggestion:'建议TE排查测试夹具和程序'});
      if(d.oee.oee<60)insights.push({level:'warning',title:`OEE ${d.oee.oee}%`,detail:`性能稼动率${d.oee.performance}%是瓶颈`,suggestion:'需录入停机记录以精确计算'});
      if(d.oee.oee>=85)insights.push({level:'success',title:`OEE ${d.oee.oee}%`,detail:'综合设备效率达标'});
      if(d.fpy.value!=null&&d.fpy.value>=99.5)insights.push({level:'success',title:`直通率 ${d.fpy.value}%`,detail:`${d.fpy.total_tested}次过站仅${d.fpy.total_ng}次NG`});
      if(d.fpy.value!=null&&d.fpy.value<95&&d.fpy.value>0)insights.push({level:'warning',title:`直通率 ${d.fpy.value}%`,detail:`低于95%目标，需关注不良TOP项`,suggestion:'查看品质分析Tab找到重点改善项'});
      if(d.ppm.value<1000&&d.ppm.value>0)insights.push({level:'info',title:`PPM ${d.ppm.value}`,detail:`扣除误测后真实不良${d.ppm.real_ng}个`});
      if(d.ppm.value>=2000)insights.push({level:'danger',title:`PPM ${d.ppm.value}`,detail:`真实不良${d.ppm.real_ng}个，需立即改善`,suggestion:'建议召开品质异常会议'});
      if(d.upph.value!=null&&d.upph.target!=null&&d.upph.value<d.upph.target*0.8)insights.push({level:'warning',title:`UPPH ${d.upph.value}`,detail:`低于目标${d.upph.target}的80%`,suggestion:'检查是否有产线异常停线'});
      if(insights.length===0)insights.push({level:'info',title:d.upph.total_output>0?'暂无异常':'暂无真实生产数据',detail:d.upph.total_output>0?'各项指标正常运行':'当前日期范围没有 MES 过站数据，规则引擎不生成正常结论'});
      insights.forEach(it=>{it.page=pageOf(it.title,it.detail);});
      json({success:true,source:'rule-engine',data_quality:d.data_quality,insights});return;
    }

    // ===== AI CHAT =====
    if(path==='/api/ai-chat'&&method==='POST'){
      const b=await readBody(req);
      const question=b.question||b.message||'';
      if(!question){json({success:false,error:'请输入问题'});return;}
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||today();
      const {val:d} = await computeDashboardCached(df,dt);
      const context=`日期:${df}, 产量:${d.upph.total_output}, 不良:${d.fpy.total_ng}, 直通率:${d.fpy.value}%, OEE:${d.oee.oee}%, PPM:${d.ppm.value}, UPPH:${d.upph.value}, 误测率:${d.mistest_rate.value}%`;
      let answer='';
      if(/直通率|合格率|良率/.test(question))answer=d.fpy.value==null?'当前日期范围没有 MES 过站数据，无法计算真实直通率。':`今日直通率 ${d.fpy.value}%，共过站 ${d.fpy.total_tested} 次，NG ${d.fpy.total_ng} 次。${d.fpy.value>=95?'达标':'未达95%目标'}`;
      else if(/不良|NG|缺陷/.test(question)){const top=d.repair_top.slice(0,5).map(r=>`${r.name}(${r.count})`).join('、');answer=`今日不良 ${d.fpy.total_ng} 个，TOP5类别: ${top}。PPM: ${d.ppm.value}`;}
      else if(/OEE|设备|稼动/.test(question))answer=`综合OEE ${d.oee.oee}%，稼动率 ${d.oee.availability}%，性能率 ${d.oee.performance}%，良品率 ${d.oee.quality}%`;
      else if(/产量|产出|UPH|效率/.test(question))answer=`今日产量 ${d.upph.total_output}，UPPH ${d.upph.value}。产线排名: ${d.line_summary.slice(0,3).map(l=>`${l.name}(${l.output})`).join('、')}`;
      else if(/误测|NTF/.test(question))answer=`误测率 ${d.mistest_rate.value}%，共${d.mistest_rate.mistest_count}个误测(占全部NG的${d.mistest_rate.value}%)`;
      else if(/建议|改善|怎么办/.test(question)){
        const suggestions=[];
        if(d.fpy.value!=null&&d.fpy.value<95)suggestions.push(`直通率${d.fpy.value}%偏低，建议重点关注TOP不良项`);
        if(d.oee.oee>0&&d.oee.oee<70)suggestions.push(`OEE${d.oee.oee}%偏低，检查停机和节拍损失`);
        if(d.mistest_rate.value>50)suggestions.push(`误测率${d.mistest_rate.value}%偏高，建议校准测试设备`);
        if(d.ppm.value>2000)suggestions.push(`PPM${d.ppm.value}偏高，建议专项整改`);
        answer=suggestions.length?suggestions.join('\n'):'各项指标正常，继续保持！';
      }
      else answer=`当前概况: ${context}\n\n如需详细分析请问具体指标（如"直通率怎么样"、"哪个不良最多"）`;
      json({success:true,source:'rule-engine',data_quality:d.data_quality,result:answer});return;
    }

    // ===== ADMIN ROUTES =====
    if(path.startsWith('/api/admin/')){const _s=isAuth(req);if(!_s||_s.role!=='admin'){json({error:'forbidden'},403);return;}}
    if(path==='/api/admin/session-info'){const s=isAuth(req);json(s?{user:s.user,role:s.role}:{});return;}
    if(path==='/api/admin/server-status'){
      const mem=process.memoryUsage();
      json({success:true,data:{uptime:process.uptime(),memory:mem,memoryUsage:{rss:Math.round(mem.rss/1024/1024),heapUsed:Math.round(mem.heapUsed/1024/1024)},mesCookie:!!mesCookies,lastSync:lastSyncTime,syncCount,sessions:sessions.size,activeSessions:sessions.size,wsClients:wss?.clients?.size||0,nodeVersion:process.version}});
      return;
    }
    if(path==='/api/admin/db-info'){const stats={};for(const[n,c]of Object.entries(db.col)){try{stats[n]=await c.countDocuments()}catch(e){stats[n]=0}}json({success:true,data:stats});return;}
    if(path==='/api/admin/sync-trigger'){const date=params.get('date')||today();syncData(date).catch(console.error);json({success:true,status:'started',date,message:`已触发 ${date} 同步`});return;}
    if(path==='/api/admin/users'&&method==='GET'){
      // 系统仅 2 个固定账号(admin 后门 + MES 用户), 无用户表; last_login 从活跃 sessions 取最近登录时间(真实)
      const sessArr = Array.from(sessions.values());
      const lastLogin = (u) => { const ts = sessArr.filter(s=>s.user===u).map(s=>s.created); return ts.length ? new Date(Math.max(...ts)).toISOString() : null; };
      json({success:true,data:[{id:'admin',username:'admin',role:'admin',status:'active',display_name:'管理员',created_at:null,last_login:lastLogin('admin')},{id:'mes-user',username:USERNAME,role:'user',status:'active',display_name:'MES用户',created_at:null,last_login:lastLogin(USERNAME)}]});return;
    }
    if(path==='/api/admin/sessions'){json({success:true,data:Array.from(sessions.entries()).map(([t,s])=>({token:t.substring(0,8)+'...',tokenPrefix:t.substring(0,8),user:s.user,role:s.role,loginTime:s.created,created:new Date(s.created).toISOString(),alive:'在线'}))});return;}
    if(path==='/api/admin/log-stats'){json({success:true,data:{totalToday:syncCount,errorsToday:_stats.errCount,requestsLastHour:_statsReqLastHour()}});return;}
    if(path==='/api/admin/logs'){
      // 真实近期错误日志(内存环形缓冲, 最近 200 条, 重启清空); 非持久化, 仅供运维即时排查
      const page = Math.max(1, parseInt(params.get('page'))||1);
      const pageSize = Math.min(Math.max(1, parseInt(params.get('pageSize'))||50), 200);
      const level = params.get('level')||'';   // 当前仅 error 级
      const search = (params.get('search')||'').toLowerCase();
      let rows = _stats.errLog.slice().reverse(); // 最新在前
      if (level) rows = rows.filter(r => r.level === level);
      if (search) rows = rows.filter(r => (r.message||'').toLowerCase().includes(search) || (r.path||'').toLowerCase().includes(search));
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const start = (page-1) * pageSize;
      json({ success:true, rows: rows.slice(start, start+pageSize), total, page, pageSize, totalPages, stored:false, note:'日志仅存内存最近200条,重启清空;完整日志见服务端终端输出' });
      return;
    }
    // === 治具/线材台账 CRUD (admin 鉴权自动生效) ===
    if(path==='/api/admin/fixture'){
      if(method==='GET'){json({success:true, data: await db.getFixtures({})}); return;}
      if(method==='POST'){const b=await readBody(req); await db.insertFixture(b); json({success:true}); return;}
      if(method==='PUT'){const b=await readBody(req); const id=b._id; delete b._id; await db.updateFixture(id,b); dashCache.clear(); json({success:true}); return;}
      if(method==='DELETE'){const id=params.get('id'); await db.deleteFixture(id); dashCache.clear(); json({success:true}); return;}
    }
    if(path==='/api/admin/aging-cable'){
      if(method==='GET'){json({success:true, data: await db.getAgingCables({})}); return;}
      if(method==='POST'){const b=await readBody(req); await db.insertAgingCable(b); json({success:true}); return;}
      if(method==='PUT'){const b=await readBody(req); const id=b._id; delete b._id; await db.updateAgingCable(id,b); json({success:true}); return;}
      if(method==='DELETE'){const id=params.get('id'); await db.deleteAgingCable(id); json({success:true}); return;}
    }
    // EDO 台账导入(线材+治具, 触发 Python 脚本: openpyxl+pymongo, 幂等 by edo_id)
    if(path==='/api/admin/import-edo-cables' && method==='POST'){
      const { execFile } = require('child_process');
      const { join, basename } = require('path');
      const scripts = ['import_edo_cables.py','import_edo_fixtures.py','maintain_assets.py'].map(s=>join(__dirname,'scripts',s));
      let out='', errOut=''; let pending=scripts.length;
      scripts.forEach(s=>execFile('python',[s],{cwd:__dirname,maxBuffer:4*1024*1024},(err,stdout,stderr)=>{
        out += '\n===== '+basename(s)+' =====\n'+stdout.toString();
        if(err) errOut += basename(s)+': '+err.message+'; '+(stderr?stderr.toString().slice(-400):'');
        if(--pending===0) json({ success:!errOut, output: out.slice(-3000), stderr: errOut });
      }));
      return;
    }
    // 客户机型→内部料号 对照表 (ai_model_map) CRUD
    if(path==='/api/admin/model-map'){
      const mc = db.getDb().collection('ai_model_map');
      if(method==='GET'){json({success:true, data: db.stripAi(await mc.find({}, {projection:{_id:0}}).sort({ai_customer:1}).toArray())}); return;}
      if(method==='POST'){const b=await readBody(req); if(!b.customer||!b.internal){json({success:false,error:'customer/internal 必填'});return;} await mc.updateOne(db.prefixAi({customer:b.customer}),db.prefixAi({$set:{customer:b.customer, internal:b.internal, match:b.match||'prefix', note:b.note||'', source:'manual', updated_at:Date.now()}}),{upsert:true}); json({success:true}); return;}
    }
    if(path.startsWith('/api/admin/model-map/') && method==='DELETE'){
      const customer=decodeURIComponent(path.split('/').pop());
      await db.getDb().collection('ai_model_map').deleteOne(db.prefixAi({customer}));
      json({success:true}); return;
    }
    // 未映射机型(机型对不上 production, 待用户补对照捞回)
    if(path==='/api/admin/unmapped-models' && method==='GET'){
      const agg = async (coll, type) => {
        const r = await db.getDb().collection(coll).aggregate([
          {'$match': db.prefixAi({match_product_model: null, product_model: {'$nin':[null,'','/','无']}})},
          {'$group': {_id: '$ai_product_model', n: {'$sum': 1}}},
          {'$sort': {n: -1}}, {'$limit': 30}
        ]).toArray();
        return r.map(x=>({model: x._id, count: x.n, type}));
      };
      const data = [...await agg('ai_aging_cable','线材'), ...await agg('ai_fixture','治具')].sort((a,b)=>b.count-a.count);
      json({success:true, data}); return;
    }
    if(path==='/api/production-plan/summary'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df;
      const plans=await db.getProductionPlan({date:{$gte:df,$lte:dt}});
      const totalTarget=plans.reduce((s,p)=>s+(parseInt(p.target_qty)||0),0);
      const totalProd=await db.queryProductionTotal(df,dt);
      json({success:true,totalTarget,totalCompleted:totalProd,achievement:totalTarget>0?+(totalProd/totalTarget*100).toFixed(1):0,count:plans.length});return;
    }
    if(path==='/api/production-plan'){
      if(method==='GET'){const q={};const d=params.get('date'),ln=params.get('lineName');if(d)q.date=d;if(ln)q.line_name=ln;const data=await db.getProductionPlan(q);json({success:true,data});return;}
      if(method==='POST'){const b=await readBody(req);await db.insertProductionPlan(b);json({success:true});return;}
    }
    if(path.startsWith('/api/production-plan/')&&(method==='PUT'||method==='DELETE')){
      const id=path.split('/').pop();
      if(method==='PUT'){const b=await readBody(req);await db.updateProductionPlan(id,b);json({success:true});return;}
      if(method==='DELETE'){await db.deleteProductionPlan(id);json({success:true});return;}
    }
    if(path==='/api/attendance'){
      if(method==='GET'){const q={};const df=params.get('dateFrom'),dt=params.get('dateTo'),ln=params.get('lineName');if(df&&dt)q.date={$gte:df,$lte:dt};if(ln)q.line_name=ln;const rows=await db.getAttendance(q);json({success:true,data:rows,rows});return;}
      if(method==='POST'){const b=await readBody(req);await db.insertAttendance(b);json({success:true});return;}
    }
    if(path.startsWith('/api/attendance/')&&(method==='PUT'||method==='DELETE')){
      const id=path.split('/').pop();
      if(method==='PUT'){const b=await readBody(req);await db.updateAttendance(id,b);json({success:true});return;}
      if(method==='DELETE'){await db.deleteAttendance(id);json({success:true});return;}
    }
    if(path==='/api/exceptions'){
      if(method==='GET'){const q={};const st=params.get('status'),df=params.get('dateFrom'),dt=params.get('dateTo'),ln=params.get('lineName');if(st)q.status=st;if(df&&dt)q.created_at={$gte:new Date(df).getTime(),$lte:new Date(dt+'T23:59:59').getTime()};if(ln)q.line_name=ln;const rows=await db.getExceptions(q);const open=rows.filter(r=>r.status==='open').length;json({success:true,rows,total:rows.length,openCount:open});return;}
      if(method==='POST'){const b=await readBody(req);await db.insertException(b);json({success:true});return;}
    }
    if(path.startsWith('/api/exceptions/')&&(method==='PUT'||method==='DELETE')){
      const id=path.split('/').pop();
      if(method==='PUT'){const b=await readBody(req);await db.updateException(id,b);json({success:true});return;}
      if(method==='DELETE'){await db.deleteException(id);json({success:true});return;}
    }
    if(path==='/api/action-items'){
      if(method==='GET'){const q={};const st=params.get('status'),df=params.get('dateFrom'),dt=params.get('dateTo');if(st)q.status=st;if(df&&dt)q.created_at={$gte:new Date(df).getTime(),$lte:new Date(dt+'T23:59:59').getTime()};const rows=await db.getActionItems(q);const pending=rows.filter(r=>r.status!=='done').length;json({success:true,rows,total:rows.length,pendingCount:pending});return;}
      if(method==='POST'){const b=await readBody(req);await db.insertActionItem(b);json({success:true});return;}
    }
    if(path.startsWith('/api/action-items/')&&(method==='PUT'||method==='DELETE'||method==='GET')){
      const id=path.split('/').pop();
      if(method==='GET'){const {ObjectId}=require('mongodb');const item=await db.col.action_items.findOne({_id:new ObjectId(id)});json({success:true,item});return;}
      if(method==='PUT'){const b=await readBody(req);await db.updateActionItem(id,b);json({success:true});return;}
      if(method==='DELETE'){await db.deleteActionItem(id);json({success:true});return;}
    }
    if(path==='/api/maintenance'){
      if(method==='GET'){const q={};const df=params.get('dateFrom'),dt=params.get('dateTo'),ln=params.get('lineName'),st=params.get('status');if(df&&dt)q.date={$gte:df,$lte:dt};if(ln)q.line_name=ln;if(st)q.status=st;const data=await db.getMaintenance(q);json({success:true,data});return;}
      if(method==='POST'){const b=await readBody(req);await db.insertMaintenance(b);json({success:true});return;}
    }
    if(path.startsWith('/api/maintenance/')&&(method==='PUT'||method==='DELETE')){
      const id=path.split('/').pop();
      if(method==='PUT'){const b=await readBody(req);await db.updateMaintenance(id,b);json({success:true});return;}
      if(method==='DELETE'){await db.deleteMaintenance(id);json({success:true});return;}
    }
    if(path==='/api/incoming-inspection'){
      if(method==='GET'){const q={};const df=params.get('dateFrom'),dt=params.get('dateTo'),r2=params.get('result');if(df&&dt)q.date={$gte:df,$lte:dt};if(r2)q.result=r2;const data=await db.getInspection(q);json({success:true,data});return;}
      if(method==='POST'){const b=await readBody(req);await db.insertInspection(b);json({success:true});return;}
    }
    if(path.startsWith('/api/incoming-inspection/')&&(method==='PUT'||method==='DELETE')){
      const id=path.split('/').pop();
      if(method==='PUT'){const b=await readBody(req);await db.updateInspection(id,b);json({success:true});return;}
      if(method==='DELETE'){await db.deleteInspection(id);json({success:true});return;}
    }
    if(path==='/api/settings'&&method==='GET'){
      const cache=db.getDb().collection('ai_cache');
      const doc=await cache.findOne({ai_key:'kpi_targets'});
      const defaults={daily_output:1500,fpy:95,oee:85,ppm:3000};
      json({success:true,data:doc?.ai_value||defaults});return;
    }
    if(path==='/api/settings'&&method==='PUT'){
      const b=await readBody(req);
      const cache=db.getDb().collection('ai_cache');
      const existing=await cache.findOne({ai_key:'kpi_targets'});
      const next=(b && b.key) ? {...(existing?.ai_value||{}), [b.key]: b.value} : b;
      await cache.replaceOne({ai_key:'kpi_targets'},{ai_key:'kpi_targets',ai_value:next,ai_updated_at:Date.now()},{upsert:true});
      json({success:true});return;
    }
    if(path==='/api/backup/list'){json({success:true,data:[],message:'暂未配置备份存储目录'});return;}
    if(path==='/api/wip'){
      const started=Date.now();
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=params.get('lineName')||'';
      const productModel=params.get('productModel')||'';  // 机型过滤(工艺路线选机型后按此取该机型WIP)
      const wKey=`wip|${df}|${dt}|${line}|${productModel}`;
      const wHit=dashCache.getWithMeta(wKey);
      if(wHit.hit){ json({...wHit.val, cached:true, elapsed_ms:Date.now()-started}); return; }
      const wipData = await computeWIP(df,dt,line,productModel||undefined);
      // 加入工序中文名(复用引用缓存, 避免全表扫描)
      try {
        const opMap = {};
        (await db.getWorkOperations()).forEach(o => { opMap[o.code] = o.name; });
        wipData.by_operation.forEach(op => { op.operation_name = opMap[op.operation] || op.operation; });
      } catch(e) {}
      dashCache.set(wKey, wipData, isPastDate(dt) ? DASH_TTL_PAST : DASH_TTL_TODAY);
      json({...wipData, cached:false, elapsed_ms:Date.now()-started});return;
    }
    // 批次维度 WIP(计划工程师:每批次在制 SN 数 + 卡在哪工序 + 最久滞留)
    if(path==='/api/wip/by-batch'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=params.get('lineName')||'';
      const started=Date.now();
      try {
        const data = await computeWipByBatch(df,dt,line);
        json({...data, cached:false, elapsed_ms:Date.now()-started});
      } catch(e){ json({success:false, error:e.message}, 500); }
      return;
    }
    // 按工单/批次取在制 SN 明细(下钻第2层:工单→SN)
    if(path==='/api/wip/sns-by-order'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df;
      const taskNo=params.get('taskNo')||'';
      const moLotNo=params.get('moLotNo')||'';
      if(!taskNo&&!moLotNo){json({error:'需要 taskNo 或 moLotNo 参数'},400);return;}
      const started=Date.now();
      try {
        const mongodb=db.getDb();
        const prodCol=mongodb.collection('ai_production');
        const taskCol=mongodb.collection('ai_task_orders');
        const match={move_out_date:{$gte:df,$lte:dt}};
        // 若只给 moLotNo,先查出对应 task_no 集合
        let taskFilter={};
        if(taskNo) taskFilter.task_order_no=taskNo;
        else {
          const taskRows=db.stripAi(await taskCol.find(db.prefixAi({mo_lot_no:moLotNo}),{projection:{_id:0,ai_task_no:1}}).toArray());
          const nos=taskRows.map(r=>r.task_no).filter(Boolean);
          if(!nos.length){json({success:true,items:[],total:0,elapsed_ms:Date.now()-started});return;}
          taskFilter.task_order_no={$in:nos};
        }
        // 每个 SN 最后工序 + 滞留
        const snLastOp=await prodCol.aggregate([
          {$match:db.prefixAi({...match,...taskFilter})},
          {$sort:{ai_move_out_time:1}},
          {$group:{_id:'$ai_barcode',last_op:{$last:'$ai_work_operation_code'},last_sort:{$last:'$ai_sort_no'},line_name:{$last:'$ai_line_name'},product_model:{$last:'$ai_product_model'},task_order_no:{$last:'$ai_task_order_no'},mo_lot_no:{$last:'$ai_mo_lot_no'},last_time:{$last:'$ai_move_out_time'}}}
        ]).toArray();
        const now=new Date();
        const items=snLastOp.map(s=>{
          const waitMin=s.last_time?Math.round((now-new Date(s.last_time))/60000):0;
          const wH=Math.floor(waitMin/60),wM=waitMin%60;
          return {barcode:s._id,task_order_no:s.task_order_no||'',mo_lot_no:s.mo_lot_no||'',product_model:s.product_model||'',line_name:s.line_name||'',work_operation_code:s.last_op||'',sort_no:s.last_sort||0,last_time:s.last_time,wait_minutes:waitMin,wait_display:wH>0?wH+'h'+wM+'m':wM+'m'};
        }).sort((a,b)=>b.wait_minutes-a.wait_minutes);
        json({success:true,items:items,total:items.length,elapsed_ms:Date.now()-started});
      } catch(e){ json({success:false,error:e.message},500); }
      return;
    }
    // 12-KPI Phase1: 质量域
    if(path==='/api/quality'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=params.get('lineName')||'';
      try { json({success:true, ...(await computeQuality(df,dt,badLineMatch(line)))}); } catch(e){ json({success:false,error:e.message}); }
      return;
    }
    if(path==='/api/delivery/detail'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=params.get('lineName')||'',kpi=params.get('kpi')||'';
      try {
        const d = await computeDelivery(df,dt,line);
        if(kpi==='wip') json({success:true, hours:d.wip_cycle_hours, count:d.wip_count, items:d.by_line});
        else json({success:false,error:'unknown kpi'});
      } catch(e){ json({success:false,error:e.message}); }
      return;
    }
    if(path==='/api/line-balance'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('lineName')||'');
      // WIP 按工序分布 + 工站 UPH/CT + 相邻过站间隔P25(CT真值,替代 3600/UPH 的失真)
      const [wipData, stations, products, opWaitP25] = await Promise.all([
        computeWIP(df,dt,line),
        db.queryStationUPH(df,dt,line),
        db.getProducts(),
        computeOpWaitP25(df,dt,line)
      ]);
      // 标准节拍：work_center===line 的 cycle_time 均值
      // 标准节拍: work_center 是 "L01-组装&测试&包装" 这种前缀,line 是 "ASS_Line1" — 体系不同,
      // 用产线族前缀映射匹配(ASS_Line1→L01, ASS_Line2/2-1→L02, ASS_Line3→L03, QJG_Line*→L03预加工/其他)
      const linePrefix = ({ASS_Line1:'L01', ASS_Line2:'L02', 'ASS_Line2-1':'L02', ASS_Line3:'L03', QJG_Line1:'L01', QJG_Line2:'L03', QJG_Line3:'L03', PKG_Line1:'PKG', QJG_Line4:'PKG'})[line];
      const lineProducts = products.filter(p=>p.cycle_time>0 && (p.work_center===line || (linePrefix && p.work_center && p.work_center.startsWith(linePrefix))));
      const cycle_time_std = lineProducts.length>0 ? +(lineProducts.reduce((s,p)=>s+p.cycle_time,0)/lineProducts.length).toFixed(1) : null;
      // 工序中文名映射
      const opMap = {};
      try {
        const opCol = db.getDb().collection('ai_work_operations');
        (db.stripAi(await opCol.find().toArray())).forEach(o => { opMap[o.code] = o.name; });
      } catch(e) {}
      // WIP 按工序索引
      const wipByOp = {};
      wipData.by_operation.forEach(op => { wipByOp[op.operation] = op; });
      // UPH 按工序索引
      const uphByOp = {};
      stations.forEach(s => { uphByOp[s.operation] = s; });
      // 合并工站列表：以 stations 的 operation 为主键，合并 wipData.by_operation
      const opKeys = new Set([...Object.keys(uphByOp), ...Object.keys(wipByOp)]);
      const stationList = [];
      for (const op of opKeys) {
        const w = wipByOp[op] || {};
        const s = uphByOp[op] || {};
        stationList.push({
          operation: op,
          operation_name: w.operation_name || opMap[op] || op,
          sort_no: w.sort_no!=null ? w.sort_no : (s.sort_no!=null ? s.sort_no : 999),
          wip_count: w.count!=null ? w.count : 0,
          uph: s.uph!=null ? s.uph : null,
          // CT(节拍,用于平衡率/瓶颈)= 3600/UPH(工位产能节拍,对并行/批处理工位正确:多台并行→UPH高→CT低→反映整体产能)。
          // 注:曾试 P25 过站间隔,但对老化/EOL/包装等堆积工位即使P25仍含大量等待→CT虚高→平衡率失真。UPH口径才是线平衡正确节拍。
          ct_seconds: s.ct_seconds!=null ? s.ct_seconds : null,
          ct_source: s.ct_seconds!=null ? 'uph' : null,
          // dwell_seconds(单台停留P25):辅助字段,反映该工位单台实际停留(含等待),值大=堆积风险,不用于平衡率
          dwell_seconds: opWaitP25[op]!=null ? +opWaitP25[op].toFixed(1) : null,
          ct_sample_insufficient: !!s.sample_insufficient  // 低频工位(total<maxTotal*5%):有CT值但不参与平衡率/瓶颈
        });
      }
      // 计算瓶颈(排除样本不足工位,避免低频极值CT误判瓶颈)
      // 加 stage 字段(组装/测试/包装),用于分段平衡率(段内比合理,跨段产能不同属正常)
      const _stageOf = name => { if(!name) return 'assembly'; if(/包装|下料|贴标|封箱|装箱/.test(name)) return 'packaging'; if(/测试|检测|EOL|ATE|振动|震动|老化|噪音|异响|目检|PIN|静置|GP12/.test(name)) return 'test'; return 'assembly'; };
      stationList.forEach(s => { s.stage = _stageOf(s.operation_name || s.operation); });
      const validStations = stationList.filter(s=>!s.ct_sample_insufficient);
      const ctVals = validStations.map(s=>s.ct_seconds).filter(v=>v!=null && v>0);
      const max_ct = ctVals.length>0 ? Math.max(...ctVals) : 0;
      const wipCounts = stationList.map(s=>s.wip_count);
      const max_wip = wipCounts.length>0 ? Math.max(...wipCounts) : 0;
      const ctBottleneck = validStations.find(s=>s.ct_seconds!=null && s.ct_seconds===max_ct) || null;
      const wipBottleneck = max_wip>0 ? stationList.find(s=>s.wip_count===max_wip) : null;
      const ctCount = ctVals.length;
      // ctCount=0(无CT数据)时 balance_rate=null 而非0, 避免前端误判 0% 红区 danger(规格 corners #5/#7)
      const balance_rate = (ctCount>0 && max_ct>0) ? +(ctVals.reduce((s,v)=>s+v,0)/(ctCount*max_ct)*100).toFixed(1) : null;
      const loss_rate = balance_rate!=null ? +(100-balance_rate).toFixed(1) : null;
      // 分段平衡率(段内比,排除多产品混线专属工位CT虚高对跨段比较的失真)
      const stageBalance = (stage) => {
        const sv = validStations.filter(s => s.stage === stage && s.ct_seconds != null && s.ct_seconds > 0);
        if (sv.length < 2) return null;
        const sMax = Math.max(...sv.map(s => s.ct_seconds));
        const sAvg = sv.reduce((sum, s) => sum + s.ct_seconds, 0) / sv.length;
        return +(sAvg / sMax * 100).toFixed(1);
      };
      const balance_assembly = stageBalance('assembly');
      const balance_test = stageBalance('test');
      const balance_packaging = stageBalance('packaging');
      // 线体节拍 = 瓶颈工站 UPH（最小 UPH,排除样本不足）
      const uphVals = validStations.map(s=>s.uph).filter(v=>v!=null && v>0);
      const line_uph = uphVals.length>0 ? +Math.min(...uphVals).toFixed(1) : 0;
      stationList.forEach(s=>{
        s.is_ct_bottleneck = ctBottleneck!=null && s.operation===ctBottleneck.operation;
        s.is_wip_bottleneck = wipBottleneck!=null && s.operation===wipBottleneck.operation;
      });
      // 按 mes 路线归一化平均位置排序(跨产品稳定,解决 by_operation last_sort 漂移),然后赋连续序号 1..N
      let mesRoutesLB = [];
      try { mesRoutesLB = db.stripAi(await db.getDb().collection('ai_process_routes').find(db.prefixAi({line_name:line, source:'mes'})).toArray()); } catch(e){}
      stationList.forEach(s => { s._norm_pos = opNormPos(mesRoutesLB, s.operation); });
      stationList.sort((a,b) => (a._norm_pos ?? 1.1) - (b._norm_pos ?? 1.1) || a.sort_no - b.sort_no);
      stationList.forEach((s,i) => { s.sort_no = i + 1; delete s._norm_pos; });
      json({
        success:true,
        line,
        line_display:lineNameMap[line]||line,
        balance_rate: line ? balance_rate : null,
        loss_rate: line ? loss_rate : null,
        // 分段平衡率(段内比,排除多产品混线专属工位CT虚高的跨段失真;null=该段工位<2无法算)
        balance_assembly: line ? balance_assembly : null,
        balance_test: line ? balance_test : null,
        balance_packaging: line ? balance_packaging : null,
        bottleneck_op: ctBottleneck ? ctBottleneck.operation : null,
        bottleneck_op_name: ctBottleneck ? ctBottleneck.operation_name : null,
        bottleneck_ct: max_ct>0 ? +max_ct.toFixed(1) : null,
        cycle_time_std,
        line_uph,
        stations: stationList,
        // data_quality.balance_rate: valid=有CT可算 / no_data=选线但无CT(工站0或全无过站) / hidden=未选线跨线混合
        data_quality:{scope:line?'single_line':'mixed_lines',balance_rate: line ? (ctCount>0 ? 'valid' : 'no_data') : 'hidden'},
        warning: !line ? '未选择线体,当前仅展示工站清单,请选择单线查看平衡率'
                 : (ctCount===0 ? '当前时段该线体无过站节拍数据,无法计算平衡率(非产线不平衡)' : null)
      });return;
    }
    if(path==='/api/production-by-stage'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df,line=resolveLineName(params.get('lineName')||'');
      json({success:true, ...(await db.queryProductionByStage(df,dt,line))});return;
    }
    // === UPH 产出统计 (多粒度并展 · 机型/线体/工序维度 · 三段末道工位口径) ===
    if(path==='/api/uph-stats'){
      const df=params.get('dateFrom')||today(), dt=params.get('dateTo')||df;
      const prevFrom=params.get('prevFrom')||'', prevTo=params.get('prevTo')||'';
      const line=resolveLineName(params.get('lineName')||'');
      const model=params.get('model')||'';
      const op=params.get('op')||'';
      const stage=params.get('stage')||'';
      const shift=params.get('shift')||'';
      let stageOps=null;
      if (stage && !op) stageOps = await db.getStageOpCodes(stage);
      const filters={lineName:line,model,opCode:op,stageOps,shift};
      const cKey=`uph-stats|${df}|${dt}|${line}|${model}|${op}|${stage}|${shift}`;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){ json({...hit.val,cached:true}); return; }
      // 6 粒度累计(今日/周/月/季/半年/年 各 total+环比), 固定不随主范围变, 随filters变
      const granDefs=[['realtime','realtime'],['week','week'],['month','month'],['quarter','quarter'],['half','half'],['year','year']];
      const granular={};
      await Promise.all(granDefs.map(([k,p])=>{
        const r=uphPeriodRange(p);
        // 用 queryProductionSummary 一次拿 total+uph+run_hours+mom(供6粒度卡补UPH/运行时长, 比queryProductionCount多算UPH)
        return db.queryProductionSummary(r.dateFrom,r.dateTo,filters,r.prevFrom||null,r.prevTo||null).then(s=>{
          granular[k]={label:r.label,total:s.total,prev_total:s.prev_total,mom:s.mom,uph:s.uph,run_hours:s.run_hours,run_source:s.run_source,dateFrom:r.dateFrom,dateTo:r.dateTo};
        });
      }));
      const [summary,hourly,daily,byModel,byLine,byOperation,stageEnd,dataStart,byOperationHour,hourlyEnd]=await Promise.all([
        db.queryProductionSummary(df,dt,filters, prevFrom||null, prevTo||null),
        db.queryProductionAgg(df,dt,filters,'hour'),
        db.queryProductionAgg(df,dt,filters,'day'),
        db.queryProductionAgg(df,dt,filters,'model'),
        db.queryProductionAgg(df,dt,filters,'line'),
        db.queryProductionAgg(df,dt,filters,'operation'),
        db.queryProductionByStageEnd(df,dt,filters),
        db.getProductionDataStart(),
        db.queryProductionOpHour(df,dt,filters),
        db.queryProductionByHourEnd(df,dt,filters)
      ]);
      // 工序中文名映射(供前端展示)
      const opMap={};
      try{ (await db.getWorkOperations()).forEach(o=>{ if(o.code) opMap[o.code]=o.name; }); }catch(e){}
      const result={
        success:true, cached:false,
        range:{dateFrom:df,dateTo:dt},
        filters:{lineName:line,line_display:lineNameMap[line]||line,model,op,op_display:opMap[op]||op,stage,shift},
        summary,hourly,daily,byModel,byLine,byOperation,byOperationHour,hourlyEnd,stageEnd,granular,dataStart,opMap
      };
      dashCache.set(cKey,result,15*1000);
      json(result); return;
    }
    // 机型/工序/线体 下拉选项(机型取实际有产出的, 工序取全集)
    // 交叉产出矩阵(行×列二维去重SN) — 维度透视, 任意两维交叉看各个数据
    if(path==='/api/uph-matrix'){
      const df=params.get('dateFrom')||today(), dt=params.get('dateTo')||df;
      const line=resolveLineName(params.get('lineName')||'');
      const model=params.get('model')||'';
      const op=params.get('op')||'';
      const stage=params.get('stage')||'';
      const shift=params.get('shift')||'';
      const rowDim=params.get('rowDim')||'model';
      const colDim=params.get('colDim')||'line';
      let stageOps=null;
      if (stage && !op) stageOps = await db.getStageOpCodes(stage);
      const filters={lineName:line,model,opCode:op,stageOps,shift};
      const cKey=`uph-matrix|${df}|${dt}|${line}|${model}|${op}|${stage}|${shift}|${rowDim}|${colDim}`;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){ json({...hit.val,cached:true}); return; }
      const rows = await db.queryProductionMatrix(df, dt, filters, rowDim, colDim);
      const opMap={};
      if (rowDim==='operation' || colDim==='operation') {
        try{ (await db.getWorkOperations()).forEach(o=>{ if(o.code) opMap[o.code]=o.name; }); }catch(e){}
      }
      const lineMap={};
      try{ (await db.getLines()).forEach(l=>{ lineMap[l.line_name]=l.line_display||lineNameMap[l.line_name]||l.line_name; }); }catch(e){}
      const result={ success:true, cached:false, rowDim, colDim, rows, opMap, lineMap };
      dashCache.set(cKey, result, 15*1000);
      json(result); return;
    }
    if(path==='/api/uph-filters'){
      const line=resolveLineName(params.get('lineName')||'');
      const cKey='uph-filters|'+line;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){ json({success:true,...hit.val,cached:true}); return; }
      // 工序/机型从 ai_production distinct(实际有产出, 非work_operations全集421), 按线体收窄 — 同 bad 页按实际数据收窄选项
      const m={ product_model:{$nin:[null,'']}, work_operation_code:{$nin:[null,'']} };
      if(line) m.line_name=line;
      const [models, opCodes, lines, opDocs]=await Promise.all([
        db.getDb().collection('ai_production').distinct('ai_product_model', db.prefixAi(m)),
        db.getDb().collection('ai_production').distinct('ai_work_operation_code', db.prefixAi(m)),
        db.getLines(),
        db.getWorkOperations()
      ]);
      const opNameMap={};
      opDocs.forEach(o=>{ if(o.code) opNameMap[o.code]=o.name||o.code; });
      const result={
        models:models.filter(Boolean).sort(),
        operations:opCodes.filter(Boolean).map(c=>({code:c,name:opNameMap[c]||c})).sort((a,b)=>a.name.localeCompare(b.name)),
        lines:lines.map(l=>({code:l.line_name,name:l.line_display||lineNameMap[l.line_name]||l.line_name}))
      };
      dashCache.set(cKey,result,5*60*1000);
      json({success:true,...result,cached:false}); return;
    }
    // === 产能数据集对账 (CapacityDataSet vs product_config, 供P0权威源确认) ===
    if(path==='/api/capacity-data'){
      const cKey='capacity-data';
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){ json({success:true,...hit.val,cached:true}); return; }
      const [capData, products] = await Promise.all([db.getCapacityData(), db.getProducts()]);
      const capByModel = {};
      capData.forEach(c => {
        if(!c.product_model) return;
        let e = capByModel[c.product_model];
        if(!e){ e = {product_model:c.product_model, ct:null, uph:null, order_types:[], segments:new Set(), ops:new Set()}; capByModel[c.product_model]=e; }
        if(c.order_type && !e.order_types.includes(c.order_type)) e.order_types.push(c.order_type);
        if(c.process_segment_code) e.segments.add(c.process_segment_code);
        if(c.work_operation_id) e.ops.add(c.work_operation_id);
        if(c.order_type==='量产' && c.ct!=null){ e.ct=c.ct; e.uph=c.uph_value; }
        else if(e.ct==null && c.ct!=null){ e.ct=c.ct; e.uph=c.uph_value; }
      });
      const prodByModel = {};
      products.forEach(p => { if(p.product_model) prodByModel[p.product_model]=p; });
      const rows = Object.values(capByModel).map(e => {
        const pcCt = prodByModel[e.product_model]?.cycle_time ?? null;
        return { product_model:e.product_model, cap_ct:e.ct, cap_uph:e.uph, pc_ct:pcCt, pc_uph:prodByModel[e.product_model]?.uph ?? null,
          diff:(e.ct!=null && pcCt!=null)? +(e.ct - pcCt).toFixed(1) : null,
          order_types:e.order_types, segment_count:e.segments.size, op_count:e.ops.size };
      }).sort((a,b)=>a.product_model.localeCompare(b.product_model));
      const onlyInPc = products.filter(p => p.product_model && !capByModel[p.product_model]).map(p => ({product_model:p.product_model, pc_ct:p.cycle_time, pc_uph:p.uph}));
      const result = { rows, only_in_pc:onlyInPc, stats:{ cap_models:rows.length, pc_models:products.length, cap_total:capData.length, diff_count:rows.filter(r=>r.diff!=null && r.diff!==0).length } };
      dashCache.set(cKey, result, 5*60*1000);
      json({success:true,...result,cached:false}); return;
    }
    // === 治具寿命 & 老化线材管控 (过站反推·校准中) ===
    // 缓存(治具/线材台账变更频率低, 但 used_count 随过站每 30s 变; 取 15s TTL 与 dashboard 同步新鲜度)
    if(path==='/api/fixtures'){
      const line=resolveLineName(params.get('lineName')||'');
      const cKey=`fixtures|${line}`;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){json({success:true,data:hit.val.data,cached:true});return;}
      const data=await db.queryFixtures(line);
      dashCache.set(cKey,{data},DASH_TTL_TODAY);
      json({success:true,data,cached:false}); return;
    }
    if(path==='/api/aging-cables'){
      const line=resolveLineName(params.get('lineName')||'');
      const cKey=`cables|${line}`;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){json({success:true,data:hit.val.data,cached:true});return;}
      const data=await db.queryAgingCables(line);
      dashCache.set(cKey,{data},DASH_TTL_TODAY);
      json({success:true,data,cached:false}); return;
    }
    if(path==='/api/aging-cable-groups'){
      const line=resolveLineName(params.get('lineName')||'');
      const cKey=`cableGroups|${line}`;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){json({success:true,data:hit.val.data,cached:true});return;}
      const data=await db.queryAgingCableGroups(line);
      dashCache.set(cKey,{data},DASH_TTL_TODAY);
      json({success:true,data,cached:false}); return;
    }
    if(path==='/api/aging-cables/reconcile'){
      const line=resolveLineName(params.get('lineName')||'');
      const data=await db.queryAgingCableReconcile(line);
      json({success:true,data}); return;
    }
    if(path==='/api/fixtures/overview'){
      const line=resolveLineName(params.get('lineName')||'');
      const cKey=`fixOverview|${line}`;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){json({success:true,data:hit.val,cached:true});return;}
      const data=await db.queryFixtureOverview(line);
      dashCache.set(cKey,data,DASH_TTL_TODAY);
      json({success:true,data,cached:false}); return;
    }
    if(path==='/api/fixtures/bad-correlation'){
      const line=resolveLineName(params.get('lineName')||'');
      const cKey=`fixBadCorr|${line}`;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){json({success:true,data:hit.val,cached:true});return;}
      const data=await db.queryFixtureBadCorrelation(line);
      dashCache.set(cKey,data,DASH_TTL_TODAY);
      json({success:true,data,cached:false}); return;
    }
    if(path==='/api/fixtures/scrap-stats'){
      const line=resolveLineName(params.get('lineName')||'');
      const cKey=`fixScrapStats|${line}`;
      const hit=dashCache.getWithMeta(cKey);
      if(hit.hit){json({success:true,data:hit.val,cached:true});return;}
      const data=await db.queryScrapStats(line);
      dashCache.set(cKey,data,DASH_TTL_TODAY);
      json({success:true,data,cached:false}); return;
    }
    // 聚合端点: scroll-board 大屏一次性取全部数据(内部全命中缓存, 17 调用→1 调用)
    if(path==='/api/board-snapshot'){
      const started=Date.now();
      const boardHit=dashCache.getWithMeta('board-snapshot');
      if(boardHit.hit){ json({...boardHit.val, cached:true, elapsed_ms:Date.now()-started}); return; }
      const result = await computeBoardSnapshot();
      dashCache.set('board-snapshot', result, 120*1000);
      json({...result, cached:false, elapsed_ms:Date.now()-started});return;
    }
    if(path==='/api/wip/detail'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df;
      const opCode=params.get('operation')||'';
      const line=params.get('lineName')||'';
      if(!opCode){json({error:'需要operation参数'},400);return;}
      const snDetail = await getWipSnDetail(df,dt,opCode,line);
      // 分页(可选): 带 page/pageSize 时对 items 切片并补 page/pageSize; 不带则原样返回(向后兼容,截顶50条)
      if(params.get('page')!=null){
        const page=parseInt(params.get('page'),10)||1,pageSize=parseInt(params.get('pageSize'),10)||50;
        const allItems=snDetail.items||[];const total=snDetail.total!=null?snDetail.total:allItems.length;
        const items=allItems.slice((page-1)*pageSize,(page-1)*pageSize+pageSize);
        json({success:true,data:{items,total,page,pageSize}});return;
      }
      // 非分页: 截顶50条,与历史行为一致
      json(Object.assign({},snDetail,{items:(snDetail.items||[]).slice(0,50)}));return;
    }
    if(path==='/api/output/sns'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df;
      const line=params.get('line')||params.get('lineName')||'';
      const hour=params.get('hour')||'';
      const started=Date.now();
      const page=parseInt(params.get('page'),10)||1,pageSize=parseInt(params.get('pageSize'),10)||50;
      const result=await db.queryOutputSns(df,dt,line,hour,{page,pageSize});
      json({success:true,data:{items:result.items,total:result.total,page:result.page,pageSize:result.pageSize},cached:false,elapsed_ms:Date.now()-started});return;
    }
    if(path==='/api/output/by-shift'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df;
      const line=params.get('line')||params.get('lineName')||'';
      const started=Date.now();
      const r=await db.queryOutputByShift(df,dt,line);
      json({success:true,data:r.data,total:r.total,cached:false,elapsed_ms:Date.now()-started});return;
    }
    if(path==='/api/sn/trace'){
      const barcode=params.get('barcode')||'';
      if(!barcode){json({error:'需要barcode参数'},400);return;}
      const started=Date.now();
      const rows=await db.querySnTrace(barcode);
      json({success:true,data:rows,cached:false,elapsed_ms:Date.now()-started});return;
    }
    if(path==='/api/rework/records'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df;
      const line=params.get('line')||params.get('lineName')||'';
      const started=Date.now();
      const page=parseInt(params.get('page'),10)||1,pageSize=parseInt(params.get('pageSize'),10)||50;
      const result=await db.queryReworkRecords(df,dt,line,{page,pageSize});
      json({success:true,data:{items:result.items,total:result.total,page:result.page,pageSize:result.pageSize},cached:false,elapsed_ms:Date.now()-started});return;
    }
    if(path==='/api/wip/cycle-detail'){
      const df=params.get('dateFrom')||today(),dt=params.get('dateTo')||df;
      const line=params.get('lineName')||'';
      const mongodb=db.getDb();
      const prodCol=mongodb.collection('ai_production');
      const match={move_out_date:{$gte:df,$lte:dt}};
      if(line)match.line_name=line;
      // 每个SN每道工序的过站时间
      const snOps=await prodCol.aggregate([
        {$match:db.prefixAi(match)},
        {$sort:{ai_move_out_time:1}},
        {$group:{_id:{barcode:'$ai_barcode',op:'$ai_work_operation_code'},move_time:{$last:'$ai_move_out_time'},sort_no:{$last:'$ai_sort_no'}}}
      ]).toArray();
      // 按SN分组，计算相邻工序间隔
      const snMap={};
      for(const r of snOps){
        if(!snMap[r._id.barcode])snMap[r._id.barcode]=[];
        snMap[r._id.barcode].push({op:r._id.op,time:new Date(r.move_time),sort:r.sort_no});
      }
      const opWait={};
      for(const records of Object.values(snMap)){
        records.sort((a,b)=>a.sort-b.sort);
        for(let i=1;i<records.length;i++){
          const op=records[i].op;
          const gap=(records[i].time-records[i-1].time)/3600000;
          if(gap>0&&gap<720){
            if(!opWait[op])opWait[op]={total:0,count:0,sort:records[i].sort};
            opWait[op].total+=gap;opWait[op].count++;
          }
        }
      }
      // 加工序中文名
      const opCol=mongodb.collection('ai_work_operations');
      const opNameMap={};
      try{(db.stripAi(await opCol.find().toArray())).forEach(o=>{opNameMap[o.code]=o.name});}catch(e){}
      // 按 mes 路线归一化平均位置排序(跨产品稳定,解决过站 sort_no 漂移),赋连续 1..N
      let mesRoutesCD=[];
      try{mesRoutesCD=db.stripAi(await mongodb.collection('ai_process_routes').find(db.prefixAi({line_name:line, source:'mes'})).toArray());}catch(e){}
      const result=Object.entries(opWait).map(([op,d])=>({
        operation:op,operation_name:opNameMap[op]||op,_norm_pos:opNormPos(mesRoutesCD,op),_last:d.sort,
        avg_hours:+(d.total/d.count).toFixed(2),sample_count:d.count
      })).sort((a,b)=>(a._norm_pos??1.1)-(b._norm_pos??1.1)||a._last-b._last)
        .map((o,i)=>({operation:o.operation,operation_name:o.operation_name,sort_no:i+1,avg_hours:o.avg_hours,sample_count:o.sample_count}));
      const totalAvg=result.reduce((s,r)=>s+r.avg_hours,0);
      json({total_cycle_hours:+totalAvg.toFixed(1),by_operation:result});return;
    }
    if(path==='/api/wip/snapshots'){
      const from=params.get('from')||'';
      const to=params.get('to')||todayStr();
      const query=from?{date:{$gte:from,$lte:to}}:{date:{$lte:to}};
      const snaps=db.stripAi(await db.col.daily_snapshot.find(db.prefixAi(query)).sort({ai_date:1}).toArray());
      json(snaps.map(s=>({date:s.date,wip_count:s.wip_count,completed_count:s.completed_count,total_sns:s.total_sns,mfg_cycle_hours:s.mfg_cycle_hours,avg_wip_wait_hours:s.avg_wip_wait_hours,plan_rate:s.plan_rate,plan_total_qty:s.plan_total_qty,plan_completed_qty:s.plan_completed_qty,bottleneck:s.bottleneck})));return;
    }
    if(path==='/api/process-routes'){
      const line=params.get('lineName')||'';
      const match = line ? {line_name:line} : {};
      const routes = db.stripAi(await db.getDb().collection('ai_process_routes').find(db.prefixAi(match)).toArray());
      // 加入工序中文名
      try {
        const opCol = db.getDb().collection('ai_work_operations');
        const opMap = {};
        (db.stripAi(await opCol.find().toArray())).forEach(o => { opMap[o.code] = o.name; });
        routes.forEach(r => r.operations.forEach(op => { if(!op.display_name) op.display_name = opMap[op.name] || op.name; }));
      } catch(e) {}
      json(routes.map(r=>({line_name:r.line_name,product_model:r.product_model,operations:r.operations,source:r.source})));return;
    }
    if(path==='/api/work-order-progress'){
      // 兼容旧调用: 传 limit 时返回裸数组(不分页)
      const limitParam = params.get('limit');
      const limit = limitParam != null ? Math.min(Math.max(Number(limitParam) || 200, 1), 500) : null;
      const paged = limit == null;
      let tasks, total = null, page = 1, pageSize = 50;
      if (paged) {
        page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
        pageSize = Math.min(Math.max(Math.floor(Number(params.get('pageSize')) || 50), 1), 200);
        const r = await db.getTaskOrders({ page, pageSize });
        tasks = r.items; total = r.total; page = r.page; pageSize = r.pageSize;
      } else {
        tasks = await db.getTaskOrders({ limit });
      }
      // 推断每个工单当前在哪道工序（从WIP数据）
      const prodCol = db.getDb().collection('ai_production');
      const opCol = db.getDb().collection('ai_work_operations');
      const opMap = {};
      try { (db.stripAi(await opCol.find().toArray())).forEach(o=>{opMap[o.code]=o.name}); } catch(e){}
      const taskNos = tasks.map(t=>t.task_no).filter(Boolean);
      const latestMap = {};
      if (taskNos.length) {
        const latest = await prodCol.aggregate([
          {$match:db.prefixAi({task_order_no:{$in:taskNos}})},
          {$sort:{ai_task_order_no:1,ai_move_out_time:-1}},
          {$group:{_id:'$ai_task_order_no',work_operation_code:{$first:'$ai_work_operation_code'},line_name:{$first:'$ai_line_name'},move_out_time:{$first:'$ai_move_out_time'}}}
        ]).toArray();
        latest.forEach(r=>{ latestMap[r._id]=r; });
      }

      const result = tasks.map(t => {
        let currentOp = '--';
        let lineCode = '';
        const lastRecord = latestMap[t.task_no];
        if(lastRecord){ currentOp = opMap[lastRecord.work_operation_code] || lastRecord.work_operation_code || '--'; lineCode = lastRecord.line_name || ''; }
        return {
          task_no: t.task_no, mo_lot_no: t.mo_lot_no, product_model: t.product_model,
          qty: t.qty, completed: t.completed_qty,
          progress: t.qty>0 ? +((t.completed_qty||0)/t.qty*100).toFixed(1) : 0,
          status: t.task_mes_status, line_code: lineCode, current_operation: currentOp
        };
      });
      if (paged) {
        json({ success:true, data:{ items:result, total, page, pageSize } });
      } else {
        json(result);
      }
      return;
    }
    if(path==='/api/production-manual'&&method==='POST'){
      const b=await readBody(req);
      const qty=Math.min(parseInt(b.qty)||0,1000);if(qty<=0){json({success:false,error:'数量需>0'});return;}
      const items=[];
      for(let i=0;i<qty;i++){
        items.push({containerName:`MANUAL-${Date.now()}-${i}`,lineCode:b.line_name||'',productModel:'',workOperationCode:'MANUAL',sortNo:9999,taskOrderNo:'',source:'manual',moveOutTime:new Date(b.date+'T'+String(b.hour||8).padStart(2,'0')+':'+String(0).padStart(2,'0')+':00').toISOString()});
      }
      await db.insertProduction(items);
      json({success:true,count:qty});return;
    }
    if(path==='/api/bad-manual'&&method==='POST'){
      const b=await readBody(req);
      const qty=Math.min(parseInt(b.qty)||1,1000);
      const items=[];
      for(let i=0;i<qty;i++){
        items.push({snCode:`MANUAL-BAD-${Date.now()}-${i}`,lineName:b.line_name||'',productModel:'',workOprationName:b.workOprationName||'',badItems:b.bad_items||'',categoryName:'手动录入',contentName:b.bad_items||'',causesName:'',remark:b.remark||'',repairStateCode:0,source:'manual',testTime:new Date(b.date+'T12:00:00').toISOString()});
      }
      await db.insertBadRepair(items);
      json({success:true,count:qty});return;
    }
    if(path==='/api/backfill'&&method==='POST'){const _bs=isAuth(req);if(!_bs||_bs.role!=='admin'){json({error:'forbidden'},403);return;}
      const b=await readBody(req);
      const dateFrom=b.dateFrom||b.date||today(),dateTo=b.dateTo||dateFrom;
      const results=[];
      const d1=new Date(dateFrom),d2=new Date(dateTo);
      for(let dt=new Date(d1);dt<=d2;dt.setDate(dt.getDate()+1)){
        const ds=dt.toISOString().split('T')[0];
        await syncData(ds);
        const prod=await db.queryProductionTotal(ds,ds);
        const bad=(await db.queryBadItems(ds,ds)).length;
        results.push({date:ds,prod,bad});
      }
      json({success:true,results});return;
    }
    // UPH 长周期产量回补(仅产量, 异步): POST /api/uph-backfill?days=90 — 用 syncProductionForDate 逐天补产量历史
    // 比 /api/backfill 快(只补产量, 不重复同步全局路线/工序/不良); 解决 ai_production 只有运行天数深度
    if(path==='/api/uph-backfill'&&method==='POST'){const _bs=isAuth(req);if(!_bs||_bs.role!=='admin'){json({error:'forbidden'},403);return;}
      const days=Math.min(Math.max(parseInt(params.get('days')||'30',10),1),365);
      json({success:true,message:`开始异步回补${days}天产量`});
      (async()=>{
        const t0=Date.now(); const today=new Date(); let total=0;
        for(let i=1;i<=days;i++){
          const d=new Date(today); d.setDate(d.getDate()-i);
          const ds=d.toISOString().split('T')[0];
          try { const n=await syncProductionForDate(ds); total+=n; console.log(`[Backfill-Prod] ${ds} +${n} 累计${total}`); }
          catch(e){ console.log(`[Backfill-Prod] ${ds} 异常: ${e.message?.substring(0,60)}`); }
          await sleep(500);
        }
        console.log(`[Backfill-Prod] 完成 ${days}天 共${total}条 耗时${((Date.now()-t0)/1000).toFixed(0)}s`);
      })().catch(e=>console.error('[Backfill-Prod] 异常',e));
      return;
    }
    // UPH 过站工时回补(任务单切换工时, 全量分批拉取入库, 供UPH实际分母): POST /api/uph-move-backfill
    if(path==='/api/uph-move-backfill'&&method==='POST'){const _bs=isAuth(req);if(!_bs||_bs.role!=='admin'){json({error:'forbidden'},403);return;}
      json({success:true,message:'开始异步回补过站工时'});
      (async()=>{
        const t0=Date.now(); let total=0, skip=0;
        try {
          while(true) { const r = await fetchTaskMoveRecords(skip, 500); if (!r.items.length) break; const n = await db.saveTaskMoveHours(r.items); total += n; skip += r.items.length; console.log(`[Backfill-Move] +${n} 累计${total}/${r.totalCount}`); if (r.items.length<500 || skip>=r.totalCount) break; await sleep(300); }
          console.log(`[Backfill-Move] 完成 共${total}条 耗时${((Date.now()-t0)/1000).toFixed(0)}s`);
        } catch(e) { console.error('[Backfill-Move] 异常', e.message?.substring(0,100)); }
      })().catch(e=>console.error('[Backfill-Move] 异常',e));
      return;
    }


    // ===== SYNC ROUTE =====
    if(path==='/api/sync'){const date=params.get('date')||today();syncData(date).catch(console.error);json({status:'started',date});return;}

    // ===== STATIC FILES =====
    if(path==='/'){
      res.writeHead(302,{'Location':WIP_DESKTOP_MODE?'/wip.html':'/portal.html'});
      res.end();return;
    }

    const distRoot = fspath.join(__dirname,'frontend','dist');
    const filePath = fspath.join(distRoot, path);
    // 路径遍历防护: 解析后必须仍在 dist 内, 否则 404(不再回退 __dirname, 防 .env/server.js 等被当静态文件读出)
    const safePath = () => { try { const r=fspath.resolve(distRoot), p=fspath.resolve(filePath); return p===r || p.startsWith(r+fspath.sep); } catch(e){ return false; } };
    if(safePath() && fs.existsSync(filePath) && fs.statSync(filePath).isFile()){
      const ext=fspath.extname(filePath);
      res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':filePath.includes('libs')?'public,max-age=2592000':'public,max-age=60'});
      fs.createReadStream(filePath).on('error',()=>{try{res.end()}catch(e){}}).pipe(res); // 流式输出, 不阻塞事件循环
    } else { json({error:'Not Found'},404); }
  } catch(e) { console.error('[Error]',path,e.message); _statsErrInc({path, message:e.message}); json({error:e.message},500); }
});

// ===== Start =====
const todayStr = () => localDate();

// ===== WebSocket =====
let wss = null;
function wsBroadcast(type, data) {
  if (!wss) return;
  const msg = JSON.stringify({ type, ...data, time: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

(async () => {
  await db.connect();
  // Initialize default shift config if none exists
  const existingShifts = await db.getShiftConfigs();
  if (!existingShifts.length) {
    await db.saveShiftConfig({
      name: '默认班次', line_name: null,
      shifts: [{name:'早班',start:'08:00',end:'17:30'},{name:'晚班',start:'20:00',end:'05:30'}],
      breaks: [{name:'午休',start:'12:00',end:'13:00',shift:'早班'},{name:'茶歇',start:'15:00',end:'15:10',shift:'早班'},{name:'晚餐',start:'00:00',end:'00:40',shift:'晚班'}],
      effective_date: '2026-01-01', is_active: true
    });
    console.log('[DB] 已初始化默认班次配置');
  }
  await mesLogin();
  let syncBusy = false; // 重入锁: 启动 syncData 与 syncAndNotify 共享,防并发跑两个 syncData(双倍打 MES/db)
  // listen 前置: 立即监听让 dashboard_manager 探活通过。原 syncData 阻塞致首跑>75s
  // (syncTaskRoutes 22次MES调用+prewarm), 超 manager grace30s+3×15s探活窗口被误杀重启死循环。
  // 现改为 listen 立即起, syncData+prewarm 后台跑, 首跑期 API 返回逐步刷新数据, health 立即可用。
  const onListen = () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : PORT;
    const hostLabel = HOST || 'localhost';
    console.log(`\n  AI生产数字看板 http://${hostLabel}:${actualPort}\n`);
    if (WIP_DESKTOP_MODE) console.log(`  WIP桌面模式 http://127.0.0.1:${actualPort}/wip.html\n`);
  };
  // listen 失败(如 EADDRINUSE: 管理器/托盘重启时旧实例未退导致端口占用)→ 干净退出,
  // 让 dashboard_manager 守护重拉; 否则 uncaughtException 仅日志不退, 留下不监听的僵尸进程(占内存不服务)。
  server.on('error', (e) => {
    console.error('[Server] listen error:', e.code, e.message);
    if (e.code === 'EADDRINUSE' || e.code === 'EACCES') process.exit(1);
  });
  if (HOST) server.listen(PORT, HOST, onListen);
  else server.listen(PORT, onListen);
  wss = new WebSocket.Server({ server });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'connected', time: new Date().toISOString() }));
    ws.on('error', () => {});
  });
  console.log('[WS] WebSocket服务已启动');
  // 启动同步 + 预热后台跑,不阻塞 listen(原 await 阻塞致首跑>75s 被 manager 误杀)
  syncBusy = true; // 占用锁,防 30s 后 syncAndNotify 并发跑第二个 syncData
  syncData(todayStr()).then(async () => {
    wsBroadcast('dashboard-update', {});
    console.log('[Prewarm] 启动预热开始...');
    const _pw0 = Date.now();
    await prewarmCaches().catch(e => console.error('[Prewarm] 启动预热失败:', e.message));
    console.log(`[Prewarm] 启动预热完成, 耗时 ${Date.now()-_pw0}ms, 热缓存已就绪`);
  }).catch(e => console.error('[Sync] 启动同步失败:', e.message)).finally(() => { syncBusy = false; });

  // Sync with broadcast (syncBusy 已在 listen 前定义, 供启动 syncData 与 syncAndNotify 共享)
  // 重入锁: syncData 含 puppeteer 重登录+分页拉取, 单次常>30s, 防重叠争抢 MES cookie/重复 bulkWrite
  const syncAndNotify = async () => {
    if (syncBusy) return;
    syncBusy = true;
    try { await syncData(todayStr()); wsBroadcast('dashboard-update', {}); prewarmCaches().catch(e=>console.error('[prewarm]',e.message)); }
    finally { syncBusy = false; }
  };
  setInterval(() => syncAndNotify().catch(console.error), 30*1000);
  // 12-KPI Phase1: 快照源(工单/WIP/报废/出库)5分钟周期，减轻30s周期与MES session压力
  setInterval(() => syncSnapshotSources().catch(console.error), 5*60*1000);
  setTimeout(() => syncSnapshotSources().catch(console.error), 60*1000); // 启动后1分钟先跑一次
  // Broadcast announcement update after each sync
  setInterval(async () => { try { wsBroadcast('announcement-update', {}); } catch(e){} }, 60*1000);

  // ===== 每日快照 =====
  async function saveDailySnapshot() {
    const date = todayStr();
    try {
      const wipData = await computeWIP(date, date, '');

      // 12-KPI Phase1: 质量域 + 交付域(交付域先算, 计划达成率复用其 ai_mo_orders 全量口径)
      let qualityData = null, deliveryData = null;
      try { qualityData = await computeQuality(date, date, ''); } catch(e){ console.log('[Snapshot] quality失败:', e.message?.substring(0,60)); }
      try { deliveryData = await computeDelivery(date, date, ''); } catch(e){ console.log('[Snapshot] delivery失败:', e.message?.substring(0,60)); }
      // 计划达成率统一用 ai_mo_orders 全量口径(与 /api/delivery/detail 的 plan_rate_mo 一致), 弃用 ai_task_orders 截断200 口径, 避免双口径数字打架
      const totalQty = deliveryData?.plan_total_qty ?? 0;
      const completedQty = deliveryData?.plan_completed_qty ?? 0;
      const planRate = deliveryData?.plan_rate ?? 0;

      const snapshot = {
        date,
        wip_count: wipData.wip_count,
        completed_count: wipData.completed_count,
        total_sns: wipData.total_sns,
        mfg_cycle_hours: wipData.mfg_cycle_hours,
        avg_wip_wait_hours: wipData.avg_wip_wait_hours,
        plan_rate: planRate,
        plan_total_qty: totalQty,
        plan_completed_qty: completedQty,
        bottleneck: wipData.by_operation.length > 0 ? wipData.by_operation.reduce((a, b) => a.count > b.count ? a : b) : null,
        by_operation: wipData.by_operation,
        // 12-KPI Phase1 新增
        rework_rate: qualityData?.rework_rate ?? null,
        fpy: qualityData?.fpy ?? null,
        plan_rate_mo: deliveryData?.plan_rate ?? null,
        wip_cycle_hours: deliveryData?.wip_cycle_hours ?? null,
        saved_at: new Date().toISOString()
      };

      await db.col.daily_snapshot.replaceOne({ date }, snapshot, { upsert: true });
      console.log('[Snapshot] 保存每日快照:', date);
    } catch (e) {
      console.error('[Snapshot] 快照失败:', e.message);
    }
  }
  // 启动后立即存一次，之后每小时更新一次当天快照
  setTimeout(() => saveDailySnapshot().catch(console.error), 15000);
  setInterval(() => saveDailySnapshot().catch(console.error), 3600 * 1000);

  // 历史回补：启动后5分钟执行一次，之后每2小时回补一次
  // [纠正 2026-06-26] 早前误判 Backfill 崩溃实则 EADDRINUSE(外部node占8080)打断: 退出码全=1(EADDRINUSE),
  // Backfill 16次启动7次完成(被打断9次非自崩), 完成时含06-19~06-21均成功。根因是端口冲突非Backfill,
  // 已由 manager 孤儿清理机制治本。恢复 Backfill(7)。性能问题(7天~6min, repairReport每天52s)待后续优化。
  setTimeout(() => syncHistoryBackfill(7).catch(console.error), 5*60*1000);
  setInterval(() => syncHistoryBackfill(3).catch(console.error), 2*3600*1000);

  // ===== 企业微信日报推送 =====
  globalThis._pushDailyReport = pushDailyReport;
  async function pushDailyReport() {
    const webhookUrl = process.env.WECHAT_WEBHOOK;
    if (!webhookUrl) return;
    const date = todayStr();
    try {
      const data = await computeDashboard(date, date);
      if (data.upph.total_output === 0) return;
      const level = data.fpy.value >= 95 && data.oee.oee >= 80 ? '✅' : data.ppm.value >= 2000 || data.oee.oee < 60 ? '🚨' : '⚠️';
      const lines = data.line_summary.slice(0, 5).map(l => `  ${lineNameMap[l.code]||l.code}: ${l.output}`).join('\n');
      const topBad = data.repair_top.slice(0, 3).map(r => `${r.name}(${r.count})`).join('、');
      const content = `${level} AI生产日报 ${date}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📦 产量: ${data.upph.total_output}\n` +
        `✅ 直通率: ${data.fpy.value}%\n` +
        `⚙️ OEE: ${data.oee.oee}%\n` +
        `🔍 PPM: ${data.ppm.value}\n` +
        `⚠️ 不良: ${data.fpy.total_ng}件\n` +
        `🔧 误测率: ${data.mistest_rate.value}%\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📊 产线产量:\n${lines}\n` +
        (topBad ? `\n🔴 TOP不良: ${topBad}\n` : '') +
        `\n📱 详情: ${process.env.PUBLIC_URL || 'http://localhost:'+PORT}/portal.html`;
      const body = JSON.stringify({msgtype:'text', text:{content}});
      await new Promise((resolve, reject) => {
        const u = new URL(webhookUrl);
        const req = https.request({hostname:u.hostname,port:443,path:u.pathname+u.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},agent:httpsAgent}, res => {
          let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
        });
        req.on('error', reject);
        req.write(body); req.end();
      });
      console.log('[WeChat] 日报推送成功:', date);
    } catch(e) { console.error('[WeChat] 推送失败:', e.message); }
  }

  // Also broadcast alert when anomaly detected during sync
  async function checkAndAlert() {
    const date = todayStr();
    try {
      const data = await computeDashboard(date, date);
      if (data.upph.total_output === 0) return;
      if (data.ppm.value >= 2000) wsBroadcast('alert', {message:`PPM ${data.ppm.value} 超过阈值2000，请关注品质`});
      if (data.oee.oee > 0 && data.oee.oee < 60) wsBroadcast('alert', {message:`OEE ${data.oee.oee}% 低于60%，请检查设备`});
      if (data.fpy.value > 0 && data.fpy.value < 90) wsBroadcast('alert', {message:`直通率 ${data.fpy.value}% 异常偏低`});
    } catch(e) {}
  }

  // Schedule daily push at 18:00
  function scheduleDailyPush() {
    const now = new Date();
    const target = new Date(now); target.setHours(18, 0, 0, 0);
    if (now > target) target.setDate(target.getDate() + 1);
    const delay = target - now;
    setTimeout(() => {
      pushDailyReport().catch(console.error);
      setInterval(() => pushDailyReport().catch(console.error), 24 * 3600 * 1000);
    }, delay);
    console.log('[WeChat] 日报推送定时:', target.toISOString());
  }
  if (process.env.WECHAT_WEBHOOK) scheduleDailyPush();

  // Check alerts every 5 minutes
  setInterval(() => checkAndAlert().catch(console.error), 5 * 60 * 1000);
})();

function shutdown(signal) {
  console.log(`[Server] 收到 ${signal}，正在关闭...`);
  if (wss) {
    try { wss.close(); } catch(e) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// 兜底: 未捕获的 async rejection / 异常仅记日志, 避免静默崩溃或 Node 默认退出行为拖垮长驻服务
process.on('unhandledRejection', (reason) => { console.error('[UnhandledRejection]', reason); _statsErrInc({message: 'UnhandledRejection: ' + (reason && reason.message || reason)}); });
process.on('uncaughtException', (err) => { console.error('[UncaughtException]', (err && err.stack) || err); _statsErrInc({message: 'UncaughtException: ' + (err && err.message || err)}); });
