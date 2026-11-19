// Service worker: riproduce i video direttamente da Google Drive senza scaricarli.
// Il player chiede "./__drive__/<id file>" con un intervallo di byte (Range); qui la richiesta
// diventa una lettura parziale dal Drive con il token dell'utente, così il video parte subito
// e si può saltare a qualsiasi minuto.

let TOKEN = null;
let API = 'https://www.googleapis.com/drive/v3';
const META = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.tipo === 'token') { TOKEN = d.token; if (d.api) API = d.api; }
});

async function chiediToken(rinnova) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) {
    const t = await new Promise((ok) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => ok(null), 15000);
      ch.port1.onmessage = (ev) => { clearTimeout(timer); ok(ev.data); };
      c.postMessage({ tipo: 'serve-token', rinnova: !!rinnova }, [ch.port2]);
    });
    if (t && t.token) { TOKEN = t.token; if (t.api) API = t.api; return TOKEN; }
  }
  return TOKEN;
}

function intestazioni(t) {
  return t && t !== 'mock' ? { Authorization: 'Bearer ' + t } : {};
}

async function meta(id) {
  if (META.has(id)) return META.get(id);
  let t = TOKEN || await chiediToken(false);
  let r = await fetch(`${API}/files/${id}?fields=size,mimeType,name&supportsAllDrives=true`, { headers: intestazioni(t) });
  if (r.status === 401) { t = await chiediToken(true); r = await fetch(`${API}/files/${id}?fields=size,mimeType,name&supportsAllDrives=true`, { headers: intestazioni(t) }); }
  if (!r.ok) throw new Error('meta ' + r.status);
  const m = await r.json();
  m.size = Number(m.size);
  META.set(id, m);
  return m;
}

function tipoMime(m) {
  const n = (m.name || '').toLowerCase();
  if (m.mimeType && m.mimeType.startsWith('video/') && m.mimeType !== 'video/quicktime') return m.mimeType;
  if (n.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';   // .mov/.m4v con H.264: il browser li legge come mp4
}

async function streaming(req, id) {
  let m;
  try { m = await meta(id); } catch (e) { return new Response('Video non accessibile', { status: 404 }); }
  const tot = m.size;
  let inizio = 0, fine = tot - 1;
  const range = req.headers.get('Range');
  if (range) {
    const x = /bytes=(\d*)-(\d*)/.exec(range);
    if (x) {
      if (x[1] !== '') inizio = Number(x[1]);
      if (x[2] !== '') fine = Math.min(Number(x[2]), tot - 1);
      if (x[1] === '' && x[2] !== '') { inizio = Math.max(0, tot - Number(x[2])); fine = tot - 1; }
    }
  }
  if (inizio >= tot) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${tot}` } });
  const url = `${API}/files/${id}?alt=media&supportsAllDrives=true`;
  let t = TOKEN || await chiediToken(false);
  let r = await fetch(url, { headers: Object.assign({ Range: `bytes=${inizio}-${fine}` }, intestazioni(t)) });
  if (r.status === 401 || r.status === 403) {
    t = await chiediToken(true);
    r = await fetch(url, { headers: Object.assign({ Range: `bytes=${inizio}-${fine}` }, intestazioni(t)) });
  }
  if (!r.ok) return new Response('Errore Drive ' + r.status, { status: r.status });
  if (r.status === 200 && inizio > 0) {
    // il server ha ignorato l'intervallo: si restituisce il file intero
    return new Response(r.body, { status: 200, headers: { 'Content-Type': tipoMime(m), 'Content-Length': String(tot), 'Accept-Ranges': 'bytes' } });
  }
  return new Response(r.body, {
    status: 206,
    headers: {
      'Content-Type': tipoMime(m),
      'Content-Length': String(fine - inizio + 1),
      'Content-Range': `bytes ${inizio}-${fine}/${tot}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  });
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  const i = u.pathname.indexOf('/__drive__/');
  if (i >= 0 && u.origin === self.location.origin) {
    const id = decodeURIComponent(u.pathname.slice(i + 11));
    e.respondWith(streaming(e.request, id));
  }
});
