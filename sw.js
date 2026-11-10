// Cache only application shell files. Never cache quotes, candles, books or scan results.
const CACHE='radar-static-v4.1';
const ASSETS=['/','/static/styles.css','/static/app.js','/static/icon.svg','/static/manifest.webmanifest'];
self.addEventListener('install', e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}));self.skipWaiting();});
self.addEventListener('activate', e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.pathname.startsWith('/api/')||u.pathname==='/health')return; if(u.origin!==self.location.origin)return; e.respondWith(fetch(e.request).then(res=>{if(res.ok && !u.pathname.endsWith('plotly.min.js')){const copy=res.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}return res;}).catch(()=>caches.match(e.request)));});
