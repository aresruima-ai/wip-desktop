(function(){
'use strict';
// standalone 模式:URL 带 standalone=1 或 body 有 data-standalone 属性时,
// 隐藏导航菜单/投屏/退出按钮,仅保留 logo+标题+时钟+连接状态(桌面端单页嵌入)
var STANDALONE = /[?&]standalone=1/.test(location.search) || document.body.hasAttribute('data-standalone');
var groups=[
{name:'指挥层',items:[
  {href:'portal.html',label:'经营首页'},
  {href:'cockpit.html',label:'实时驾驶舱'}
]},
{name:'生产运营',items:[
  {href:'oee.html',label:'OEE分析'},
  {href:'wip.html',label:'WIP追踪'},
  {href:'line-balance.html',label:'生产线平衡'},
  {href:'uph.html',label:'UPH产出统计'},
  {href:'kanban.html',label:'生产看板'},
  {href:'factory-3d.html',label:'数字孪生'},
  {href:'bad.html',label:'不良管理'},
  {href:'fixture-life.html',label:'治具与线材'}
]},
{name:'智能支撑',items:[
  {href:'ai-center.html',label:'AI中心'},
  {href:'health.html',label:'运维监控'},
  {href:'settings.html',label:'系统设置'},
  {href:'admin.html',label:'系统管理'}
]}
];

var page=location.pathname.split('/').pop()||'portal.html';

// 反查当前页标题(顶栏显示,替代被删的旧 header 标题)
var pageTitle='';
if(page==='detail.html') pageTitle='数据明细';
for(var gi=0; gi<groups.length && !pageTitle; gi++){
  for(var ii=0; ii<groups[gi].items.length; ii++){
    if(groups[gi].items[ii].href===page){ pageTitle=groups[gi].items[ii].label; break; }
  }
}

function buildNav(){
  // Remove old nav-tabs
  var old=document.querySelector('.nav-tabs');
  if(old)old.remove();

  // Create header nav
  var header=document.createElement('header');
  header.className='mn-header';
  header.innerHTML='<div class="mn-inner"><a href="portal.html" class="mn-logo"><img src="images/logo-sm.png" alt="AI智能工厂" class="mn-logo-img"><span class="mn-logo-text">AI数字看板</span><span class="mn-logo-divider"></span><span class="mn-logo-sub">智能工厂</span></a><span class="mn-page-title" id="mnPageTitle"></span><nav class="mn-nav" id="mnNav"></nav><div class="mn-context" id="mnContext"><span class="mn-ctx-seg mn-ctx-clock" id="mnCtxClock">--:--:--</span><span class="mn-ctx-sep"></span><span class="mn-ctx-seg mn-ctx-pill" id="mnCtxShift" title="当前班次">—</span><span class="mn-ctx-sep"></span><span class="mn-ctx-seg" id="mnCtxUpdate" title="数据最近更新时间">更新于 —</span><span class="mn-ctx-sep"></span><span class="mn-ctx-seg mn-ctx-pill" id="mnCtxLine" title="当前产线">全厂</span></div><div class="mn-right"><span class="mn-conn-dot" id="mnConnDot" title="实时连接状态"><span class="conn-ping"></span></span><div id="mnPersona" class="persona-slot" aria-label="角色视角"></div><a href="scroll-board.html" class="mn-cast-btn" id="mnCastBtn" title="投屏大屏(滚动看板)">投屏</a><button class="mn-logout-btn" id="mnLogoutBtn" title="退出登录">退出</button><button class="mn-mob-btn" id="mnMobBtn"><span></span><span></span><span></span></button></div></div>';

  var titleEl=header.querySelector('#mnPageTitle');
  if(titleEl && pageTitle) titleEl.textContent=pageTitle;

  var nav=header.querySelector('#mnNav');

  // standalone:隐藏投屏/退出/移动端按钮,跳过菜单填充(仅保留 logo+标题+时钟+连接状态)
  if(STANDALONE){
    header.querySelectorAll('.mn-cast-btn,.mn-logout-btn,.mn-mob-btn').forEach(function(b){ b.style.display='none'; });
  } else {
  groups.forEach(function(g){
    var li=document.createElement('div');
    li.className='mn-item';

    // Check if current page is in this group
    var isActive=g.items.some(function(it){return it.href===page;});

    var a=document.createElement('a');
    a.href='javascript:void(0)';
    a.className='mn-link'+(isActive?' active':'');
    a.textContent=g.name;
    // #3 键盘/触屏可达:role+tabindex+aria,点击切换(原仅 hover,触屏≥900px 不可用)
    a.setAttribute('role','button');
    a.setAttribute('tabindex','0');
    a.setAttribute('aria-haspopup','true');
    a.setAttribute('aria-expanded','false');
    a.setAttribute('aria-label',g.name+' 菜单');
    li.appendChild(a);

    // Dropdown panel
    var drop=document.createElement('div');
    drop.className='mn-drop';
    var dropInner=document.createElement('div');
    dropInner.className='mn-drop-inner';
    g.items.forEach(function(it){
      var da=document.createElement('a');
      da.href=it.href;
      da.className='mn-drop-link'+(it.href===page?' active':'');
      da.textContent=it.label;
      dropInner.appendChild(da);
    });
    drop.appendChild(dropInner);
    li.appendChild(drop);
    nav.appendChild(li);

    // #3 点击/键盘切换下拉(hover 仍保留);同时只允许一组展开
    function setOpen(open){
      nav.querySelectorAll('.mn-item.open').forEach(function(sib){
        if(sib!==li){ sib.classList.remove('open'); var t=sib.querySelector('.mn-link'); if(t) t.setAttribute('aria-expanded','false'); }
      });
      if(open){ li.classList.add('open'); a.setAttribute('aria-expanded','true'); }
      else { li.classList.remove('open'); a.setAttribute('aria-expanded','false'); }
    }
    a.addEventListener('click', function(e){ e.preventDefault(); setOpen(!li.classList.contains('open')); });
    a.addEventListener('keydown', function(e){
      if(e.key==='Enter'||e.key===' '||e.key==='Spacebar'){ e.preventDefault(); setOpen(!li.classList.contains('open')); }
      else if(e.key==='Escape'){ setOpen(false); }
    });
    a.addEventListener('mouseenter', function(){
      nav.querySelectorAll('.mn-item.open').forEach(function(sib){ if(sib!==li){ sib.classList.remove('open'); var t=sib.querySelector('.mn-link'); if(t) t.setAttribute('aria-expanded','false'); } });
    });
    li.addEventListener('mouseleave', function(){ if(li.classList.contains('open')) setOpen(false); });
  });
  } /* end if(!STANDALONE) — 菜单填充结束 */

  // #3 全局:点击外部 / Escape 关闭所有下拉
  function closeAllDrops(){
    nav.querySelectorAll('.mn-item.open').forEach(function(sib){
      sib.classList.remove('open');
      var t=sib.querySelector('.mn-link'); if(t) t.setAttribute('aria-expanded','false');
    });
  }
  document.addEventListener('click', function(e){ if(!header.contains(e.target)) closeAllDrops(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeAllDrops(); });

  // Insert at top of body
  document.body.insertBefore(header,document.body.firstChild);

  // Hide old header
  var oldHeader=document.querySelector('header.header');
  if(oldHeader)oldHeader.style.display='none';

  // Mobile nav
  var mobBtn=document.getElementById('mnMobBtn');
  var mobNav=document.createElement('div');
  mobNav.className='mn-mob-nav';
  groups.forEach(function(g){
    var sec=document.createElement('div');
    sec.className='mn-mob-group';
    var title=document.createElement('div');
    title.className='mn-mob-title';
    title.textContent=g.name;
    title.addEventListener('click',function(){sec.classList.toggle('open');});
    sec.appendChild(title);
    var list=document.createElement('div');
    list.className='mn-mob-list';
    g.items.forEach(function(it){
      var a=document.createElement('a');
      a.href=it.href;
      a.className='mn-mob-link'+(it.href===page?' active':'');
      a.textContent=it.label;
      list.appendChild(a);
    });
    sec.appendChild(list);
    mobNav.appendChild(sec);
  });
  header.appendChild(mobNav);

  var overlay=document.createElement('div');
  overlay.className='mn-overlay';
  document.body.appendChild(overlay);

  mobBtn.addEventListener('click',function(){
    header.classList.toggle('mob-open');
    overlay.classList.toggle('active');
  });
  overlay.addEventListener('click',function(){
    header.classList.remove('mob-open');
    overlay.classList.remove('active');
  });

  // U2: 投屏入口(顶栏常驻直达 scroll-board); scroll-board 自身不显示
  var castBtn=document.getElementById('mnCastBtn');
  if(castBtn && page==='scroll-board.html') castBtn.style.display='none';

  // 退出登录(U1: 加二次确认, 防大屏误触掉线)
  var logoutBtn=document.getElementById('mnLogoutBtn');
  if(logoutBtn){
    logoutBtn.addEventListener('click',function(){
      var doExit=function(){ if(window.doLogout){window.doLogout();return;} fetch('/api/logout',{method:'POST'}).finally(function(){window.location.href='/login.html';}); };
      if(window.Confirm){ window.Confirm('退出登录','确认退出当前账号?大屏将掉线并返回登录页。',{okText:'退出',danger:true}).then(function(ok){ if(ok) doExit(); }); }
      else doExit();
    });
  }

  // 角色菜单(master-ui.js 已加载则直接挂, 否则由其 mountAuto 兜底)
  var personaSlot=document.getElementById('mnPersona');
  if(personaSlot && window.MasterUI && window.MasterUI.Persona && !document.querySelector('.persona-trigger')){
    window.MasterUI.Persona.mount(personaSlot);
  }

  // Detect fullscreen pages (factory-3d, etc.) - use overlay nav instead of pushing content
  var isFullscreen=document.querySelector('.page-wrap')&&getComputedStyle(document.body).overflow==='hidden';
  if(isFullscreen){
    header.classList.add('mn-overlay-mode');
  }else{
    document.body.style.paddingTop='48px';
  }

  // ===== 连接状态指示器 =====
  var connDot=document.getElementById('mnConnDot');
  var connIdleTimer=null;
  function setConnState(state) {
    if (!connDot) return;
    connDot.className='mn-conn-dot conn-'+state;
    // 离开 connecting 初始态后取消 idle 兜底(live/dead/reconn 均代表已有真实信号)
    if (state!=='connecting' && connIdleTimer) { clearTimeout(connIdleTimer); connIdleTimer=null; }
  }
  // 加载默认 connecting(不再假绿);由 common.js createReconnectingWS 或 EventBus ws:* 事件驱动真实态
  setConnState('connecting');
  window._setConnState=setConnState;
  // 兜底:6s 内未确认 live(本页无 WS)则视为无实时连接(idle,灰,不脉动)
  connIdleTimer=setTimeout(function(){ setConnState('idle'); }, 6000);
  // 监听连接状态(common.js createReconnectingWS 直接调 _setConnState;EventBus 兜底)
  if (window.EventBus) {
    window.EventBus.on('ws:connected', function() { setConnState('live'); });
    window.EventBus.on('ws:disconnected', function() { setConnState('dead'); });
    window.EventBus.on('ws:reconnecting', function() { setConnState('reconn'); });
  }

  // ===== 顶栏实时上下文条(时钟 / 班次 / 更新于 / 产线) =====
  var ctxClock=document.getElementById('mnCtxClock');
  var ctxShift=document.getElementById('mnCtxShift');
  var ctxUpdate=document.getElementById('mnCtxUpdate');
  var ctxLine=document.getElementById('mnCtxLine');
  var clockTimer=null;

  function pad2(n){ return (n<10?'0':'')+n; }
  function fmtClock(d){ return pad2(d.getHours())+':'+pad2(d.getMinutes())+':'+pad2(d.getSeconds()); }
  function tickClock(){ if(ctxClock) ctxClock.textContent=fmtClock(new Date()); }
  function startClock(){ tickClock(); if(!clockTimer) clockTimer=setInterval(tickClock,1000); }
  function stopClock(){ if(clockTimer){ clearInterval(clockTimer); clockTimer=null; } }
  startClock();
  document.addEventListener('visibilitychange', function(){ if(document.hidden) stopClock(); else startClock(); });

  // 更新于:监听 WS 数据到达(common.js createReconnectingWS onmessage 发 ws:data;裸 WS 页不发,显示 —)
  if(window.EventBus){
    window.EventBus.on('ws:data', function(){
      if(!ctxUpdate) return;
      ctxUpdate.textContent='更新于 '+fmtClock(new Date());
    });
  }

  // 当前产线:读全局筛选态(sessionStorage _dashboard_filters),/api/lines 映射为显示名
  var lineMap={};
  function readLine(){
    try{
      var f=window.FilterState?window.FilterState.load():{};
      var id=f&&(f.lineDisplay||f.lineName||f.lineId);
      if(!id) return '全厂';
      return lineMap[id]||id;
    }catch(e){ return '全厂'; }
  }
  function refreshLine(){ if(ctxLine) ctxLine.textContent=readLine(); }
  refreshLine();
  if(window.EventBus) window.EventBus.on('filter:changed', refreshLine);
  setInterval(refreshLine, 5000); // 兜底轮询(filter-bar 未发 filter:changed 时仍能反映)
  fetch('/api/lines').then(function(r){return r.json();}).then(function(r){
    (r&&r.items||[]).forEach(function(l){ lineMap[l.id||l.code]=l.name||l.line_display||l.id||l.code; });
    refreshLine();
  }).catch(function(){});

  // 当前班次:取 /api/shift-config 全局配置(line_name=null),按 now() 比对,处理跨天班次
  var shiftConfigs=null;
  function parseHM(hm){ if(!hm||hm.indexOf(':')<0) return null; var p=hm.split(':'); return parseInt(p[0],10)*60+parseInt(p[1],10); }
  function computeShift(){
    if(!shiftConfigs||!shiftConfigs.length||!ctxShift) return;
    var cfg=shiftConfigs.find(function(c){return !c.line_name;})||shiftConfigs[0];
    var ln=readLine();
    if(ln&&ln!=='全厂'){
      var per=shiftConfigs.find(function(c){return c.line_name&&(c.line_name===ln||(c.line_display||'')===ln);});
      if(per) cfg=per;
    }
    var shifts=cfg&&cfg.shifts;
    if(!shifts||!shifts.length){ ctxShift.style.display='none'; return; }
    ctxShift.style.display='';
    var now=new Date(), mins=now.getHours()*60+now.getMinutes(), hit='—';
    for(var i=0;i<shifts.length;i++){
      var s=shifts[i], sp=parseHM(s.start), ep=parseHM(s.end);
      if(sp==null||ep==null) continue;
      var inShift = sp<=ep ? (mins>=sp&&mins<ep) : (mins>=sp||mins<ep); // end<=start 视为跨天
      if(inShift){ hit=s.name||('班'+(i+1)); break; }
    }
    ctxShift.textContent=hit;
  }
  fetch('/api/shift-config').then(function(r){return r.json();}).then(function(r){
    shiftConfigs=(r&&r.items)||[];
    computeShift();
  }).catch(function(){ if(ctxShift) ctxShift.style.display='none'; });
  setInterval(computeShift, 60000); // 每分钟重算(班次切换点)

  // ===== 导航活跃指示器平滑滑动 =====
  var activeLink=header.querySelector('.mn-link.active');
  var activeIndicator=document.createElement('span');
  activeIndicator.className='mn-active-indicator';
  if (activeLink) {
    var ar=activeLink.getBoundingClientRect();
    var hr=header.getBoundingClientRect();
    activeIndicator.style.cssText='position:absolute;bottom:0;height:2px;background:var(--brand);border-radius:1px;transition:left .35s var(--ease-expo,ease),width .35s var(--ease-expo,ease);left:'+(ar.left-hr.left)+'px;width:'+ar.width+'px;z-index:1;pointer-events:none';
    nav.appendChild(activeIndicator);
  }
  // Hover 时指示器跟随
  nav.querySelectorAll('.mn-link').forEach(function(lk) {
    lk.addEventListener('mouseenter', function() {
      var r=lk.getBoundingClientRect();
      var hr2=header.getBoundingClientRect();
      activeIndicator.style.left=(r.left-hr2.left)+'px';
      activeIndicator.style.width=r.width+'px';
      activeIndicator.style.opacity='0.5';
    });
    lk.addEventListener('mouseleave', function() {
      if (activeLink) {
        var ar2=activeLink.getBoundingClientRect();
        var hr3=header.getBoundingClientRect();
        activeIndicator.style.left=(ar2.left-hr3.left)+'px';
        activeIndicator.style.width=ar2.width+'px';
      }
      activeIndicator.style.opacity='1';
    });
  });
  // 窗口 resize 时重算
  window.addEventListener('resize', function() {
    if (!activeLink) return;
    setTimeout(function() {
      var ar3=activeLink.getBoundingClientRect();
      var hr4=header.getBoundingClientRect();
      activeIndicator.style.left=(ar3.left-hr4.left)+'px';
      activeIndicator.style.width=ar3.width+'px';
    }, 100);
  });

  // ===== #6 Ctrl/Cmd+K 命令面板(13 页模糊跳转) =====
  if(!STANDALONE){ // standalone 单页模式禁用命令面板(仅 wip 页,禁止跨页跳转)
  var allItems=[];
  groups.forEach(function(g){ g.items.forEach(function(it){ allItems.push({label:it.label, href:it.href, group:g.name}); }); });

  var pal=document.createElement('div');
  pal.className='mn-palette';
  pal.setAttribute('role','dialog');
  pal.setAttribute('aria-label','页面跳转');
  pal.innerHTML='<div class="mn-pal-box"><input class="mn-pal-input" placeholder="跳转到页面…  输入页名,↑↓ 选择,回车打开" autocomplete="off" aria-label="搜索页面"><div class="mn-pal-list"></div><div class="mn-pal-hint">Esc 关闭 · Ctrl/Cmd+K 唤起</div></div>';
  document.body.appendChild(pal);
  var palInput=pal.querySelector('.mn-pal-input');
  var palList=pal.querySelector('.mn-pal-list');
  var palIdx=0, palMatches=[];

  function renderPal(q){
    q=(q||'').trim().toLowerCase();
    palMatches = q ? allItems.filter(function(it){ return it.label.toLowerCase().indexOf(q)>=0 || it.group.toLowerCase().indexOf(q)>=0; }) : allItems.slice();
    palIdx=0;
    if(!palMatches.length){ palList.innerHTML='<div class="mn-pal-empty">无匹配页面</div>'; return; }
    palList.innerHTML=palMatches.slice(0,12).map(function(it,i){
      return '<a href="'+it.href+'" class="mn-pal-item'+(i===0?' sel':'')+'" data-idx="'+i+'"><span class="mn-pal-label">'+it.label+'</span><span class="mn-pal-group">'+it.group+'</span></a>';
    }).join('');
  }
  function moveSel(d){
    var n=palMatches.length; if(!n) return;
    palIdx=(palIdx+d+n)%n;
    var items=palList.querySelectorAll('.mn-pal-item');
    items.forEach(function(el,i){ el.classList.toggle('sel', i===palIdx); });
    if(items[palIdx]) items[palIdx].scrollIntoView({block:'nearest'});
  }
  function openPal(){ pal.classList.add('open'); renderPal(''); setTimeout(function(){ palInput.focus(); },30); }
  function closePal(){ pal.classList.remove('open'); palInput.value=''; }
  palInput.addEventListener('input', function(){ renderPal(palInput.value); });
  palInput.addEventListener('keydown', function(e){
    if(e.key==='ArrowDown'){ e.preventDefault(); moveSel(1); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); moveSel(-1); }
    else if(e.key==='Enter'){ e.preventDefault(); var m=palMatches[palIdx]; if(m) window.location.href=m.href; }
    else if(e.key==='Escape'){ e.preventDefault(); closePal(); }
  });
  palList.addEventListener('click', function(e){ var it=e.target.closest('.mn-pal-item'); if(it){ window.location.href=it.getAttribute('href'); } });
  pal.addEventListener('click', function(e){ if(e.target===pal) closePal(); });
  document.addEventListener('keydown', function(e){
    if((e.ctrlKey||e.metaKey) && (e.key==='k'||e.key==='K')){ e.preventDefault(); pal.classList.contains('open')?closePal():openPal(); }
  });
  } /* end if(!STANDALONE) — 命令面板 */
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',buildNav);
else buildNav();
})();
