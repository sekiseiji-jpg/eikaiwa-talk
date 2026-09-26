// オフライン対応: アプリのファイルはネット優先で取得し、つながらないときはキャッシュを使う
// 公開ファイルを更新したら CACHE の番号と、index.html の ?v= の番号を一緒に上げる
// （?v= で index.html と同じ版の CSS/JS を読むので、更新の途中で新旧が混ざらない）
const CACHE = 'eikaiwa-v7';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'data.js',
  'vocab.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // GitHub Pages は max-age=600 なので、HTTPキャッシュを通さずに取得する
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 翻訳APIなど外部への通信はキャッシュしない
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }) // 毎回サーバーに更新を確認する
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
