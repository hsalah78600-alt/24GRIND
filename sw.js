/* Hassanfit service worker: يخلّي التطبيق يفتح بدون إنترنت، ويجيب النسخة الجديدة لما يكون في نت. */
const CACHE = 'hassanfit-v24';
const SHELL = ['./', 'index.html', 'cloud.js', 'firebase-config.js', 'push-config.js', 'manifest.webmanifest', 'foods.js', 'lang-en.js', 'exercises.js',
  'forma-192.png', 'forma-512.png', 'forma-touch.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  /* بيانات Firestore والتسجيل لازم تروح مباشرة للسيرفر */
  if (/googleapis\.com$/.test(url.hostname) && !/fonts\./.test(url.hostname)) return;
  if (url.hostname.endsWith('firebaseio.com') || url.hostname.endsWith('identitytoolkit.googleapis.com')) return;

  if (url.origin === location.origin) {
    /* ملفات التطبيق: النت أولا، ولو مفيش نت من الكاش */
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
    );
    return;
  }
  /* الخطوط ومكتبات Firebase: من الكاش لو موجودة وتتحدّث في الخلفية */
  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});

/* تنبيهات الدفع: بتوصل حتى والتطبيق مقفول */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (cs.some(c => c.visibilityState === 'visible')) return; /* التطبيق قدامه: الإشعار جوه التطبيق كفاية */
    await self.registration.showNotification(d.title || 'Hassanfit', {
      body: d.body || '', icon: 'forma-192.png', badge: 'forma-192.png',
      tag: d.tag || 'hf', renotify: true, data: { url: d.url || './' }
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  })());
});
