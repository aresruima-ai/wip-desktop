const CACHE_NAME = 'cviauto-v7';
// 进阶版:只缓存 14 个真实页面 + 共享资源(原 v6 含 downtime/spc/energy 等 20+ 死链页,
// cache.addAll 任一 404 即整体 reject,导致 SW install 静默失败)
const STATIC_ASSETS = [
  '/portal.html', '/cockpit.html', '/oee.html', '/wip.html',
  '/line-balance.html', '/kanban.html', '/factory-3d.html',
  '/bad.html', '/fixture-life.html', '/ai-center.html',
  '/health.html', '/settings.html', '/admin.html', '/login.html',
  '/common.css', '/common.js', '/nav.js', '/chart-theme.js',
  '/wip-ui.js', '/filter-bar.js',
  '/libs/echarts.min.js', '/libs/echarts-liquidfill.min.js',
  '/manifest.json', '/images/favicon.svg', '/images/logo-sm.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // addAll 任一失败会 reject;改用逐个 put + catch,容错缺失资源
      Promise.all(STATIC_ASSETS.map(url =>
        cache.add(url).catch(err => console.warn('[SW] 缓存失败', url, err.message))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  const isHTML = e.request.mode === 'navigate' || e.request.url.endsWith('.html');
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
