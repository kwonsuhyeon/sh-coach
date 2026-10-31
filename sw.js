// 서비스 워커 — 앱 화면 파일만 캐시해서 지하철·비행기 모드에서도 열리게 한다.
// Dropbox API 요청은 가로채지 않는다 (기록 대기열은 app.js가 IndexedDB로 따로 관리).
// 화면 파일을 고치면 VERSION을 올린다 → 다음 실행 때 새 파일로 바뀐다.
const VERSION = 'coach-v24';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' — 브라우저 HTTP 캐시(GitHub Pages는 10분 보관)를 거치지 않고 새 파일을 받는다
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 화면 파일: 망이 되면 항상 새 파일(HTTP 캐시도 확인), 3초 안에 안 오거나 오프라인이면 캐시
  e.respondWith((async () => {
    const cached = () => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'));
    const net = fetch(e.request, { cache: 'no-cache' }).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    });
    const timeout = new Promise(res => setTimeout(() => res(null), 3000));
    try { return (await Promise.race([net, timeout])) || (await cached()) || (await net); }
    catch { return cached(); }
  })());
});
