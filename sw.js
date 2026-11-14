/* 보난자 운영앱 — 서비스워커 (웹푸시 전용, 캐싱 없음)
 * index.html 이 자주 갱신되므로 fetch 캐싱은 두지 않는다(항상 네트워크). */
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: '보난자 운영', body: (e.data && e.data.text()) || '' }; }
  var title = d.title || '보난자 운영';
  var opts = {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || 'bnz',
    renotify: true,
    data: { url: d.url || './index.html' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cl) {
      for (var i = 0; i < cl.length; i++) {
        var c = cl[i];
        if ('focus' in c) { try { if (c.navigate) c.navigate(url); } catch (_) {} return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
