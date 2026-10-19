// 서비스 워커 — 앱 화면 파일만 캐시해서 지하철·비행기 모드에서도 열리게 한다.
// Dropbox API 요청은 가로채지 않는다 (기록 대기열은 app.js가 IndexedDB로 따로 관리).
// 화면 파일을 고치면 VERSION을 올린다 → 다음 실행 때 새 파일로 바뀐다.
const VERSION = 'coach-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 화면 파일: 캐시를 바로 보여주고 뒤에서 새 파일을 받아 둔다 (지하철처럼 느린 망에서 기다리지 않게)
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => hit || caches.match('index.html'));
    return hit || net;
  }));
});
