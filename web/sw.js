// Service worker de Facturación RD: permite instalar la app y abrirla aunque la conexión falle.
// Los datos siempre vienen de Supabase y de /api (nunca se guardan aquí); solo se guarda la "cáscara" de la app.
const CACHE = 'facturacion-rd-v2';
const BASICOS = ['/', '/manifest.webmanifest', '/icons/logo.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API propia, servicios e-CF y Supabase: siempre a la red, sin caché.
  if (url.origin === location.origin && /^\/(api|fe)\//i.test(url.pathname)) return;
  if (url.hostname.endsWith('supabase.co')) return;

  // Páginas: primero la red (para tener siempre la última versión); si no hay conexión, la copia guardada.
  if (req.mode === 'navigate') {
    ev.respondWith(fetch(req).then(r => {
      const copia = r.clone(); caches.open(CACHE).then(c => c.put('/', copia));
      return r;
    }).catch(() => caches.match('/')));
    return;
  }

  // Íconos propios y librerías de CDN (con versión fija): de la caché y, si no está, de la red.
  if (url.origin === location.origin || /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(url.hostname)) {
    ev.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok || r.type === 'opaque') { const copia = r.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
      return r;
    })));
  }
});
