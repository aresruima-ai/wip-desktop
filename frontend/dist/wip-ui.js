/**
 * WipUI —— 从 wip.html 提取的可复用交互逻辑共享库
 * ---------------------------------------------------------------
 * 设计目的：把 WIP 页(wip.html)沉淀出的交互范式(Drawer 抽屉 / Subnav 锚点 /
 * UpdateBar 周期切换 / Focus 关注面板辅助 / periodRange 日期换算)
 * 封装为纯逻辑共享库，供其它 7 个看板页(dashboard/oee/bad/line-balance/
 * line-monitor/kanban/ai-center/health)统一套用。
 *
 * 依赖：
 *   - 纯 JS，无第三方依赖，与 common.js / nav.js / filter-bar.js 共存
 *   - 暗色无关：纯逻辑，配合 common.css 的 WIP 组件类(.drawer / .drawer-mask /
 *     .drawer-stats / .drawer-stat / .wip-subnav / .update-bar / .sparkline-wrap 等)
 *
 * Drawer DOM 约定（页面需提供，结构由 common.css 的 .drawer 样式保证）：
 *   #drawer          抽屉容器(含 .show 切换显隐)
 *   #drawerMask      遮罩(含 .show 切换显隐)
 *   #drawerTitle     标题
 *   #drawerStats     顶部统计网格容器(填 .drawer-stat)
 *   #drawerContent   主体内容容器
 *   #drawerExport    导出按钮(可选；无则库自动注入)
 *
 * 各页只需提供 stats 数组 + 内容 html + 导出数据，无需重写抽屉 DOM/CSS。
 * ---------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // ---------- 工具：日期格式化 YYYY-MM-DD ----------
  function fmtDate(dt) {
    var y = dt.getFullYear();
    var m = ('' + (dt.getMonth() + 1)).padStart(2, '0');
    var d = ('' + dt.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  // 简单 HTML 转义（用于 chip/label 等可能含用户数据的地方）
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ========== 1. periodRange 周期→日期范围换算 ==========
  /**
   * 将周期标识换算为 {dateFrom, dateTo} 日期范围(YYYY-MM-DD)。
   * 额外返回 label/prevFrom/prevTo 便于环比计算与时间条展示。
   *
   * @param {string} period 周期标识：realtime|week|month|quarter|half|year|all
   * @returns {{dateFrom:string,dateTo:string,label:string,prevFrom:string|null,prevTo:string|null}|null}
   *   - realtime: 今天 ~ 今天（实时）
   *   - week:     本周一 ~ 今天
   *   - month:    本月1日 ~ 今天
   *   - quarter:  本季度首月1日 ~ 今天
   *   - half:     上半年(01-01)/下半年(07-01) ~ 今天
   *   - year:     本年1月1日 ~ 今天
   *   - all:      2024-01-01 ~ 今天（近365天累计口径，无环比）
   *   未知 period 返回 null
   */
  // ========== 工单聚合工具(消除各页重复 reduce/planRate 计算) ==========
  /** 求工单列表的完工数之和(兼容 completed / completedQty 两种字段名) */
  function sumCompleted(orders) {
    if (!orders || !orders.length) return 0;
    return orders.reduce(function (s, o) { return s + (o.completed || o.completedQty || 0); }, 0);
  }
  /** 计划达成率 = 完工/计划*100,返回保留1位小数的字符串或 '--' */
  function calcOrderRate(orders, totalQty) {
    var completed = sumCompleted(orders);
    var total = totalQty != null ? totalQty : (orders || []).reduce(function (s, o) { return s + (o.qty || 0); }, 0);
    return total > 0 ? (completed / total * 100).toFixed(1) : '--';
  }

  function periodRange(period, customRange) {
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    var today = fmtDate(now);
    var prevFrom = null, prevTo = null, label = '';

    switch (period) {
      case 'realtime':
        return { dateFrom: today, dateTo: today, label: '实时', prevFrom: null, prevTo: null };

      case 'week': {
        var dow = now.getDay() || 7; // 周日=7
        var mon = new Date(now);
        mon.setDate(d - dow + 1);
        var prevMon = new Date(mon.getTime() - 7 * 86400000);
        var prevSun = new Date(mon.getTime() - 86400000);
        return {
          dateFrom: fmtDate(mon), dateTo: today, label: '本周',
          prevFrom: fmtDate(prevMon), prevTo: fmtDate(prevSun)
        };
      }

      case 'month': {
        var mStr = ('' + (m + 1)).padStart(2, '0');
        var prevM = m === 0 ? 11 : m - 1;
        var prevY = m === 0 ? y - 1 : y;
        return {
          dateFrom: y + '-' + mStr + '-01', dateTo: today, label: '本月',
          prevFrom: prevY + '-' + ('' + (prevM + 1)).padStart(2, '0') + '-01',
          prevTo: y + '-' + mStr + '-01'
        };
      }

      case 'quarter': {
        var qs = Math.floor(m / 3) * 3; // 季度起始月(0-based)
        var qStart = y + '-' + ('' + (qs + 1)).padStart(2, '0') + '-01';
        // 上季度
        var prevQs = qs - 3;
        var prevY = y;
        if (prevQs < 0) { prevQs = 9; prevY = y - 1; }
        return {
          dateFrom: qStart, dateTo: today, label: '本季',
          prevFrom: prevY + '-' + ('' + (prevQs + 1)).padStart(2, '0') + '-01',
          prevTo: qStart
        };
      }

      case 'half': {
        // 上半年: 01-01 ; 下半年: 07-01
        var isH1 = m < 6;
        return {
          dateFrom: (isH1 ? y : y) + '-' + (isH1 ? '01' : '07') + '-01',
          dateTo: today, label: '半年',
          prevFrom: (isH1 ? y - 1 : y) + '-' + (isH1 ? '07' : '01') + '-01',
          prevTo: (isH1 ? y : y) + '-' + (isH1 ? '01' : '07') + '-01'
        };
      }

      case 'year':
        return {
          dateFrom: y + '-01-01', dateTo: today, label: '年度',
          prevFrom: (y - 1) + '-01-01', prevTo: (y - 1) + '-12-31'
        };

      case 'all':
        // 累计：固定起点 2024-01-01，无环比口径
        return {
          dateFrom: '2024-01-01', dateTo: today, label: '累计',
          prevFrom: null, prevTo: null
        };

      case 'custom': {
        // 自定义日期范围; 环比按所选天数往前平移。未传 customRange 时从 localStorage 兜底(各页 periodRange(period) 调用)
        var c = customRange;
        if (!c) { try { c = JSON.parse(localStorage.getItem('_wipui_custom_range')); } catch (e) {} }
        if (!c || !c.dateFrom || !c.dateTo) return null;
        var cf = new Date(c.dateFrom + 'T00:00:00');
        var ct = new Date(c.dateTo + 'T00:00:00');
        var cdays = Math.round((ct - cf) / 86400000);
        var cpf = new Date(cf.getTime() - (cdays + 1) * 86400000);
        var cpt = new Date(cf.getTime() - 86400000);
        return {
          dateFrom: c.dateFrom, dateTo: c.dateTo, label: c.label || '自定义',
          prevFrom: fmtDate(cpf), prevTo: fmtDate(cpt)
        };
      }

      default:
        return null;
    }
  }

  // ========== 2. Drawer 抽屉交互 ==========
  /**
   * Drawer —— 通用详情抽屉。各页只需提供 stats + html + 导出数据，
   * 不必重写抽屉 DOM/CSS（抽屉 DOM 结构由页面提供，见文件头注释）。
   *
   * open(opts)   打开抽屉并填充
   *   opts.title    {string}           抽屉标题
   *   opts.stats    {Array<{val,lbl}>} 顶部统计网格(3列)；空数组则隐藏统计区
   *   opts.html     {string}           主体内容 HTML
   *   opts.exportData {Array<Object>}  导出 CSV 的原始行数据(可选)
   *   opts.exportColumns {Array<{key,label}>} CSV 列定义(可选；与 exportData 配合)
   *   opts.onExport {Function}         自定义导出回调(可选；优先于 exportData/CSV)
   *   opts.showExport {boolean}        是否显示导出按钮，默认 true
   * close()      关闭抽屉
   * exportCSV()  内置 CSV 导出(供 onExport 缺省时调用)
   */
  var Drawer = (function () {
    var state = {
      exportData: null,
      exportColumns: null,
      onExport: null,
      onItem: null,
      title: ''
    };

    function el(id) { return document.getElementById(id); }

    function ensureExportBtn() {
      // 若页面未提供 #drawerExport，则注入一个（注入到 drawer-header 内）
      var btn = el('drawerExport');
      if (btn) return btn;
      var header = el('drawer') && el('drawer').querySelector('.drawer-header');
      if (!header) return null;
      btn = document.createElement('button');
      btn.id = 'drawerExport';
      btn.className = 'refresh-btn';
      btn.style.cssText = 'font-size:11px;padding:4px 10px';
      btn.innerHTML = '&#x2B07; 导出';
      btn.addEventListener('click', exportCSV);
      // 插到 close 按钮之前
      var closeBtn = header.querySelector('.drawer-close');
      if (closeBtn) header.insertBefore(btn, closeBtn);
      else header.appendChild(btn);
      return btn;
    }

    function renderStats(stats) {
      var box = el('drawerStats');
      if (!box) return;
      if (!stats || !stats.length) { box.innerHTML = ''; return; }
      box.innerHTML = stats.map(function (s) {
        return '<div class="drawer-stat"><div class="val">' + esc(s.val) + '</div>' +
          '<div class="lbl">' + esc(s.lbl) + '</div></div>';
      }).join('');
    }

    function open(opts) {
      opts = opts || {};
      var drawer = el('drawer');
      var mask = el('drawerMask');
      if (!drawer || !mask) {
        console.error('[WipUI.Drawer] 页面缺少 #drawer 或 #drawerMask 元素');
        return;
      }

      // 标题
      state.title = opts.title || '--';
      if (el('drawerTitle')) el('drawerTitle').textContent = state.title;

      // 统计网格
      renderStats(opts.stats);

      // 主体内容
      if (el('drawerContent')) {
        el('drawerContent').innerHTML = opts.html || '';
      }

      // 导出按钮
      var showExport = opts.showExport !== false;
      var btn = ensureExportBtn();
      if (btn) btn.style.display = showExport ? '' : 'none';

      // 记录导出上下文
      state.exportData = opts.exportData || null;
      state.exportColumns = opts.exportColumns || null;
      state.onExport = typeof opts.onExport === 'function' ? opts.onExport : null;
      state.onItem = typeof opts.onItem === 'function' ? opts.onItem : null;

      drawer.classList.add('show');
      mask.classList.add('show');
      drawer.scrollTop = 0;
    }

    function close() {
      var drawer = el('drawer');
      var mask = el('drawerMask');
      if (drawer) drawer.classList.remove('show');
      if (mask) mask.classList.remove('show');
    }

    function exportCSV() {
      // 自定义导出优先
      if (state.onExport) { state.onExport(); return; }
      var data = state.exportData;
      if (!data || !data.length) return;

      // 列定义：优先用 exportColumns，否则取首行对象 keys
      var cols = state.exportColumns;
      if (!cols) {
        cols = Object.keys(data[0]).map(function (k) { return { key: k, label: k }; });
      }
      var header = cols.map(function (c) { return csvCell(c.label); }).join(',');
      var rows = data.map(function (row) {
        return cols.map(function (c) { return csvCell(row[c.key]); }).join(',');
      });
      // 加 BOM 防止 Excel 中文乱码
      var csv = '﻿' + header + '\n' + rows.join('\n');
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      var safeTitle = (state.title || 'export').split(' ')[0];
      a.href = URL.createObjectURL(blob);
      a.download = safeTitle + '_' + fmtDate(new Date()) + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    function csvCell(v) {
      if (v == null) return '';
      var s = String(v);
      if (/[",\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    // 点击遮罩关闭（仅绑定一次）
    function bindMask() {
      var mask = el('drawerMask');
      if (mask && !mask.__wipuiBound) {
        mask.addEventListener('click', close);
        mask.__wipuiBound = true;
      }
    }

    // 抽屉内条目点击委托(L3 触发通道):[data-drill-item] 携带 JSON,点击/回车 → onItem(item)
    // 仅绑定一次,每次 open 更新 state.onItem 即可
    function bindItemClick() {
      var content = el('drawerContent');
      if (!content || content.__drillBound) return;
      content.__drillBound = true;
      var fire = function (row) {
        if (!state.onItem || !row) return;
        var raw = row.getAttribute('data-drill-item');
        if (!raw) return;
        try { state.onItem(JSON.parse(raw)); } catch (e) { console.error('[Drawer.onItem] parse error', e); }
      };
      content.addEventListener('click', function (e) {
        var row = e.target.closest('[data-drill-item]');
        if (row) fire(row);
      });
      content.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var row = e.target.closest('[data-drill-item]');
        if (!row) return;
        e.preventDefault();
        fire(row);
      });
    }

    return {
      open: function (opts) { bindMask(); bindItemClick(); open(opts); },
      close: close,
      exportCSV: exportCSV
    };
  })();

  // ========== 3. Subnav 锚点滚动 ==========
  /**
   * Subnav —— 顶部子导航锚点滚动。
   *
   * init(containerSelector, anchors)
   *   containerSelector {string}       导航按钮容器选择器(如 '#wipSubnav')
   *   anchors           {Array<{btn,target,active?}>}
   *     btn    {string|Element} 锚点按钮(选择器字符串或元素；若为字符串按 selector 处理)
   *     target {string}         目标面板元素 id(不带 #)
   *     active {boolean}        初始是否高亮(可选)
   * 绑定后点击按钮平滑滚动到目标面板，并切换 .active 高亮。
   */
  var Subnav = (function () {
    function init(containerSelector, anchors) {
      if (!anchors || !anchors.length) return;
      var container = document.querySelector(containerSelector);
      anchors.forEach(function (a) {
        var btns = typeof a.btn === 'string'
          ? document.querySelectorAll(a.btn)
          : [a.btn];
        Array.prototype.forEach.call(btns, function (btn) {
          if (!btn) return;
          btn.addEventListener('click', function () {
            scrollTo(a.target);
            setActive(container, btn);
          });
          if (a.active) btn.classList.add('active');
        });
      });
    }

    function scrollTo(targetId) {
      var node = document.getElementById(targetId);
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function setActive(container, activeBtn) {
      if (!container) return;
      var all = container.querySelectorAll('button');
      all.forEach(function (b) { b.classList.remove('active'); });
      if (activeBtn) activeBtn.classList.add('active');
    }

    return { init: init, scrollTo: scrollTo };
  })();

  // ========== 4. UpdateBar 周期切换 + 刷新 + 时间 + live-dot ==========
  /**
   * UpdateBar —— 顶部状态条：周期 Tab 切换、刷新、时间更新、live-dot。
   *
   * init(opts)
   *   opts.periodTabsSelector {string}   周期 Tab 容器选择器(如 '#periodTabs')
   *   opts.periodAttr         {string}   Tab 上携带周期标识的属性名，默认 'data-period'
   *   opts.onPeriod           {Function} (period, range, tabEl) 周期切换回调
   *   opts.refreshBtnSelector {string}   刷新按钮选择器(如 '#refreshBtn')
   *   opts.onRefresh          {Function} () 刷新回调
   *   opts.timeElSelector     {string}   时间显示元素选择器(如 '#updateTime')
   *   opts.liveDotSelector    {string}   live-dot 元素选择器(如 '#liveDot')，可选
   *   opts.periodOrder        {string[]} 周期顺序，用于校验；默认全部
   *
   * setLive(period)  根据 period 控制 live-dot 显隐(realtime 显示，其余隐藏)
   * setTime(text)    更新时间条文本
   */
  var UpdateBar = (function () {
    var cfg = {};
    var currentPeriod = 'realtime';
    var customRange = null; // 自定义范围 {dateFrom, dateTo}
    var customEls = null;   // {wrap, from, to, apply}

    function init(opts) {
      cfg = opts || {};

      // 周期选择器：支持 <select> 下拉框或旧版 .line-tab 点击切换
      if (cfg.periodTabsSelector) {
        var container = document.querySelector(cfg.periodTabsSelector);
        if (container && container.tagName === 'SELECT') {
          // <select> 下拉框模式
          if (cfg.enableCustomRange) _injectCustom(container);
          container.addEventListener('change', function () {
            var v = container.value;
            if (v === 'custom') {
              _showCustom(true);
              if (customRange) _applyCustom(); // 已有持久化范围则直接应用
              return;
            }
            _showCustom(false);
            switchPeriod(null, v);
          });
          // 初始化 active option（默认 realtime）
          if (container.value && container.value !== 'custom') {
            currentPeriod = container.value;
            setLive(currentPeriod);
          }
        } else {
          // 旧版 Tab 模式（兼容）
          var tabs = document.querySelectorAll(cfg.periodTabsSelector + ' [data-period],' +
            cfg.periodTabsSelector + ' .line-tab,' + cfg.periodTabsSelector + ' button');
          Array.prototype.forEach.call(tabs, function (tab) {
            tab.addEventListener('click', function () {
              var period = tab.getAttribute('data-period');
              if (!period) {
                var m = (tab.getAttribute('onclick') || '').match(/['"]([a-z]+)['"]/);
                period = m ? m[1] : null;
              }
              if (!period) return;
              switchPeriod(tab, period);
            });
          });
        }
      }

      // 刷新按钮
      if (cfg.refreshBtnSelector) {
        var rbtn = document.querySelector(cfg.refreshBtnSelector);
        if (rbtn) rbtn.addEventListener('click', function () {
          if (typeof cfg.onRefresh === 'function') cfg.onRefresh(currentPeriod);
        });
      }

      // 默认 live-dot 显示(实时模式)
      setLive('realtime');
    }

    function switchPeriod(tabEl, period) {
      currentPeriod = period;
      // 切换高亮：移除同容器内兄弟 active，给当前加 active
      if (tabEl && tabEl.parentNode) {
        var sibs = tabEl.parentNode.querySelectorAll('.line-tab, button');
        Array.prototype.forEach.call(sibs, function (s) { s.classList.remove('active'); });
        tabEl.classList.add('active');
      }
      setLive(period);
      if (typeof cfg.onPeriod === 'function') {
        var range = (period === 'custom') ? periodRange('custom', customRange) : periodRange(period);
        if (range) cfg.onPeriod(period, range, tabEl);
      }
    }

    function setLive(period) {
      if (!cfg.liveDotSelector) return;
      var dot = document.querySelector(cfg.liveDotSelector);
      if (dot) dot.style.display = (period === 'realtime') ? '' : 'none';
    }

    function setTime(text) {
      if (!cfg.timeElSelector) return;
      var el = document.querySelector(cfg.timeElSelector);
      if (el) el.textContent = text;
    }

    function getPeriod() { return currentPeriod; }
    function getCustomRange() { return customRange; }

    // 自定义日期范围: 注入 option + 内联 date input 区(无"应用"按钮,date change 自动触发查询)
    function _injectCustom(sel) {
      if (!sel.querySelector('option[value="custom"]')) {
        var opt = document.createElement('option');
        opt.value = 'custom'; opt.textContent = '自定义';
        sel.appendChild(opt);
      }
      var wrap = document.createElement('span');
      wrap.className = 'period-custom';
      wrap.style.display = 'none';
      wrap.innerHTML = '<input type="date" class="cust-from"><span class="cust-sep">~</span><input type="date" class="cust-to">';
      sel.parentNode.insertBefore(wrap, sel.nextSibling);
      var from = wrap.querySelector('.cust-from'), to = wrap.querySelector('.cust-to');
      var saved = _loadCustom();
      if (saved && saved.dateFrom && saved.dateTo) { from.value = saved.dateFrom; to.value = saved.dateTo; customRange = saved; }
      // date change 自动应用(去掉"应用"按钮,选完日期即查询)
      from.addEventListener('change', _applyCustom);
      to.addEventListener('change', _applyCustom);
      customEls = { wrap: wrap, from: from, to: to, apply: null };
    }
    function _showCustom(show) { if (customEls) customEls.wrap.style.display = show ? '' : 'none'; }
    function _applyCustom() {
      if (!customEls) return;
      var f = customEls.from.value, t = customEls.to.value;
      if (!f || !t) return;
      if (f > t) { var tmp = f; f = t; t = tmp; customEls.from.value = f; customEls.to.value = t; }
      customRange = { dateFrom: f, dateTo: t };
      _saveCustom(customRange);
      switchPeriod(null, 'custom');
    }
    function _saveCustom(r) { try { localStorage.setItem('_wipui_custom_range', JSON.stringify(r)); } catch (e) {} }
    function _loadCustom() { try { return JSON.parse(localStorage.getItem('_wipui_custom_range')); } catch (e) { return null; } }

    return { init: init, setLive: setLive, setTime: setTime, getPeriod: getPeriod, getCustomRange: getCustomRange };
  })();

  // ========== 5. Focus 关注面板渲染辅助 ==========
  /**
   * Focus —— 关注面板(Command Panel)的通用渲染辅助函数。
   * 不绑定 DOM，只产出 HTML 片段或状态判定，由各页自行注入。
   *
   * severity(count, opts?)
   *   count             {number}        堆积/数值
   *   opts.danger       {number=200}    danger 阈值
   *   opts.warn         {number=100}    warn 阈值
   *   返回 'danger' | 'warn' | 'normal'
   *
   * metaChips(arr)
   *   arr [{val,label}]  返回 chips HTML（使用 .focus-chip 类）
   *
   * trustLabel(parts)
   *   parts [string]   返回 trust HTML（使用 .focus-trust span 类）
   *
   * sideMiniState(value, opts?)
   *   value            {number}
   *   opts.warnAt      {number}         达到/超过则 warn
   *   opts.dangerAt    {number}         达到/超过则 danger
   *   返回 '' | 'warn' | 'danger'（用于给 .focus-mini 加类名）
   */
  var Focus = (function () {
    function severity(count, opts) {
      opts = opts || {};
      var danger = opts.danger != null ? opts.danger : 200;
      var warn = opts.warn != null ? opts.warn : 100;
      if (count > danger) return 'danger';
      if (count > warn) return 'warn';
      return 'normal';
    }

    function metaChips(arr) {
      if (!arr || !arr.length) return '';
      return arr.map(function (c) {
        return '<span class="focus-chip"><strong>' + esc(c.val) + '</strong>' +
          esc(c.label) + '</span>';
      }).join('');
    }

    function trustLabel(parts) {
      if (!parts || !parts.length) return '';
      return parts.map(function (p) {
        return '<span>' + esc(p) + '</span>';
      }).join('');
    }

    function sideMiniState(value, opts) {
      opts = opts || {};
      if (value == null) return '';
      if (opts.dangerAt != null && value >= opts.dangerAt) return 'danger';
      if (opts.warnAt != null && value >= opts.warnAt) return 'warn';
      return '';
    }

    return {
      severity: severity,
      metaChips: metaChips,
      trustLabel: trustLabel,
      sideMiniState: sideMiniState
    };
  })();

  // ========== 7. 注入新组件所需 CSS(运行时一次性注入) ==========
  /**
   * 注入 .quick-query-bar / .qq-btn / .toolbar / .tb-btn / .wipui-toast
   * 等组件类(暗色，使用 common.css 变量)。仅注入一次。
   * 若 common.css 已提供同名类，会被这里的规则覆盖；可按需删除冲突项。
   */
  var __cssInjected = false;
  function injectComponentCSS() {
    if (__cssInjected) return;
    if (!global.document) return;
    var style = document.createElement('style');
    style.id = 'wipui-extra-css';
    style.textContent = [
      /* ---- QuickQuery 快捷查询栏 ---- */
      '.quick-query-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 2px;}',
      '.qq-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;',
      'border:1px solid var(--border);background:rgba(15,23,42,0.6);color:var(--text-secondary);',
      'font-size:12px;cursor:pointer;transition:all .15s;font-family:inherit;}',
      '.qq-btn:hover{border-color:var(--brand);color:var(--brand);background:rgba(14,165,233,0.06);}',
      '.qq-btn.active{border-color:var(--brand);background:rgba(14,165,233,0.14);color:var(--brand);',
      'box-shadow:0 0 0 2px rgba(14,165,233,0.08);}',
      '.qq-btn .qq-icon{font-size:13px;line-height:1;opacity:.9;}',
      /* ---- Toolbar 功能键条 ---- */
      '.toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 2px;}',
      '.tb-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;',
      'width:30px;height:30px;border-radius:8px;border:1px solid var(--border);',
      'background:rgba(15,23,42,0.6);color:var(--text-secondary);font-size:15px;cursor:pointer;',
      'transition:all .15s;font-family:inherit;}',
      '.tb-btn:hover{border-color:var(--brand);color:var(--brand);background:rgba(14,165,233,0.08);}',
      '.tb-btn:active{transform:translateY(1px);}',
      '.tb-btn[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);',
      'left:50%;transform:translateX(-50%);white-space:nowrap;padding:4px 8px;border-radius:6px;',
      'background:rgba(2,6,23,0.95);border:1px solid var(--border);color:var(--text-primary);',
      'font-size:11px;z-index:60;pointer-events:none;}',
      /* ---- Toast ---- */
      '.wipui-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);z-index:9999;',
      'padding:8px 16px;border-radius:8px;background:rgba(2,6,23,0.95);border:1px solid var(--brand);',
      'color:var(--text-primary);font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,0.5);}',
      /* ---- 大屏模式(各页可按需补充) ---- */
      'body.bigscreen-mode{font-size:120%;}',
      'body.bigscreen-mode .toolbar,body.bigscreen-mode .quick-query-bar{display:none;}'
    ].join('');
    document.head.appendChild(style);
    __cssInjected = true;
  }

  // 简单 Toast（不依赖其它组件）
  function toast(msg) {
    if (!global.document) return;
    var t = document.createElement('div');
    t.className = 'wipui-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 1800);
  }

  // ========== 8. QuickQuery 快捷查询栏 ==========
  /**
   * QuickQuery —— 快捷查询栏(一键常用查询)。
   *
   * init(containerSelector, items, opts)
   *   containerSelector {string}                  容器选择器(如 '#quickQuery')
   *   items             {Array<{
   *     key:string, label:string, icon?:string,
   *     apply:() => (boolean|void)
   *   }>}
   *     key    唯一键(用于 activeKey 比对)
   *     label  按钮文案
   *     icon   图标(emoji/unicode 字符)
   *     apply  点击回调：设筛选/状态；返回 false 阻止后续 onAfter
   *   opts {
   *     onAfter?:  (item) => void   apply 成功后回调(通常 loadData + 滚 focus)
   *     activeKey?: string          初始高亮按钮 key
   *   }
   *
   * 返回 { setActive, getActive }
   *
   * 示例：
   *   WipUI.QuickQuery.init('#qq', [
   *     {key:'all', label:'全部', icon:'⌧', apply:()=>{filter.line='';}},
   *     {key:'warn', label:'异常', icon:'⚠', apply:()=>{filter.status='warn';}}
   *   ], { onAfter:()=>loadData() });
   */
  var QuickQuery = (function () {
    var state = { active: null, items: [], onAfter: null };

    function init(containerSelector, items, opts) {
      opts = opts || {};
      state.items = items || [];
      state.onAfter = typeof opts.onAfter === 'function' ? opts.onAfter : null;
      state.active = opts.activeKey || null;
      injectComponentCSS();

      var container = document.querySelector(containerSelector);
      if (!container) { console.error('[WipUI.QuickQuery] 容器不存在:', containerSelector); return; }
      container.className = (container.className || '') + ' quick-query-bar';
      render(container);
    }

    function render(container) {
      container.innerHTML = state.items.map(function (it) {
        var cls = 'qq-btn' + (it.key === state.active ? ' active' : '');
        var icon = it.icon ? '<span class="qq-icon">' + esc(it.icon) + '</span>' : '';
        return '<button class="' + cls + '" data-key="' + esc(it.key) + '">' +
          icon + '<span>' + esc(it.label) + '</span></button>';
      }).join('');
      Array.prototype.forEach.call(container.querySelectorAll('.qq-btn'), function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.getAttribute('data-key');
          setActive(key);
          var item = findItem(key);
          if (!item) return;
          var ok = true;
          if (typeof item.apply === 'function') { ok = item.apply() !== false; }
          if (ok && state.onAfter) state.onAfter(item);
        });
      });
    }

    function findItem(key) {
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].key === key) return state.items[i];
      }
      return null;
    }

    function setActive(key) {
      state.active = key;
      var btns = document.querySelectorAll('.quick-query-bar .qq-btn');
      Array.prototype.forEach.call(btns, function (b) {
        b.classList.toggle('active', b.getAttribute('data-key') === key);
      });
    }

    function getActive() { return state.active; }

    return { init: init, setActive: setActive, getActive: getActive };
  })();

  // ========== 9. Toolbar 功能键条 ==========
  /**
   * Toolbar —— 通用功能键条。
   *
   * init(containerSelector, opts)
   *   containerSelector {string}                  容器选择器(如 '#toolbar')
   *   opts {
   *     buttons: string[]        启用的按钮 key，默认全部
   *       可选值: refresh|fullscreen|exportImg|exportCSV|print|share|compare|bigscreen
   *     onRefresh, onExportImg, onExportCSV, onCompare: Function
   *     targetSelector?: string  截图/全屏目标元素选择器(默认 body)
   *   }
   *
   * 内置行为：
   *   refresh     → opts.onRefresh()
   *   fullscreen  → 全屏/退出全屏切换(目标 = targetSelector)
   *   exportImg   → opts.onExportImg() || window.html2canvas(target).then(...)
   *   exportCSV   → opts.onExportCSV()
   *   print       → window.print()
   *   share       → 复制 location.href(含 hash) 到剪贴板 + Toast
   *   compare     → opts.onCompare()
   *   bigscreen   → body 切换 .bigscreen-mode 类
   *
   * 图标: ⟳刷新 / ⛶全屏 / 📷导出图 / ⬇CSV / 🖨打印 / 🔗分享 / ⚖对比 / 🖥大屏
   *
   * 示例：
   *   WipUI.Toolbar.init('#toolbar', {
   *     buttons:['refresh','exportCSV','fullscreen'],
   *     onRefresh:()=>loadData(),
   *     onExportCSV:()=>exportRows(rows)
   *   });
   */
  var Toolbar = (function () {
    var META = {
      refresh:    { icon: '⟳',  tip: '刷新' },
      fullscreen: { icon: '⛶',  tip: '全屏' },
      exportImg:  { icon: '📷', tip: '导出图片' },
      exportCSV:  { icon: '⬇',  tip: '导出CSV' },
      print:      { icon: '🖨', tip: '打印' },
      share:      { icon: '🔗', tip: '分享链接' },
      compare:    { icon: '⚖', tip: '环比对比' },
      bigscreen:  { icon: '🖥', tip: '大屏模式' }
    };

    function init(containerSelector, opts) {
      opts = opts || {};
      injectComponentCSS();
      var container = document.querySelector(containerSelector);
      if (!container) { console.error('[WipUI.Toolbar] 容器不存在:', containerSelector); return; }
      var buttons = opts.buttons && opts.buttons.length ? opts.buttons
        : ['refresh', 'fullscreen', 'exportImg', 'exportCSV', 'print', 'share', 'compare', 'bigscreen'];
      container.className = (container.className || '') + ' toolbar';
      container.innerHTML = buttons.map(function (k) {
        var m = META[k];
        if (!m) return '';
        return '<button class="tb-btn" data-act="' + k + '" data-tip="' + esc(m.tip) + '">' +
          esc(m.icon) + '</button>';
      }).join('');
      Array.prototype.forEach.call(container.querySelectorAll('.tb-btn'), function (btn) {
        btn.addEventListener('click', function () { handleClick(btn.getAttribute('data-act'), opts); });
      });
    }

    function getTarget(opts) {
      var t = opts.targetSelector ? document.querySelector(opts.targetSelector) : null;
      return t || document.body;
    }

    function handleClick(act, opts) {
      switch (act) {
        case 'refresh':
          if (typeof opts.onRefresh === 'function') opts.onRefresh();
          break;
        case 'fullscreen':
          toggleFullscreen(getTarget(opts));
          break;
        case 'exportImg':
          if (typeof opts.onExportImg === 'function') opts.onExportImg();
          else if (typeof global.html2canvas === 'function' && typeof global.captureDashboard === 'function') {
            // 共享件 captureDashboard: 关停 animation + 锁高 + onclone canvas→img,
            // 解决 html2canvas 不捕获 ECharts canvas(横展自 bad.html, 覆盖所有用 Toolbar 导出的页)
            global.captureDashboard(getTarget(opts)).then(function (canvas) {
              global.downloadCanvas(canvas, 'screenshot_' + fmtDate(new Date()) + '.png');
            }).catch(function () { toast('导出失败'); });
          } else if (typeof global.html2canvas === 'function') {
            global.html2canvas(getTarget(opts)).then(function (canvas) {
              var a = document.createElement('a');
              a.href = canvas.toDataURL('image/png');
              a.download = 'screenshot_' + fmtDate(new Date()) + '.png';
              a.click();
            });
          } else toast('未提供 html2canvas 或 onExportImg');
          break;
        case 'exportCSV':
          if (typeof opts.onExportCSV === 'function') opts.onExportCSV();
          else toast('未提供 onExportCSV');
          break;
        case 'print':
          global.print && global.print();
          break;
        case 'share':
          shareLink();
          break;
        case 'compare':
          if (typeof opts.onCompare === 'function') opts.onCompare();
          else toast('未提供 onCompare');
          break;
        case 'bigscreen':
          document.body.classList.toggle('bigscreen-mode');
          toast(document.body.classList.contains('bigscreen-mode') ? '已进入大屏模式' : '已退出大屏模式');
          break;
      }
    }

    function toggleFullscreen(target) {
      if (document.fullscreenElement) {
        document.exitFullscreen && document.exitFullscreen();
      } else if (target && target.requestFullscreen) {
        target.requestFullscreen();
      }
    }

    function shareLink() {
      var url = global.location && global.location.href;
      if (!url) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast('链接已复制到剪贴板'); });
      } else {
        // 兜底
        var ta = document.createElement('textarea');
        ta.value = url; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('链接已复制到剪贴板'); }
        catch (e) { toast('复制失败'); }
        document.body.removeChild(ta);
      }
    }

    return { init: init, toggleFullscreen: toggleFullscreen };
  })();
  // ========== 挂载到全局 ==========
  global.WipUI = {
    Drawer: Drawer,
    Subnav: Subnav,
    UpdateBar: UpdateBar,
    Focus: Focus,
    periodRange: periodRange,
    sumCompleted: sumCompleted,
    calcOrderRate: calcOrderRate,
    QuickQuery: QuickQuery,
    Toolbar: Toolbar
  };

})(typeof window !== 'undefined' ? window : this);
