/**
 * common.js — 共享工具库
 * 提供: Toast通知, 主题持久化, WebSocket重连, 导航Active, 筛选器持久化, 确认对话框, BroadcastChannel
 */
(function() {
'use strict';

// ═══════════════════════════════════════════════════════════════
// Toast 通知系统
// ═══════════════════════════════════════════════════════════════
let _toastContainer = null;
function _getToastContainer() {
    if (!_toastContainer) {
        _toastContainer = document.createElement('div');
        _toastContainer.className = 'toast-container';
        document.body.appendChild(_toastContainer);
    }
    return _toastContainer;
}

window.Toast = {
    show(message, type = 'info', duration = 3000) {
        const container = _getToastContainer();
        const el = document.createElement('div');
        el.className = `toast-item toast-${type}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.classList.add('toast-out');
            el.addEventListener('animationend', () => el.remove());
        }, duration);
        return el;
    },
    success(msg, dur) { return this.show(msg, 'success', dur); },
    error(msg, dur) { return this.show(msg, 'error', dur || 4000); },
    info(msg, dur) { return this.show(msg, 'info', dur); },
    warning(msg, dur) { return this.show(msg, 'warning', dur); }
};

// ═══════════════════════════════════════════════════════════════
// 确认对话框
// ═══════════════════════════════════════════════════════════════
window.Confirm = function(title, message, options = {}) {
    return new Promise((resolve) => {
        const esc = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); // 防 XSS: title/message/cancelText/okText 可能来自后端数据
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay show';
        overlay.innerHTML = `
            <div class="confirm-box">
                <h4>${esc(title)}</h4>
                <p>${esc(message)}</p>
                <div class="confirm-actions">
                    <button class="btn btn-cancel">${esc(options.cancelText || '取消')}</button>
                    <button class="btn ${options.danger ? 'btn-danger' : 'btn-primary'} btn-ok">${esc(options.okText || '确定')}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        let onKey;
        const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
        onKey = (e) => { if (e.key === 'Escape') close(false); }; // U8: ESC 视为取消
        overlay.querySelector('.btn-cancel').onclick = () => close(false);
        overlay.querySelector('.btn-ok').onclick = () => close(true);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        document.addEventListener('keydown', onKey);
    });
};

// ═══════════════════════════════════════════════════════════════
// 主题持久化
// ═══════════════════════════════════════════════════════════════
(function initTheme() {
    function apply() {
        if (!document.body) { document.addEventListener('DOMContentLoaded', apply); return; }
        // 默认暗色：仅当用户显式保存过 'light' 才切亮色，不跟随系统 prefers-color-scheme
        const saved = localStorage.getItem('theme');
        if (saved === 'light') {
            document.body.classList.add('light');
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.body.classList.remove('light');
            document.documentElement.removeAttribute('data-theme');
        }
    }
    apply();
})();

// ═══════════════════════════════════════════════════════════════
// WebSocket 自动重连（带指数退避）
// ═══════════════════════════════════════════════════════════════
window.createReconnectingWS = function(url, options = {}) {
    let ws = null;
    let retryDelay = 1000;
    const maxDelay = 30000;
    const onMessage = options.onMessage || (() => {});
    const onOpen = options.onOpen || (() => {});
    const onClose = options.onClose || (() => {});
    let destroyed = false;

    function connect() {
        if (destroyed) return;
        try { ws = new WebSocket(url); } catch(e) { scheduleRetry(); return; }
        ws.onopen = () => { retryDelay = 1000; onOpen(ws); updateIndicator(true); };
        ws.onmessage = (e) => { onMessage(e, ws); if (window.EventBus) EventBus.emit('ws:data', { time: Date.now() }); };
        ws.onclose = () => { onClose(ws); updateIndicator(false); scheduleRetry(); };
        ws.onerror = () => {};
    }

    function scheduleRetry() {
        if (destroyed) return;
        if (window.EventBus) EventBus.emit('ws:reconnecting', { url: url });
        if (window._setConnState) window._setConnState('reconn');
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
    }

    function updateIndicator(connected) {
        const dot = document.getElementById('connDot');
        if (dot) {
            dot.style.background = connected ? 'var(--success)' : 'var(--danger)';
        }
        // 全站联动: 发射连接状态事件
        if (window.EventBus) {
            EventBus.emit(connected ? 'ws:connected' : 'ws:disconnected', { url: url });
        }
        if (window._setConnState) {
            window._setConnState(connected ? 'live' : 'dead');
        }
    }

    connect();
    return {
        send(data) { if (ws && ws.readyState === 1) ws.send(data); },
        close() { destroyed = true; if (ws) ws.close(); },
        get ws() { return ws; }
    };
};

// ═══════════════════════════════════════════════════════════════
// 筛选器状态持久化（sessionStorage）
// ═══════════════════════════════════════════════════════════════
const FILTER_KEY = '_dashboard_filters';

window.FilterState = {
    save(filters) {
        try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch(e) {}
    },
    load() {
        try { return JSON.parse(sessionStorage.getItem(FILTER_KEY)) || {}; } catch(e) { return {}; }
    },
    clear() { sessionStorage.removeItem(FILTER_KEY); }
};

// ═══════════════════════════════════════════════════════════════
// BroadcastChannel 数据更新通知
// ═══════════════════════════════════════════════════════════════
window.DataChannel = (function() {
    let ch = null;
    try { ch = new BroadcastChannel('data-update'); } catch(e) {}
    return {
        notify(type) { if (ch) ch.postMessage({ type, time: Date.now() }); },
        onUpdate(callback) { if (ch) ch.onmessage = (e) => callback(e.data); }
    };
})();

// ═══════════════════════════════════════════════════════════════
// Favicon（内联SVG）
// ═══════════════════════════════════════════════════════════════
(function initFavicon() {
    if (document.querySelector('link[rel="icon"]')) return;
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="%23010510"/><path d="M6 22 L16 8 L26 22 Z" fill="none" stroke="%230ea5e9" stroke-width="2.5" stroke-linejoin="round"/><circle cx="16" cy="18" r="3" fill="%230ea5e9"/></svg>';
    document.head.appendChild(link);
})();

// ═══════════════════════════════════════════════════════════════
// 统一退出登录
// ═══════════════════════════════════════════════════════════════
window.doLogout = function() {
    fetch('/api/logout', { method: 'POST' }).finally(function() {
        localStorage.removeItem('token');
        window.location.href = '/login.html';
    });
};

// ═══════════════════════════════════════════════════════════════
// 通用工具函数
// ═══════════════════════════════════════════════════════════════
window.escHtml = function(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
};
// esc = escHtml 别名(历史习惯: 部分页用 esc, 部分用 escHtml, 统一收口)
window.esc = function(s) { return window.escHtml(s == null ? '' : s); };
// localDate: Date → 'YYYY-MM-DD'(全站各页原本各自复制一份, 收口到 common; dt 缺省 now)
window.localDate = function(dt) {
    dt = dt || new Date();
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
};

// ═══════════════════════════════════════════════════════════════
// NotificationBell 通知铃铛系统
// ═══════════════════════════════════════════════════════════════
window.NotificationBell = (function() {
    const STORAGE_KEY = '_notif_bell';
    const MAX = 50;
    let _container = null, _badge = null, _dropdown = null, _open = false;

    function _getNotifs() {
        try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || []; } catch(e) { return []; }
    }
    function _saveNotifs(list) {
        try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX))); } catch(e) {}
    }

    function _injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
.notif-bell-wrap{position:fixed;top:14px;right:20px;z-index:10000;font-family:inherit;}
.notif-bell-btn{background:var(--surface-2);border:1px solid var(--line);border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;position:relative;transition:border-color .2s;}
.notif-bell-btn:hover{border-color:var(--brand);}
.notif-bell-badge{position:absolute;top:-2px;right:-2px;background:var(--danger);color:var(--surface-0);font-size:10px;font-weight:700;border-radius:50%;min-width:16px;height:16px;display:none;align-items:center;justify-content:center;padding:0 3px;}
.notif-bell-badge.show{display:flex;}
.notif-dropdown{position:absolute;top:42px;right:0;width:320px;max-height:400px;overflow-y:auto;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.4);display:none;flex-direction:column;}
.notif-dropdown.open{display:flex;}
.notif-dropdown-header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);font-size:12px;color:var(--text-muted);}
.notif-dropdown-header button{background:none;border:none;color:var(--brand);cursor:pointer;font-size:11px;}
.notif-item{padding:10px 14px;border-bottom:1px solid rgba(51,65,85,0.3);font-size:12px;}
.notif-item:last-child{border-bottom:none;}
.notif-item .notif-title{font-weight:600;color:var(--text-primary);margin-bottom:2px;}
.notif-item .notif-body{color:var(--text-muted);}
.notif-item .notif-time{color:var(--text-muted);font-size:10px;margin-top:3px;}
.notif-item.type-alert .notif-title{color:var(--danger);}
.notif-item.type-escalation .notif-title{color:var(--warning);}
.notif-empty{padding:20px;text-align:center;font-size:12px;color:var(--text-muted);}
`;
        document.head.appendChild(style);
    }

    function _render() {
        const notifs = _getNotifs();
        _badge.textContent = notifs.length;
        _badge.classList.toggle('show', notifs.length > 0);
        _dropdown.innerHTML = '<div class="notif-dropdown-header"><span>通知 (' + notifs.length + ')</span><button onclick="NotificationBell.clear()">清空</button></div>';
        if (!notifs.length) {
            _dropdown.innerHTML += '<div class="notif-empty">暂无通知</div>';
            return;
        }
        notifs.forEach(function(n) {
            _dropdown.innerHTML += '<div class="notif-item type-' + (n.type||'info') + '"><div class="notif-title">' + (n.title||'') + '</div><div class="notif-body">' + (n.body||'') + '</div><div class="notif-time">' + (n.time||'') + '</div></div>';
        });
    }

    function _init() {
        if (location.pathname.includes('login')) return;
        _injectCSS();
        _container = document.createElement('div');
        _container.className = 'notif-bell-wrap';
        _container.innerHTML = '<div class="notif-bell-btn"><span>🔔</span><span class="notif-bell-badge"></span></div><div class="notif-dropdown"></div>';
        document.body.appendChild(_container);
        _badge = _container.querySelector('.notif-bell-badge');
        _dropdown = _container.querySelector('.notif-dropdown');
        _container.querySelector('.notif-bell-btn').addEventListener('click', function(e) {
            e.stopPropagation();
            _open = !_open;
            _dropdown.classList.toggle('open', _open);
            if (_open) _render();
        });
        document.addEventListener('click', function() { _open = false; _dropdown.classList.remove('open'); });
        _render();
    }

    document.addEventListener('DOMContentLoaded', _init);

    return {
        add: function(title, body, type) {
            var notifs = _getNotifs();
            notifs.unshift({ title: title, body: body, type: type || 'info', time: new Date().toLocaleString() });
            _saveNotifs(notifs);
            if (_badge) _render();
        },
        clear: function() {
            sessionStorage.removeItem(STORAGE_KEY);
            if (_badge) _render();
        }
    };
})();


// ═══════════════════════════════════════════════════════════════
// 桌面通知告警系统
// ═══════════════════════════════════════════════════════════════
window.DesktopAlert = (function() {
    var permission = ('Notification' in window) ? Notification.permission : 'denied';
    function requestPermission() {
        if (!('Notification' in window)) return;
        if (permission === 'default') {
            Notification.requestPermission().then(function(p) { permission = p; });
        }
    }
    function notify(title, body, opts) {
        if (permission !== 'granted') { requestPermission(); return; }
        try {
            var n = new Notification(title, {
                body: body,
                icon: '/images/favicon.svg',
                tag: (opts && opts.tag) || 'ai-alert',
                requireInteraction: (opts && opts.persist) || false
            });
            n.onclick = function() {
                window.focus();
                if (opts && opts.url) window.location.href = opts.url;
                n.close();
            };
            setTimeout(function() { n.close(); }, (opts && opts.duration) || 10000);
        } catch(e) {}
    }
    document.addEventListener('click', function once() {
        requestPermission();
        document.removeEventListener('click', once);
    });
    return { notify: notify, requestPermission: requestPermission };
})();

// ═══════════════════════════════════════════════════════════════
// 投屏大屏:已统一为 scroll-board.html 滚动看板
// 旧 CarouselMode 切页轮播已移除 — 其 autoResume 会在所有页面刷新时
// 恢复轮播(sessionStorage._carousel_active),造成"刷新就跳投屏"副作用。
// 清残留 key,避免旧浏览器 sessionStorage 残留触发。
// ═══════════════════════════════════════════════════════════════
try{sessionStorage.removeItem('_carousel_active');sessionStorage.removeItem('_carousel_pages');sessionStorage.removeItem('_carousel_interval');}catch(e){}

/* ===== 全局ECharts自适应(布满父容器) ===== */
(function() {
'use strict';
var rt;
function ra() {
  if (typeof echarts === 'undefined') return;
  try {
    var cs = document.querySelectorAll('.chart-box, .chart-box-sm, .chart-box-lg, [id*="chart"]');
    for (var i = 0; i < cs.length; i++) {
      var inst = echarts.getInstanceByDom(cs[i]);
      if (inst) inst.resize();
    }
  } catch(e) {}
}
window.addEventListener('resize', function() { clearTimeout(rt); rt = setTimeout(ra, 150); });

// ========== 截图导出共享件 (横展自 bad.html exportBadPage) =========
// 解决 html2canvas 不捕获 ECharts canvas 的坑, 三重保障:
// ① 关停 animation — attention-hooks 呼吸光/入场动画会让 canvas 在导出图里空白(bad 实测)
// ② 锁 ECharts 容器高度 — flex/height:100% 容器在 html2canvas 克隆里塌缩为 0(OEE 实测 H:0)
// ③ onclone 用 getDataURL <img> 替换 canvas — 最稳, 兼容 canvas 嵌套深的结构(OEE init dom 是 canvas 祖先, 非 parent)
// 调用方需确保 window.html2canvas 已加载。返回 Promise<HTMLCanvasElement>。
window.captureDashboard = function(target, opts) {
  opts = opts || {};
  target = typeof target === 'string' ? document.querySelector(target) : target;
  if (!target) return Promise.reject(new Error('截图目标不存在'));
  var bg = opts.bg || getComputedStyle(document.documentElement).getPropertyValue('--surface-base').trim() || '#0a0d12';
  var scale = opts.scale || 2;
  // 1. 收集 ECharts 实例(canvas 向上找 init dom, 最多 5 层) + getDataURL + 锁高
  var charts = [];
  var seen = new Set();
  Array.prototype.forEach.call(target.querySelectorAll('canvas'), function(cv) {
    var el = cv, inst = null;
    for (var i = 0; i < 5 && el; i++) {
      try { inst = echarts.getInstanceByDom(el); } catch (e) { inst = null; }
      if (inst) break;
      el = el.parentElement;
    }
    if (!inst || seen.has(el)) return;
    seen.add(el);
    var url = null;
    try { url = inst.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg }); } catch (e) {}
    if (!url) return;
    if (el.offsetHeight > 0) el.style.height = el.offsetHeight + 'px'; // 锁高防克隆塌缩
    el.setAttribute('data-h2c-chart', String(charts.length));
    charts.push({ idx: String(charts.length), dataUrl: url });
  });
  // 2. 关停动画
  var neutral = document.createElement('style');
  neutral.id = '__h2c_neutral';
  neutral.textContent = '*{animation:none!important}';
  document.head.appendChild(neutral);
  // 3. onclone: 隐藏原 canvas, 叠加已加载 dataURL 的 <img>
  function onclone(doc) {
    charts.forEach(function(c) {
      var box = doc.querySelector('[data-h2c-chart="' + c.idx + '"]');
      if (!box) return;
      var cv = box.querySelector('canvas');
      if (cv) cv.style.visibility = 'hidden';
      var im = doc.createElement('img');
      im.src = c.dataUrl;
      im.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
      box.style.position = 'relative';
      box.appendChild(im);
    });
  }
  function cleanup() {
    neutral.remove();
    Array.prototype.forEach.call(target.querySelectorAll('[data-h2c-chart]'), function(el) {
      el.style.height = '';
      el.removeAttribute('data-h2c-chart');
    });
  }
  // 4. html2canvas + 清理
  return html2canvas(target, { backgroundColor: bg, scale: scale, scrollY: -window.scrollY, scrollX: -window.scrollX, onclone: onclone }).then(function(c) {
    cleanup();
    return c;
  }).catch(function(e) {
    cleanup();
    throw e;
  });
};
window.downloadCanvas = function(canvas, filename) {
  var link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
};
window.addEventListener('load', ra);
document.addEventListener('fullscreenchange', function() { setTimeout(ra, 300); });
// 页面卸载释放 ECharts 实例(防 SPA 切页累积内存泄漏; 各页 charts{} 池未自行 dispose)
function _disposeAllCharts() {
  if (typeof echarts === 'undefined') return;
  try {
    document.querySelectorAll('.chart-box, .chart-box-sm, .chart-box-lg, [id*="chart"]').forEach(function(el){
      var inst = echarts.getInstanceByDom(el);
      if (inst) inst.dispose();
    });
  } catch(e) {}
}
window.addEventListener('pagehide', _disposeAllCharts);
window.addEventListener('beforeunload', _disposeAllCharts);
})();

// ═══════════════════════════════════════════════════════════════
// TOKEN — 设计Token JS读取器 (供全站JS使用CSS变量值)
// ═══════════════════════════════════════════════════════════════
window.TOKEN = (function() {
  'use strict';
  var root = document.documentElement;
  var cs = getComputedStyle(root);
  function read(name, fallback) { return (cs.getPropertyValue(name).trim()) || fallback || ''; }
  function refresh() { cs = getComputedStyle(root); }

  var T = {
    brand:    read('--brand', '#0166B1'),
    success:  read('--success', '#10b981'),
    warning:  read('--warning', '#f59e0b'),
    danger:   read('--danger', '#ef4444'),
    info:     read('--info', '#38bdf8'),
    purple:   read('--purple', '#a78bfa'),
    textPrimary: read('--text-primary', '#eceef1'),
    textSecondary: read('--text-secondary', '#8893a3'),
    textMuted: read('--text-muted', '#4d5868'),
    refresh: refresh,
    rateColor: function(v, thresholds) {
      var t = thresholds || { good: 85, warn: 60 };
      return v >= t.good ? T.success : v >= t.warn ? T.warning : T.danger;
    },
    inverseRateColor: function(v, thresholds) {
      var t = thresholds || { good: 1000, warn: 5000 };
      return v <= t.good ? T.success : v <= t.warn ? T.warning : T.danger;
    }
  };
  return T;
})();

})();

// ═══════════════════════════════════════════════════════════════
// apiFetch — 统一 fetch 封装 (进阶版全站迁移入口)
// 401→清token跳login / 501→Toast"未上线" / 5xx→Toast / 网络失败→Toast
// 各页裸 fetch → apiFetch(path, opts)，返回 Promise<json>
// 性能: ① 同URL并发去重(cockpit同URL连发4次→1次网络) ② GET短内存缓存(默认3s, opts._cacheMs可调)
//       ③ 成功响应写入 last-known-good localStorage(供 apiFetch.peek 重载秒开)
// ═══════════════════════════════════════════════════════════════
(function(){
  var _inflight = {};        // path -> Promise (并发去重)
  var _memCache = {};        // path -> {val, at} (短内存缓存)
  var MEM_DEFAULT_MS = 3000; // GET 默认内存缓存 3s (服务端已 15s 缓存, 此处仅防同周期重复)
  function _isGet(opts){ return !opts || (!opts.method || String(opts.method).toUpperCase()==='GET') && !opts.body; }
  function _storeLastKnown(path, val){
    try { localStorage.setItem('lk:'+path, JSON.stringify({val:val, at:Date.now()})); } catch(e){}
  }
  window.apiFetch = function(path, opts) {
    opts = opts || {};
    var useCache = _isGet(opts) && opts._noCache !== true;
    var cacheMs = opts._cacheMs != null ? opts._cacheMs : MEM_DEFAULT_MS;
    // ② 内存缓存命中
    if (useCache) {
      var mc = _memCache[path];
      if (mc && Date.now()-mc.at < cacheMs) return Promise.resolve(mc.val);
    }
    // ① 并发去重
    if (useCache && _inflight[path]) return _inflight[path];
    var p = fetch(path, opts).then(function(r) {
      if (r.status === 401) {
        try { localStorage.removeItem('token'); } catch(e) {}
        if (location.pathname.indexOf('login.html') < 0) location.href = '/login.html';
        throw new Error('未登录');
      }
      if (r.status === 501) {
        if (window.Toast) Toast.info('该功能未上线');
        return r.json().catch(function(){ return { success: false }; });
      }
      if (r.status >= 500 && window.Toast) Toast.error('服务异常(' + r.status + ')');
      return r.json();
    }).then(function(json){
      // ③ 写 last-known-good (仅 success 响应; 排除健康检查等高频小响应可选)
      if (useCache && json && json.success !== false) {
        _memCache[path] = {val:json, at:Date.now()};
        _storeLastKnown(path, json);
      }
      return json;
    }).catch(function(err) {
      if (err && err.message === '未登录') throw err;
      if (window.Toast) Toast.error('网络请求失败');
      throw err;
    }).finally(function(){ if (useCache) delete _inflight[path]; });
    if (useCache) _inflight[path] = p;
    return p;
  };
  // 同步读取 last-known-good (重载秒开用): 有则返回 {val, ageMs}, 无则 null
  window.apiFetch.peek = function(path, maxAgeMs){
    try {
      var raw = localStorage.getItem('lk:'+path);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (maxAgeMs && Date.now()-o.at > maxAgeMs) return null;
      return { val: o.val, ageMs: Date.now()-o.at };
    } catch(e){ return null; }
  };
  // 主动失效某 path 的内存+last-known 缓存 (数据写入后调用)
  window.apiFetch.invalidate = function(path){
    delete _memCache[path];
    try { localStorage.removeItem('lk:'+path); } catch(e){}
  };
})();

// ═══════════════════════════════════════════════════════════════
// withVisibilityGuard — 隐藏标签页轮询节流
// 用法: withVisibilityGuard(setInterval(fn, 60000)) → 标签页隐藏时暂停,
// 可见时立即补一次并恢复。全站轮询替换, 杜绝后台标签页空耗。
// ═══════════════════════════════════════════════════════════════
window.withVisibilityGuard = function(fn, intervalMs, opts){
  opts = opts || {};
  var id = null, lastRun = 0, hiddenPaused = false;
  function run(){ lastRun = Date.now(); try { fn(); } catch(e){ console.error(e); } }
  function start(){ if (id) return; id = setInterval(run, intervalMs); }
  function stop(){ if (id){ clearInterval(id); id = null; } }
  function onVis(){
    if (document.hidden){
      if (!hiddenPaused){ stop(); hiddenPaused = true; }
    } else {
      if (hiddenPaused){
        hiddenPaused = false;
        // 可见时: 若距上次运行已超过间隔, 立即补一次
        if (Date.now()-lastRun >= intervalMs) run();
        start();
      }
    }
  }
  document.addEventListener('visibilitychange', onVis);
  // 首次: 立即跑一次再起定时(除非 opts.noImmediate)
  if (!opts.noImmediate) run();
  start();
  return { stop: stop, start: start, run: run };
};

// ═══════════════════════════════════════════════════════════════
// ATTN — 全站注意力钩子通用 API (Attention Hooks)
// 详见 attention-hooks-spec.md。纯追加模块，不覆盖各页内联实现。
// 各页可逐步迁移到 ATTN.* 以统一去重。复用 common.css 已注入的 token。
// ═══════════════════════════════════════════════════════════════
window.ATTN = (function () {
  'use strict';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };

  // 一次性注入通用钩子 base CSS（用 common.css token，零重排）
  var _cssInjected = false;
  function _injectCSS() {
    if (_cssInjected) return; _cssInjected = true;
    var s = document.createElement('style'); s.id = 'attn-base';
    s.textContent = [
      // 焦点压暗：root.focal-active 时，非焦点兄弟降权
      '.attn-focal-active > *:not([data-focal="true"]):not(.attn-focal-keep){filter:var(--focal-dim);transition:filter .4s var(--ease-expo,ease-out)}',
      '.attn-focal-active > [data-focal="true"]{transform:translateY(-2px);box-shadow:var(--light-depth-1);position:relative;z-index:2}',
      // flash 跳变
      '.attn-flash-up{animation:attn-flash-up .9s var(--ease-expo,ease-out)}',
      '.attn-flash-down{animation:attn-flash-down .9s var(--ease-expo,ease-out)}',
      '.attn-flash-flat{animation:attn-flash-flat .9s var(--ease-expo,ease-out)}',
      '@keyframes attn-flash-up{0%{background-color:transparent}25%{background-color:rgba(16,185,129,.18);box-shadow:0 0 16px rgba(16,185,129,.30)}100%{background-color:transparent}}',
      '@keyframes attn-flash-down{0%{background-color:transparent}25%{background-color:rgba(239,68,68,.18);box-shadow:0 0 16px rgba(239,68,68,.30)}100%{background-color:transparent}}',
      '@keyframes attn-flash-flat{0%{background-color:transparent}25%{background-color:rgba(148,163,184,.16);box-shadow:0 0 12px rgba(148,163,184,.22)}100%{background-color:transparent}}',
      // 级联入场
      '.attn-reveal{opacity:0;transform:translateY(14px);transition:opacity var(--dur-enter,.28s) var(--ease-expo,ease-out),transform var(--dur-enter,.28s) var(--ease-expo,ease-out);will-change:opacity,transform}',
      '.attn-reveal.attn-in{opacity:1;transform:none}',
      // 光标光晕
      '.attn-spotlight{position:relative}',
      '.attn-spotlight::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .28s var(--ease-expo,ease-out);background:radial-gradient(var(--halo-radius,220px) circle at var(--mx,50%) var(--my,50%),rgba(1,102,177,.10),transparent 70%)}',
      '.attn-spotlight:hover::after{opacity:1}',
      // 强调色稀缺降级
      '.attn-accent-muted{filter:saturate(var(--accent-muted-sat,.15));opacity:.7}',
      // reduced-motion 守护
      '@media(prefers-reduced-motion:reduce){.attn-reveal{opacity:1!important;transform:none!important}.attn-flash-up,.attn-flash-down{animation:none!important}.attn-spotlight::after{display:none}.attn-focal-active > *{filter:none!important}}',
      // === 数据三态: 空态 + 骨架屏 (全站统一, 替代各页散落的 .empty-state/.announce-empty/内联) ===
      '.attn-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px 20px;color:var(--text-muted);font-size:var(--fs-sm);text-align:center}',
      '.attn-empty-icon{width:36px;height:36px;opacity:.4}',
      '.attn-empty-msg{max-width:300px;line-height:1.55}',
      '.attn-empty-action{margin-top:2px}',
      '.attn-skeleton{display:flex;flex-direction:column;gap:10px;padding:16px}',
      '.attn-skel-bar{background:linear-gradient(90deg,var(--surface-2) 25%,var(--surface-3) 50%,var(--surface-2) 75%);background-size:200% 100%;animation:attn-skel 1.4s var(--ease-expo,ease-out) infinite;border-radius:var(--radius-xs)}',
      '@keyframes attn-skel{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '@media(prefers-reduced-motion:reduce){.attn-skel-bar{animation:none}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // 数字滚动 easeOutExpo
  function _easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  var _tasks = new WeakMap();
  // opts 支持: { format(v)→string, suffix='', decimals=null, useComma=true, dur=850 }
  function liveNum(el, val, opts) {
    if (!el) return;
    opts = opts || {};
    var fmt = opts.format;
    if (!fmt) {
      var suf = opts.suffix || '', dec = opts.decimals, uc = opts.useComma !== false;
      fmt = function (v) {
        if (v == null || isNaN(v)) return '--';
        var s = dec != null ? Number(v).toFixed(dec) : (Math.round(v * 1e6) / 1e6).toString();
        if (uc) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return s + suf;
      };
    }
    if (REDUCED) { el.textContent = fmt(val); return; }
    var raw = (el.textContent || '').replace(/[^0-9.\-]/g, '');
    var from = parseFloat(raw); if (isNaN(from)) from = 0;
    var to = parseFloat(val); if (isNaN(to)) { el.textContent = fmt(val); return; }
    if (from === to) { el.textContent = fmt(val); return; }
    var prev = _tasks.get(el); if (prev) cancelAnimationFrame(prev);
    var dur = opts.dur || 850, t0 = null;
    var id = raf(function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      el.textContent = fmt(from + (to - from) * _easeOutExpo(p));
      if (p < 1) _tasks.set(el, raf(step)); else _tasks.delete(el);
    });
    _tasks.set(el, id);
  }

  // 跳变高亮：比较 old/new，涨绿跌红
  var _flashDeb = new WeakMap();
  function flash(el, oldVal, newVal) {
    if (!el || REDUCED) return;
    var o = parseFloat((oldVal + '').replace(/[^0-9.\-]/g, ''));
    var n = parseFloat((newVal + '').replace(/[^0-9.\-]/g, ''));
    if (isNaN(o) || isNaN(n)) return;
    var now = Date.now(), last = _flashDeb.get(el) || 0;
    if (now - last < 500) return; _flashDeb.set(el, now);
    var cls = o === n ? 'attn-flash-flat' : (n > o ? 'attn-flash-up' : 'attn-flash-down');
    el.classList.remove('attn-flash-up', 'attn-flash-down', 'attn-flash-flat');
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, 900);
  }

  // 焦点单点高光：root 加 attn-focal-active，CSS 自动压暗兄弟
  function enforceFocal(root) {
    _injectCSS();
    root = root || document;
    var nodes = root.querySelectorAll ? root.querySelectorAll('[data-focal="true"]') : [];
    nodes.forEach(function (f) {
      var shell = f.parentElement; if (!shell || shell.classList.contains('attn-focal-active')) return;
      shell.classList.add('attn-focal-active');
    });
  }

  // 级联入场：IO 监听，进视口按 index 错峰
  function revealCascade(selector, opts) {
    _injectCSS();
    opts = opts || {};
    var step = opts.step || 40, cap = opts.cap || 200;
    var els = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
    if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('attn-in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var idx = parseInt(e.target.getAttribute('data-attn-idx') || '0', 10);
        e.target.style.transitionDelay = Math.min(idx * step, cap) + 'ms';
        e.target.classList.add('attn-in');
        io.unobserve(e.target);
      });
    }, { threshold: opts.threshold || 0.12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (e, i) { e.classList.add('attn-reveal'); e.setAttribute('data-attn-idx', i % 6); io.observe(e); });
  }

  // 光标跟随光晕
  function spotlight(el) {
    _injectCSS();
    if (!el || REDUCED) return;
    if (window.matchMedia && !window.matchMedia('(pointer:fine)').matches) return;
    el.classList.add('attn-spotlight');
    el.addEventListener('mousemove', function (ev) {
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (ev.clientX - r.left) + 'px');
      el.style.setProperty('--my', (ev.clientY - r.top) + 'px');
    }, { passive: true });
  }

  // 强调色 1+1 稀缺调度：danger 全留，warning≤2，success 仅首屏首处
  function accentScarcity(root) {
    root = root || document;
    var warn = Array.prototype.slice.call(root.querySelectorAll('[data-sev="warn"],.sev-warn,.state-warn'));
    var succ = Array.prototype.slice.call(root.querySelectorAll('[data-sev="success"],.sev-success,.state-success'));
    // warning：视口外超 2 个的降级
    warn.forEach(function (el, i) {
      if (i >= 2 && !_inViewport(el)) el.classList.add('attn-accent-muted');
    });
    // success：仅留首屏第一处
    var kept = false;
    succ.forEach(function (el) {
      if (!kept && _inViewport(el)) { kept = true; return; }
      el.classList.add('attn-accent-muted');
    });
  }
  function _inViewport(el) {
    var r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  }

  // 心跳节拍器 + 倒计时环：环走完触发 refresh
  function beatBar(dotEl, refreshFn, interval) {
    if (!dotEl) return;
    interval = interval || 60000;
    var wrap = document.createElement('span'); wrap.className = 'attn-beat-wrap';
    wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;justify-content:center';
    dotEl.parentNode.insertBefore(wrap, dotEl); wrap.appendChild(dotEl);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.style.cssText = 'position:absolute;inset:0;transform:rotate(-90deg)';
    var circ = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circ.setAttribute('cx', '10'); circ.setAttribute('cy', '10'); circ.setAttribute('r', '8');
    circ.setAttribute('fill', 'none'); circ.setAttribute('stroke', 'var(--brand)');
    circ.setAttribute('stroke-width', '1.5'); circ.setAttribute('opacity', '0.5');
    var C = 2 * Math.PI * 8; circ.setAttribute('stroke-dasharray', C); circ.setAttribute('stroke-dashoffset', '0');
    svg.appendChild(circ); wrap.appendChild(svg);
    var t0 = Date.now(), raf2 = null;
    function tick() {
      var p = ((Date.now() - t0) % interval) / interval;
      circ.setAttribute('stroke-dashoffset', C * p);
      if (p >= 0.999) { t0 = Date.now(); if (refreshFn) refreshFn(); if (!REDUCED) _beat(dotEl); }
      raf2 = raf(tick);
    }
    if (!REDUCED) tick(); else if (refreshFn) setInterval(refreshFn, interval);
    return { stop: function () { if (raf2) cancelAnimationFrame(raf2); } };
  }
  function _beat(el) {
    el.animate
      ? el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.4)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(0.34,1.56,0.64,1)' })
      : el.classList.add('attn-beat');
  }

  // 对比阈值校验器：?audit=1 扫描强调元素
  function audit() {
    if (!/[?&]audit=1\b/.test(location.search)) return;
    var targets = document.querySelectorAll('.kpi-value,.focus-title,.kpi-change,[data-focal="true"]');
    var issues = 0;
    targets.forEach(function (el) {
      var cs = getComputedStyle(el), color = cs.color, bg = cs.backgroundColor;
      var lc = _lum(color), lb = _lum(bg);
      var ratio = (Math.max(lc, lb) + 0.05) / (Math.min(lc, lb) + 0.05);
      var ok = ratio >= 4.5;
      if (!ok) { issues++; el.style.outline = '2px solid var(--danger)'; console.warn('[ATTN.audit] 对比不足', el, 'ratio=', ratio.toFixed(2)); }
    });
    console.log('[ATTN.audit] 扫描 ' + targets.length + ' 个强调元素，' + issues + ' 个对比不足 (<4.5:1)');
  }
  function _lum(c) {
    var m = c.match(/\d+(\.\d+)?/g); if (!m) return 0;
    var rgb = m.slice(0, 3).map(function (n) { n = n / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  // 统一自动初始化：页面加载后一行 ATTN.autoInit() 即获得所有基础联动效果
  function autoInit(opts) {
    opts = opts || {};
    _injectCSS();
    // 1. 卡片错峰级联入场
    var revealSel = opts.revealSelector || '.kpi-card, .panel, .chart-panel, .portal-entry, .flow-card, .insight-card, .config-card';
    revealCascade(revealSel, { step: opts.staggerStep || 40, cap: opts.staggerCap || 200 });
    // 2. 焦点卡光标光晕
    var focalEl = document.querySelector(opts.focalSelector || '[data-focal="true"], .focus-card');
    if (focalEl) spotlight(focalEl);
    // 3. 焦点单点高光（压暗兄弟）
    enforceFocal();
    // 4. 强调色稀缺调度（延迟执行，等图表渲染完）
    setTimeout(function () { accentScarcity(); }, opts.scarcityDelay || 1200);
    // 5. 审计模式
    audit();
  }

  // 统一 setKPI：替代 cockpit.html 等页缺失/各页分裂的 setKPI
  // 用法: ATTN.setKPI('kpiOEE', 85.3, '↑2.1%', 'up', 'kpiOEESub', '较昨日 +2.1%')
  //       - valueId: 主值元素id (必填)
  //       - value: 数值或带后缀字符串 (必填)
  //       - changeText/changeDir: 可选，变化徽章
  //       - subId/subText: 可选，副标元素id与文本
  function setKPI(valueId, value, changeText, changeDir, subId, subText) {
    var vEl = document.getElementById(valueId);
    if (vEl) liveNum(vEl, value);
    if (subId) {
      var sEl = document.getElementById(subId);
      if (sEl && subText != null) sEl.innerHTML = subText;
    }
    // 变化徽章: 取紧邻的 .kpi-change 或 同 valueId+'Change' 命名的元素
    if (changeText !== undefined && changeText !== null && changeText !== '') {
      var chEl = document.getElementById(valueId + 'Change') ||
                 (vEl && vEl.parentElement && vEl.parentElement.querySelector('.kpi-change'));
      if (chEl) {
        chEl.textContent = changeText;
        chEl.className = 'kpi-change ' + (changeDir || 'flat');
      }
    }
  }

  // 数据质量徽章渲染:五态 real/estimated/derived/empty/default(进阶版 CR-05)
  // 用法: ATTN.renderDataQuality(el, 'estimated', '今日暂无MES过站数据')
  function renderDataQuality(el, level, message) {
    if (!el) return;
    el.className = 'data-quality-banner source-pill ' + (level || 'real');
    el.style.display = message ? 'flex' : 'none';
    if (message != null) {
      var t = el.querySelector('.dq-text');
      if (!t) { t = document.createElement('span'); t.className = 'dq-text'; el.appendChild(t); }
      t.innerHTML = '<strong>数据状态</strong>' + message;
    }
  }

  // 统一 setFocusState:焦点壳严重度三态统一入口
  // 替代各页分裂的 setFocusState/applySeverity/toggleSeverity(8 套实现归一)
  // 用法: ATTN.setFocusState(focusShellEl, 'danger' | 'warn' | 'normal')
  //   给元素加 sev-danger/sev-warn/sev-normal 类(并清掉 legacy state-* 旧类),驱动 CSS 三态呼吸
  function setFocusState(el, sev) {
    if (!el) return;
    el.classList.remove('sev-danger', 'sev-warn', 'sev-normal',
                        'state-alert', 'state-warn', 'state-normal', 'state-danger', 'state-good');
    if (sev === 'danger' || sev === 'alert') el.classList.add('sev-danger');
    else if (sev === 'warn') el.classList.add('sev-warn');
    else el.classList.add('sev-normal');
    try { accentScarcity(); } catch (e) {}  // 新状态可能改变 warning/success 计数,重算稀缺
  }

  /* === 数据三态工厂: emptyHTML(空态) / skeletonHTML(加载态) ===
     统一全站空态视觉, 替代散落的 .empty-state/.announce-empty/内联。
     用法: el.innerHTML = ATTN.emptyHTML({msg:'暂无过站数据', action:'<button>...</button>'}) */
  var _EMPTY_ICON = '<svg class="attn-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18" opacity=".5"/></svg>';
  function emptyHTML(opts) {
    _injectCSS();
    opts = opts || {};
    var msg = opts.msg || '暂无数据';
    var icon = opts.icon != null ? opts.icon : _EMPTY_ICON;
    var action = opts.action ? '<div class="attn-empty-action">' + opts.action + '</div>' : '';
    return '<div class="attn-empty">' + icon + '<div class="attn-empty-msg">' + msg + '</div>' + action + '</div>';
  }
  function skeletonHTML(opts) {
    _injectCSS();
    opts = opts || {};
    var n = opts.rows || 1;
    var h = opts.height || 14;
    var baseW = opts.width || 90;
    var bars = '';
    for (var i = 0; i < n; i++) {
      bars += '<div class="attn-skel-bar" style="width:' + Math.max(40, baseW - i * 12) + '%;height:' + h + 'px"></div>';
    }
    return '<div class="attn-skeleton">' + bars + '</div>';
  }

  return {
    REDUCED: REDUCED,
    injectCSS: _injectCSS,
    liveNum: liveNum,
    flash: flash,
    enforceFocal: enforceFocal,
    revealCascade: revealCascade,
    spotlight: spotlight,
    accentScarcity: accentScarcity,
    beatBar: beatBar,
    audit: audit,
    setKPI: setKPI,
    setFocusState: setFocusState,
    renderDataQuality: renderDataQuality,
    emptyHTML: emptyHTML,
    skeletonHTML: skeletonHTML,
    autoInit: autoInit
  };
})();

// ═══════════════════════════════════════════════════════════════
// EventBus — 全站事件总线（联动效果核心）
// ═══════════════════════════════════════════════════════════════
window.EventBus = (function() {
  'use strict';
  var listeners = {};

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
    return function off() {
      var idx = listeners[event].indexOf(fn);
      if (idx >= 0) listeners[event].splice(idx, 1);
    };
  }

  function emit(event, data) {
    var fns = listeners[event];
    if (!fns) return;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](data); } catch(e) { console.warn('[EventBus]', event, e); }
    }
    // 同时通过 BroadcastChannel 广播到其他标签页
    if (window.DataChannel && (event.indexOf('kpi:') === 0 || event.indexOf('filter:') === 0 || event.indexOf('page:') === 0)) {
      window.DataChannel.notify(event, data);
    }
  }

  function off(event, fn) {
    var fns = listeners[event];
    if (fns) { var idx = fns.indexOf(fn); if (idx >= 0) fns.splice(idx, 1); }
  }

  return { on: on, emit: emit, off: off };
})();

// ═══════════════════════════════════════════════════════════════
// Enhanced DataChannel — 跨标签页广播通道（增强版）
// ═══════════════════════════════════════════════════════════════
(function enhanceDataChannel() {
  if (!window.DataChannel) return;
  var origNotify = window.DataChannel.notify;
  // 增强 notify：支持传递 data payload
  window.DataChannel.notify = function(type, data) {
    var ch = window.DataChannel._ch;
    if (!ch) {
      try { ch = new BroadcastChannel('data-update'); window.DataChannel._ch = ch; } catch(e) { return; }
    }
    ch.postMessage({ type: type, data: data, time: Date.now() });
  };
  // 增强 onUpdate：路由到 EventBus
  var origOnUpdate = window.DataChannel.onUpdate;
  window.DataChannel.onUpdate(function(msg) {
    if (msg && msg.type && window.EventBus) {
      window.EventBus.emit(msg.type, msg.data);
    }
  });
})();

// ═══════════════════════════════════════════════════════════════
// PageTransition — View Transitions API 页面过渡动画
// 拦截所有同源导航链接，实现平滑交叉淡入淡出
// ═══════════════════════════════════════════════════════════════
window.PageTransition = (function() {
  'use strict';
  var supported = typeof document !== 'undefined' && !!document.startViewTransition;

  function navigateTo(url) {
    if (supported) {
      document.startViewTransition(function() {
        return new Promise(function(resolve) {
          document.documentElement.classList.add('vt-exiting');
          setTimeout(function() {
            window.location.href = url;
            resolve();
          }, 120);
        });
      });
    } else {
      // 降级：CSS class 触发过渡后跳转
      document.documentElement.classList.add('vt-exiting');
      setTimeout(function() { window.location.href = url; }, 150);
    }
  }

  function initLinkInterceptor() {
    document.addEventListener('click', function(e) {
      var a = e.target.closest('a');
      if (!a || !a.href) return;
      var href = a.getAttribute('href');
      if (!href || !/\.html($|\?)/.test(href)) return;
      if (href.startsWith('http') && !href.startsWith(location.origin)) return;
      if (a.hasAttribute('data-no-vt')) return;
      if (a.target === '_blank') return;
      if (a.hasAttribute('download')) return;
      e.preventDefault();
      navigateTo(href);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLinkInterceptor);
  } else {
    initLinkInterceptor();
  }

  // 页面加载后：入场动画
  function onPageReady() {
    document.documentElement.classList.add('vt-entered');
    document.documentElement.classList.remove('vt-exiting');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onPageReady);
  } else {
    onPageReady();
  }

  return { navigateTo: navigateTo, supported: supported };
})();

// ═══════════════════════════════════════════════════════════════
// DrillCtx / PageContext / DrillLink — 3 级下钻框架
// 范式: L1 看板页卡/图表 → 跳专题页; L2 专题页图表 click → 开 Drawer 分组;
//       L3 抽屉分组项 → 跳全屏明细页 detail.html
// 跨页上下文统一序列化 sessionStorage('drill_ctx') + URL query,任一级可读回来源与筛选
// ═══════════════════════════════════════════════════════════════
window.DrillCtx = (function () {
  'use strict';
  var KEY = 'drill_ctx';
  // L2 分组维度枚举
  var DIMS = ['line', 'process', 'defect', 'model', 'operation', 'day', 'hour', 'type', 'level', 'page', 'station', 'category'];
  // L3 明细 source 枚举(对应 detail.html 路由)
  var SOURCES = ['bad-records', 'downtime', 'wip-sn', 'work-orders', 'exceptions', 'insights', 'stations', 'output-sn', 'sn-trace', 'rework'];

  function push(ctx) {
    ctx = ctx || {};
    try { sessionStorage.setItem(KEY, JSON.stringify(ctx)); } catch (e) {}
  }
  function pop() {
    try { var raw = sessionStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function clear() { try { sessionStorage.removeItem(KEY); } catch (e) {} }

  // dimValue 净化(反射型XSS纵深防御,下游 detail.html 已转义)
  // 长度上限200超长截断;字符白名单允许 [中文一-龥 A-Za-z0-9 _ - . / 空格 :],非法字符替换为 _
  function sanitizeDimValue(v) {
    var s = String(v);
    if (s.length > 200) s = s.slice(0, 200);
    return s.replace(/[^一-龥A-Za-z0-9_\-./ :]/g, '_');
  }

  function toQuery(ctx) {
    ctx = ctx || {};
    var p = new URLSearchParams();
    if (ctx.source) p.set('source', ctx.source);
    if (ctx.kpi) p.set('kpi', ctx.kpi);
    if (ctx.chart) p.set('chart', ctx.chart);
    if (ctx.dimension) p.set('dim', ctx.dimension);
    if (ctx.dimValue != null) p.set('dimValue', sanitizeDimValue(ctx.dimValue));
    if (ctx.from) p.set('from', ctx.from);
    if (ctx.level) p.set('level', String(ctx.level));
    if (ctx.label) p.set('label', ctx.label);
    var f = ctx.filter || {};
    if (f.line) p.set('line', f.line);
    if (f.dateFrom) p.set('dateFrom', f.dateFrom);
    if (f.dateTo) p.set('dateTo', f.dateTo);
    if (f.shift) p.set('shift', f.shift);
    if (f.product) p.set('product', f.product);
    if (f.stage) p.set('stage', f.stage);
    if (f.type) p.set('type', f.type);
    if (f.operation) p.set('operation', f.operation);
    return p.toString();
  }
  function fromQuery() {
    var p = new URLSearchParams(location.search);
    var ctx = {};
    var get = function (k) { var v = p.get(k); return v; };
    var s = get('source'); if (s) ctx.source = s;
    var k = get('kpi'); if (k) ctx.kpi = k;
    var c = get('chart'); if (c) ctx.chart = c;
    var d = get('dim'); if (d) ctx.dimension = d;
    var dv = get('dimValue'); if (dv != null) ctx.dimValue = dv;
    var fr = get('from'); if (fr) ctx.from = fr;
    var lb = get('label'); if (lb) ctx.label = lb;
    var lv = get('level'); if (lv) ctx.level = parseInt(lv, 10) || 0;
    var filter = {};
    ['line', 'dateFrom', 'dateTo', 'shift', 'product', 'stage', 'type', 'operation'].forEach(function (k) {
      var v = get(k); if (v) filter[k] = v;
    });
    ctx.filter = filter;
    return ctx;
  }
  return { push: push, pop: pop, clear: clear, toQuery: toQuery, fromQuery: fromQuery, DIMS: DIMS, SOURCES: SOURCES, KEY: KEY };
})();

// PageContext — 目标页统一接收下钻上下文(落地 spec IA-06 未实现的 receive 层)
// 各页 PageContext.receive(function(ctx){ applyDrill(ctx); }); 自动在 DOMReady 触发
window.PageContext = (function () {
  'use strict';
  var handlers = [];
  function receive(handler) { if (typeof handler === 'function') handlers.push(handler); }
  function fire() {
    var ctx = window.DrillCtx ? DrillCtx.fromQuery() : null;
    var sess = window.DrillCtx ? DrillCtx.pop() : null;
    if (sess) {
      ctx = ctx || {};
      if (!ctx.from) ctx.from = sess.from;
      if (!ctx.label) ctx.label = sess.label;
      if (!ctx.filter || !Object.keys(ctx.filter).length) ctx.filter = sess.filter || {};
    }
    if (!ctx || (!ctx.source && !ctx.kpi && !ctx.chart)) return; // 无下钻上下文,不触发
    // 600ms 后高亮 [data-focus] (落地 IA-06)
    setTimeout(function () {
      try {
        var key = ctx.kpi || ctx.chart;
        if (key) {
          var el = document.querySelector('[data-focus="' + key + '"]') || document.getElementById(key);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.style.boxShadow = 'var(--glow-brand, 0 0 0 3px rgba(1,102,177,.5))';
            setTimeout(function () { el.style.boxShadow = ''; }, 2000);
          }
        }
      } catch (e) {}
    }, 600);
    handlers.forEach(function (h) { try { h(ctx); } catch (e) { console.error('[PageContext] handler error', e); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fire);
  else fire();
  return { receive: receive, fire: fire };
})();

// DrillLink — 3 级下钻触发器
window.DrillLink = (function () {
  'use strict';
  var DIM_LABELS = { line: '产线', process: '工艺段', defect: '不良项', model: '型号', operation: '工序', day: '日期', hour: '时段', type: '类型', level: '级别', page: '页面', station: '工位', category: '分类', barcode: '条码' };

  function currentPage() { return location.pathname.split('/').pop() || 'portal.html'; }
  // 取当前页筛选(line/dateFrom/dateTo/shift),供 L1/L2/L3 下钻 ctx.filter 带 filter
  // 优先 window.FilterState(全站统一 sessionStorage 键 _dashboard_filters,uph/oee/line-balance 等 save);
  // 次选 FilterBar 实例持久化(键 _filter_+location.pathname,filter-bar.js _saveState);
  // 兜底 window._currentRange(仅 bad.html 定义)
  function currentFilter() {
    var f = {};
    var src = null;
    try {
      if (window.FilterState && typeof FilterState.load === 'function') {
        var s = FilterState.load();
        if (s && (s.dateFrom || s.lineId || s.lineName || s.lineDisplay || s.shift)) src = s;
      }
    } catch (e) {}
    if (!src) {
      try {
        var raw = sessionStorage.getItem('_filter_' + location.pathname);
        if (raw) { var p = JSON.parse(raw); if (p && (p.dateFrom || p.lineId || p.lineName || p.lineDisplay || p.shift)) src = p; }
      } catch (e) {}
    }
    if (src) {
      if (src.dateFrom) f.dateFrom = src.dateFrom;
      if (src.dateTo) f.dateTo = src.dateTo;
      if (src.shift) f.shift = src.shift;
      var line = src.lineDisplay || src.lineName || src.lineId;
      if (line) f.line = line;
    } else {
      try { if (window._currentRange && _currentRange.dateFrom) { f.dateFrom = _currentRange.dateFrom; f.dateTo = _currentRange.dateTo; } } catch (e) {}
    }
    return f;
  }
  function escSafe(s) {
    if (s == null) return '';
    s = String(s);
    if (typeof window.escHtml === 'function') return window.escHtml(s);
    return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

  // L1: KPI 卡/图表 → 跳专题页(基于 KPILinkage.map)
  function openL1(key, opts) {
    opts = opts || {};
    if (!window.KPILinkage || !KPILinkage.map[key]) { console.warn('[DrillLink.openL1] 未知 kpi key:', key); return; }
    var target = KPILinkage.map[key];
    var filter = opts.filter || currentFilter();
    var label = opts.label || '';
    DrillCtx.push({ level: 1, kpi: key, from: currentPage(), filter: filter, label: label });
    // 兼容旧 _kpi_link_ctx 约定(spec IA-06 历史字段,部分页可能读取)
    try { sessionStorage.setItem('_kpi_link_ctx', JSON.stringify({ from: currentPage(), key: key, label: label, time: Date.now() })); } catch (e) {}
    var q = DrillCtx.toQuery({ kpi: key, from: currentPage(), filter: filter });
    var href = target.href;
    var parts = [];
    if (target.param) parts.push(target.param);
    if (opts.extraParams) parts.push(opts.extraParams);
    if (q) parts.push(q);
    if (parts.length) href += '?' + parts.join('&');
    if (window.EventBus) EventBus.emit('drill:navigate', { level: 1, key: key, href: href });
    if (window.EventBus) EventBus.emit('kpi:navigate', { key: key, target: href });
    PageTransition.navigateTo(href);
  }

  // L2: 图表 click → 开 Drawer 分组视图
  // opts: { chartId, dimension, source, title, stats, groups:[{name,value,sub?,raw?}], filter, onItem, exportData, exportColumns }
  // groups 来自图表 series 或聚合 API;每组一行,点行 → onItem(item) → 默认 openL3
  function openL2(opts) {
    opts = opts || {};
    var groups = opts.groups || [];
    var source = opts.source;
    var dimension = opts.dimension;
    var filter = opts.filter || currentFilter();
    var onItem = typeof opts.onItem === 'function' ? opts.onItem : function (item) {
      if (source) openL3(source, item.name, filter, { dimension: dimension, chart: opts.chartId });
    };
    var rowsHtml = renderGroupRows(groups);
    if (window.WipUI && WipUI.Drawer) {
      WipUI.Drawer.open({
        title: opts.title || '分组明细', stats: opts.stats || [], html: rowsHtml,
        showExport: !!opts.exportData, exportData: opts.exportData || null, exportColumns: opts.exportColumns || null,
        onItem: onItem
      });
    } else { console.warn('[DrillLink.openL2] WipUI.Drawer 未就绪'); }
  }

  function renderGroupRows(groups) {
    if (!groups.length) return '<div style="padding:30px;text-align:center;color:var(--text-muted)">暂无分组数据</div>';
    return '<div class="drill-group-list">' + groups.map(function (g) {
      var data = escAttr(JSON.stringify(g));
      return '<div class="drill-group-row" data-drill-item="' + data + '" role="button" tabindex="0">' +
        '<div class="drill-row-main"><span class="drill-row-name">' + escSafe(g.name || '-') + '</span>' +
        (g.sub ? '<span class="drill-row-sub">' + escSafe(g.sub) + '</span>' : '') + '</div>' +
        '<div class="drill-row-val">' + escSafe(g.value != null ? g.value : '-') + '</div>' +
        '<div class="drill-row-arrow" aria-hidden="true">›</div></div>';
    }).join('') + '</div>';
  }

  // L3: 分组项 → 跳全屏明细页 detail.html
  function openL3(source, dimValue, filter, extra) {
    if (!source) { console.warn('[DrillLink.openL3] 缺 source'); return; }
    filter = filter || currentFilter();
    extra = extra || {};
    var ctx = { level: 3, source: source, dimValue: dimValue, dimension: extra.dimension, chart: extra.chart, from: currentPage(), filter: filter };
    DrillCtx.push(ctx);
    var q = DrillCtx.toQuery(ctx);
    if (window.EventBus) EventBus.emit('drill:navigate', { level: 3, source: source, dimValue: dimValue });
    PageTransition.navigateTo('detail.html' + (q ? '?' + q : ''));
  }

  // 给 ECharts 图表注册 click → openL2(替代各页手写 on('click'))
  // opts: { chartId, dimension, source, title(string|fn), buildGroups(params,chart)->[groups]|null, filter, stats }
  // buildGroups 返回 null 时退化为单点直跳 L3(用 params.name 作 dimValue)
  function bindChart(chart, opts) {
    if (!chart || !opts) return;
    chart.off('click');
    chart.on('click', function (params) {
      try {
        var groups = typeof opts.buildGroups === 'function' ? opts.buildGroups(params, chart) : null;
        if (!groups) {
          // 单点直跳 L3:dimValue 优先 pickDim(可按 dataIndex 取原始未截断值),否则 params.name
          var dimValue = typeof opts.pickDim === 'function' ? opts.pickDim(params, chart) : params.name;
          if (dimValue && opts.source) openL3(opts.source, dimValue, opts.filter || currentFilter(), { dimension: opts.dimension, chart: opts.chartId });
          return;
        }
        var title = typeof opts.title === 'function' ? opts.title(params) : (opts.title || '分组明细');
        openL2({ chartId: opts.chartId, dimension: opts.dimension, source: opts.source, title: title, groups: groups, stats: opts.stats, filter: opts.filter || currentFilter(), exportData: groups, onItem: opts.onItem });
      } catch (e) { console.error('[DrillLink.bindChart] click error', e); }
    });
    if (chart.getDom) chart.getDom().style.cursor = 'pointer';
  }

  return { openL1: openL1, openL2: openL2, openL3: openL3, bindChart: bindChart, DIM_LABELS: DIM_LABELS };
})();

// ═══════════════════════════════════════════════════════════════
// KPILinkage — KPI 穿透导航系统
// KPI 卡片添加 data-link 属性即可点击跳转到详情页
// ═══════════════════════════════════════════════════════════════
window.KPILinkage = (function() {
  'use strict';

  var defaultMap = {
    'output':           { href: 'wip.html',         param: 'focus=output' },
    'oee':              { href: 'oee.html',         param: '' },
    'bad_rate':         { href: 'bad.html',         param: 'view=real' },
    'wip_queue':        { href: 'wip.html',         param: 'view=bottleneck' },
    'fixture_life':     { href: 'fixture-life.html',param: '' },
    'line_balance':     { href: 'line-balance.html',param: '' },
    'line_balance_rate':{ href: 'line-balance.html',param: 'focus=balance-rate' },
    'scrap':            { href: 'bad.html',         param: 'view=scrap' },
    'downtime':         { href: 'oee.html',         param: 'focus=downtime' },
    'health':           { href: 'health.html',      param: '' },
    'ai_insight':       { href: 'ai-center.html',   param: '' },
    'stockout':         { href: 'bad.html',         param: 'view=stockout' }
  };

  function init(container) {
    container = container || document;
    var cards = container.querySelectorAll('[data-link], [data-drill-target]');
    cards.forEach(function(card) {
      if (card._kpiLinked) return;
      card._kpiLinked = true;
      card.style.cursor = 'pointer';
      card.addEventListener('click', function(e) {
        if (e.target.closest('button, a, input, select, .btn, .ss-dropdown')) return;
        var linkKey = card.getAttribute('data-drill-target') || card.getAttribute('data-link');
        var target = defaultMap[linkKey];
        var extraParams = card.getAttribute('data-link-params') || '';
        if (!target) {
          var href = linkKey;
          if (extraParams) href += (href.indexOf('?') >= 0 ? '&' : '?') + extraParams;
          window.PageTransition.navigateTo(href);
          return;
        }
        var label = (card.querySelector('.kpi-label, .stat-label, .focus-eyebrow') || {}).textContent || '';
        // 走 DrillLink.openL1(3 级下钻 L1,带 filter 上下文 + DrillCtx);DrillLink 未就绪时兜底裸跳
        if (window.DrillLink && DrillLink.openL1) {
          DrillLink.openL1(linkKey, { label: label, extraParams: extraParams });
        } else {
          var fullHref = target.href;
          var fullParams = target.param || '';
          if (extraParams) fullParams = fullParams ? fullParams + '&' + extraParams : extraParams;
          if (fullParams) fullHref += '?' + fullParams;
          window.PageTransition.navigateTo(fullHref);
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { init(); });
  } else {
    init();
  }

  return { init: init, map: defaultMap };
})();

// ========== 帕累托累计百分比(纯计算,供 cockpit/bad-charts 共用,消除两份重复) ==========
// 返回累计%数组(每项保留1位小数);total<=0 时返回全0数组
window.paretoCumulative = function(counts, total) {
  var cum = 0, t = total > 0 ? total : 0;
  return (counts || []).map(function(c) { cum += c; return t > 0 ? +(cum / t * 100).toFixed(1) : 0; });
};

// ========== 全局无障碍增强 (U8: ESC 关闭已打开的抽屉/模态) =========
// 点击其关闭按钮; 无关闭按钮或非抽屉/模态则不动。Confirm 自带 ESC, 此处兜底其余 drawer/modal。
(function(){
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    var el = document.querySelector('.drawer.show, .drawer.open, .modal.show, .modal.open, .overlay.show, .drawer-overlay.show');
    if(!el) return;
    var btn = el.querySelector('.drawer-close, .close, [data-close], .btn-close, .modal-close');
    if(btn){ e.preventDefault(); e.stopPropagation(); btn.click(); }
  });
})();

// ========== 全局无障碍增强 (U12: 可排序表头键盘可达) =========
// 参照 bad.html 模式, 全站 th[onclick] 统一加 tabindex/role, Enter/Space 触发排序(原仅鼠标可点)
// 已有 tabindex 的(bad 页)跳过, 不重复绑定
(function(){
  function onReady(fn){ if(document.readyState!=='loading') fn(); else document.addEventListener('DOMContentLoaded',fn); }
  function enhance(){
    // U12+U3: 可排序表头 + 可点击 KPI 卡/focus-mini 键盘可达(参照 bad/portal 模式, 已有 tabindex 跳过)
    document.querySelectorAll('th[onclick]:not([tabindex]), .kpi-card[onclick]:not([tabindex]), .focus-mini[onclick]:not([tabindex])').forEach(function(el){
      el.setAttribute('tabindex','0');
      el.setAttribute('role','button');
      el.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); el.click(); } });
    });
  }
  onReady(enhance);
  setTimeout(enhance, 1500); // 异步渲染的表兜底
})();

// ========== 打印图表共享件 (横展自 bad.html _badPrintCharts) =========
// 浏览器打印不渲染 ECharts canvas → 打印预览图表空白。beforeprint 用 getDataURL <img>
// 替换每个 canvas + 锁高防塌缩 + 关停动画; afterprint 还原。common.js 自动注册,
// 全站图表页(bad/wip/oee/cockpit/...) Ctrl+P 或 Toolbar 打印均自动生效。
window.autoPrintCharts = (function() {
  var state = null;
  function enter() {
    if (typeof echarts === 'undefined') return;
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--surface-base').trim() || '#0a0d12';
    var imgs = [], locks = [], marks = [];
    var seen = new Set();
    Array.prototype.forEach.call(document.querySelectorAll('canvas'), function(cv) {
      var el = cv, inst = null;
      for (var i = 0; i < 5 && el; i++) { try { inst = echarts.getInstanceByDom(el); } catch(e) { inst = null; } if (inst) break; el = el.parentElement; }
      if (!inst || seen.has(el)) return; seen.add(el);
      var url = null;
      try { url = inst.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg }); } catch(e) {}
      if (!url) return;
      if (el.offsetHeight > 0) { el.style.height = el.offsetHeight + 'px'; locks.push(el); }
      el.setAttribute('data-print-chart', String(marks.length));
      marks.push(el);
      var im = document.createElement('img');
      im.src = url; im.className = '__print_chart_img';
      el.appendChild(im); imgs.push(im);
    });
    var neutral = document.createElement('style');
    neutral.id = '__print_neutral';
    neutral.textContent = '*{animation:none!important}';
    document.head.appendChild(neutral);
    state = { imgs: imgs, locks: locks, marks: marks, neutral: neutral };
  }
  function exit() {
    if (!state) return;
    state.imgs.forEach(function(i) { i.remove(); });
    state.locks.forEach(function(el) { el.style.height = ''; });
    state.marks.forEach(function(el) { el.removeAttribute('data-print-chart'); });
    if (state.neutral) state.neutral.remove();
    state = null;
  }
  window.addEventListener('beforeprint', enter);
  window.addEventListener('afterprint', exit);
  return { enter: enter, exit: exit };
})();

