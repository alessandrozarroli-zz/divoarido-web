// Service worker: riproduce i video direttamente da Google Drive senza scaricarli.
// Il player chiede "./__drive__/<id file>" con un intervallo di byte (Range); qui la richiesta
// diventa una lettura parziale dal Drive con il token dell'utente, così il video parte subito
// e si può saltare a qualsiasi minuto.

let TOKEN = null;
let API = 'https://www.googleapis.com/drive/v3';
const META = new Map();
// OSPITE (link temporaneo): niente token Google, ma la chiave API pubblica (e, se serve, le «chiavi di risorsa» dei file) che la pagina passa qui.
let OSPITE = null;            // {key, claves: {idFile: chiave}} oppure null
// Per l'ospite Google conta come «scaricato» tutto cio' che si CHIEDE (anche se poi si legge un pezzo solo): una richiesta «dal secondo X fino alla fine»
// di un video da 4 GB esaurisce in fretta il limite di scarico del file. Quindi a Google si chiede sempre un pezzo alla volta (8 MB); il browser continua da solo.
let PEZZO_OSPITE = 8 * 1024 * 1024;
let ULTIMO_ERRORE = null;     // ultimo rifiuto di Google (per spiegare all'utente perche' un video non parte)
// Una richiesta a Google che non risponde entro questo tempo viene interrotta (e ritentata una volta): con un collegamento che si ferma a tratti
// il video restava appeso per sempre. E se il browser annulla la richiesta (salto a un'altra clip) si interrompe subito anche quella a Google,
// invece di lasciarla scaricare 8 MB che nessuno guarda e che intasano la rete. 25/11/2026.
let TIMEOUT_PEZZO = 12000;
// Seconda strada per i video dell'ospite: download diretto di Google, senza chiave API (usata se la lettura con la chiave viene rifiutata).
let UC = 'https://drive.usercontent.google.com';
let UC_PREFERITA_FINO = 0;    // fino a quest'ora (ms) si prova per prima la seconda strada

function fetchConTempo(url, opz, ms, esterno) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), ms);
  if (esterno) { if (esterno.aborted) ac.abort(); else esterno.addEventListener('abort', () => ac.abort(), { once: true }); }
  return fetch(url, Object.assign({}, opz, { signal: ac.signal })).then((r) => { clearTimeout(tm); return r; }, (e) => { clearTimeout(tm); throw e; });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function impostaOspite(d) {
  OSPITE = d && d.key ? { key: d.key, claves: d.claves || {} } : null;
  if (d && d.pezzo > 0) PEZZO_OSPITE = d.pezzo;
  if (d && d.timeout > 0) TIMEOUT_PEZZO = d.timeout;
  if (d && d.uc) UC = String(d.uc).replace(/\/$/, '');
  if (d && d.preferisciUC === false) UC_PREFERITA_FINO = 0;
  if (!OSPITE) META.clear();
}

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.tipo === 'token') { TOKEN = d.token; if (d.api) API = d.api; }
  if (d.tipo === 'ospite') { impostaOspite(d); if (d.api) API = d.api; }
});

// Si chiede alla pagina (a TUTTE le schede aperte insieme, e la prima risposta utile vince): prima si chiedeva una scheda alla volta con 15 s di attesa
// ciascuna, e le schede vecchie o di prova (che non rispondono) bloccavano il video per decine di secondi. 25/11/2026.
async function chiediToken(rinnova) {
  const clients = await self.clients.matchAll({ type: 'window' });
  if (!clients.length) return TOKEN;
  return new Promise((fine) => {
    let pendenti = clients.length, chiuso = false;
    const chiudi = () => { if (!chiuso) { chiuso = true; fine(TOKEN); } };
    for (const c of clients) {
      new Promise((ok) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => ok(null), 4000);
        ch.port1.onmessage = (ev) => { clearTimeout(timer); ok(ev.data); };
        try { c.postMessage({ tipo: 'serve-token', rinnova: !!rinnova }, [ch.port2]); } catch (e) { clearTimeout(timer); ok(null); }
      }).then((t) => {
        if (chiuso) return;
        if (t && t.ospite && t.ospite.key) { impostaOspite(t.ospite); if (t.api) API = t.api; return chiudi(); }
        if (t && t.token) { TOKEN = t.token; if (t.api) API = t.api; return chiudi(); }
        if (--pendenti === 0) chiudi();
      });
    }
  });
}

// Credenziali pronte? (altrimenti si chiedono alla pagina)
async function credenziali(rinnova) {
  if (OSPITE) return TOKEN;
  return TOKEN || await chiediToken(rinnova);
}

function intestazioni(t, id) {
  if (OSPITE) {
    const rk = OSPITE.claves && OSPITE.claves[id];
    return rk ? { 'X-Goog-Drive-Resource-Keys': id + '/' + rk } : {};
  }
  return t && t !== 'mock' ? { Authorization: 'Bearer ' + t } : {};
}

// Con la chiave API pubblica dell'ospite l'indirizzo porta anche «key=…»
function conChiave(url) {
  return OSPITE ? url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(OSPITE.key) : url;
}

async function meta(id) {
  if (META.has(id)) return META.get(id);
  let t = await credenziali(false);
  let r = await fetchConTempo(conChiave(`${API}/files/${id}?fields=size,mimeType,name&supportsAllDrives=true`), { headers: intestazioni(t, id) }, TIMEOUT_PEZZO);
  if (r.status === 401 && !OSPITE) { t = await chiediToken(true); r = await fetchConTempo(`${API}/files/${id}?fields=size,mimeType,name&supportsAllDrives=true`, { headers: intestazioni(t, id) }, TIMEOUT_PEZZO); }
  if (!r.ok) {
    let motivo = '';
    try { const j = JSON.parse(await r.text()); motivo = (j.error && j.error.message) || ''; } catch (e) {}
    ULTIMO_ERRORE = { id, status: r.status, motivo, quando: Date.now() };
    throw new Error('meta ' + r.status);
  }
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
  if (req.signal && req.signal.aborted) return new Response(null, { status: 499 });         // il browser ha gia' annullato la richiesta
  let m;
  try { m = await meta(id); }
  catch (e) {
    if (/^meta \d+/.test(String(e && e.message))) return new Response('Video non accessibile', { status: 404 });      // Google ha risposto con un rifiuto
    // nessuna risposta (rete caduta o scaduto il tempo): non e' «video non accessibile», si dice com'e'
    ULTIMO_ERRORE = { id, status: 0, motivo: 'informazioni sul video: ' + String((e && e.message) || e), quando: Date.now() };
    return new Response('Connessione con Google non riuscita', { status: 502 });
  }
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
  if (OSPITE) fine = Math.min(fine, inizio + PEZZO_OSPITE - 1);
  const url = conChiave(`${API}/files/${id}?alt=media&supportsAllDrives=true`);
  let t = await credenziali(false);
  const chiedi = (tok) => fetchConTempo(url, { headers: Object.assign({ Range: `bytes=${inizio}-${fine}` }, intestazioni(tok, id)) }, TIMEOUT_PEZZO, req.signal);
  let r = null;
  if (OSPITE) {
    // DUE STRADE verso Google (28/11/2026): a volte Google rifiuta la lettura con la chiave API (403 con una pagina «Sorry…» senza intestazioni CORS: il browser
    // la vede solo come «Load failed»/«Failed to fetch») mentre il download diretto (drive.usercontent.google.com) risponde. Si prova la strada che ha funzionato
    // per ultima; se cade, subito l'altra; poi un ultimo tentativo sulla prima. Se una strada ha funzionato dopo il rifiuto dell'altra, la si preferisce per 10 minuti.
    const rk = OSPITE.claves && OSPITE.claves[id];
    const urlUC = `${UC}/download?id=${encodeURIComponent(id)}&export=download&confirm=t` + (rk ? '&resourcekey=' + encodeURIComponent(rk) : '');
    const chiediUC = () => fetchConTempo(urlUC, { headers: { Range: `bytes=${inizio}-${fine}` } }, TIMEOUT_PEZZO, req.signal);
    const prima = Date.now() < UC_PREFERITA_FINO ? 1 : 0;
    const sequenza = [prima, 1 - prima, prima];
    const errori = {};
    const t0 = Date.now();
    for (let k = 0; k < sequenza.length && !r; k++) {
      if (req.signal && req.signal.aborted) return new Response(null, { status: 499 });
      if (k === 2) { if (Date.now() - t0 > 15000) break; await new Promise((x) => setTimeout(x, 400)); }
      const s = sequenza[k];
      try {
        const x = await (s === 0 ? chiedi(t) : chiediUC());
        const html = /text\/html/i.test(x.headers.get('content-type') || '');
        if (x.ok && !html) { r = x; UC_PREFERITA_FINO = s === 1 ? Date.now() + 10 * 60000 : 0; break; }
        let motivo = '';
        if (!html) { try { const j = JSON.parse(await x.text()); motivo = (j.error && j.error.message) || ''; } catch (e) {} }
        else motivo = 'Google ha risposto con una pagina di rifiuto';
        errori[s] = { id, status: x.status, motivo, quando: Date.now() };
      } catch (e) {
        if (req.signal && req.signal.aborted) return new Response(null, { status: 499 });
        errori[s] = { id, status: 0, motivo: String((e && e.message) || e), quando: Date.now() };
      }
    }
    if (!r) {
      const e = errori[0] || errori[1];
      ULTIMO_ERRORE = e;
      if (e.status === 0) return new Response('Connessione con Google non riuscita', { status: 502 });
      return new Response('Errore Drive ' + e.status + (e.motivo ? ': ' + e.motivo : ''), { status: e.status });
    }
  }
  // una caduta di rete (anche momentanea) non deve far fallire la richiesta senza spiegazioni: si riprova una volta, poi si dice perche'
  for (let k = 0; !r; k++) {
    try { r = await chiedi(t); break; }
    catch (e) {
      if (req.signal && req.signal.aborted) return new Response(null, { status: 499 });     // annullata dal browser (salto a un'altra clip): niente nuovi tentativi
      if (k >= 1) {
        ULTIMO_ERRORE = { id, status: 0, motivo: String((e && e.message) || e), quando: Date.now() };
        return new Response('Connessione con Google non riuscita', { status: 502 });
      }
      await new Promise((x) => setTimeout(x, 400));
    }
  }
  if ((r.status === 401 || r.status === 403) && !OSPITE) {
    t = await chiediToken(true);
    r = await chiedi(t);
  }
  if (!r.ok) {
    let motivo = '';
    try { const j = JSON.parse(await r.text()); motivo = (j.error && j.error.message) || ''; } catch (e) {}
    ULTIMO_ERRORE = { id, status: r.status, motivo, quando: Date.now() };
    return new Response('Errore Drive ' + r.status + (motivo ? ': ' + motivo : ''), { status: r.status });
  }
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
  if (i >= 0 && u.origin === self.location.origin && u.pathname.endsWith('/__drive__/_errore')) {
    e.respondWith(new Response(JSON.stringify(ULTIMO_ERRORE), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    return;
  }
  if (i >= 0 && u.origin === self.location.origin) {
    const id = decodeURIComponent(u.pathname.slice(i + 11));
    e.respondWith(streaming(e.request, id));
  }
});
