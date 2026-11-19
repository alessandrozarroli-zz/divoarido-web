// Alternativa al Google Drive: le cartelle del PC (Chrome / Edge, "File System Access").
// Partite (.dvw), dati (flag, traiettorie) e video si leggono e si scrivono direttamente sul disco:
// niente accesso Google, niente caricamenti. Ha la stessa interfaccia della classe Drive.
//
// Identificativi: 'P:<chiave>' per la cartella scelta dall'utente, 'P:<chiave>/sotto/cartella' per
// quello che contiene; la chiave rimanda al "permesso" salvato nel browser (IndexedDB), così la
// volta dopo basta un clic per riautorizzare la stessa cartella.

import { Drive, eVideo } from './drive.js';

const CARTELLA = 'application/vnd.google-apps.folder';
const DB = 'vps-pc', ST = 'radici';

export const pcDisponibile = () => typeof window.showDirectoryPicker === 'function';

function idb() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: 'chiave' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}
async function idbTutti() {
  try {
    const db = await idb();
    return await new Promise((ok, ko) => { const q = db.transaction(ST).objectStore(ST).getAll(); q.onsuccess = () => ok(q.result || []); q.onerror = () => ko(q.error); });
  } catch (e) { return []; }
}
async function idbLeggi(chiave) {
  try {
    const db = await idb();
    return await new Promise((ok, ko) => { const q = db.transaction(ST).objectStore(ST).get(chiave); q.onsuccess = () => ok(q.result || null); q.onerror = () => ko(q.error); });
  } catch (e) { return null; }
}
async function idbScrivi(rec) {
  try {
    const db = await idb();
    await new Promise((ok, ko) => { const t = db.transaction(ST, 'readwrite'); t.objectStore(ST).put(rec); t.oncomplete = ok; t.onerror = () => ko(t.error); });
  } catch (e) { console.warn('cartella non memorizzata', e); }
}

function tipoMime(nome) {
  const n = nome.toLowerCase();
  if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4';
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

export class DrivePC extends Drive {
  constructor(cfg) {
    super(cfg);
    this.pc = true; this.mock = true;
    this.utente = { displayName: 'Questo PC', emailAddress: 'pc' };
    this.radici = new Map();       // chiave -> handle (cartella o file scelti)
    this.maniglie = new Map();     // id -> handle
    this.urlVideoCache = new Map();
  }

  connesso() { return true; }
  async login() { this.onToken('pc'); return 'pc'; }
  async token() { return 'pc'; }
  async utenteCorrente() { return this.utente; }
  async condivisiConMe() { return []; }
  async driveCondivisi() { return []; }

  // --- permessi e radici ---
  async registra(handle, tipo) {
    for (const r of await idbTutti()) {
      try { if (await r.handle.isSameEntry(handle)) { this.radici.set(r.chiave, handle); await idbScrivi({ chiave: r.chiave, name: handle.name, tipo, handle, quando: Date.now() }); return 'P:' + r.chiave; } } catch (e) {}
    }
    const chiave = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.radici.set(chiave, handle);
    await idbScrivi({ chiave, name: handle.name, tipo, handle, quando: Date.now() });
    return 'P:' + chiave;
  }

  async recenti(tipo) {
    return (await idbTutti()).filter((r) => r.tipo === tipo).sort((a, b) => b.quando - a.quando).slice(0, 6);
  }

  async _radice(chiave) {
    if (this.radici.has(chiave)) return this.radici.get(chiave);
    const rec = await idbLeggi(chiave);
    if (!rec) throw new Error('Cartella non più disponibile: sceglila di nuovo.');
    let perm = await rec.handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await rec.handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') throw new Error('Il browser non ha ancora il permesso per «' + rec.name + '»: sceglila di nuovo (basta un clic su «Usa di nuovo»).');
    this.radici.set(chiave, rec.handle);
    return rec.handle;
  }

  async handle(id) {
    if (this.maniglie.has(id)) return this.maniglie.get(id);
    if (!String(id).startsWith('P:')) throw new Error('Identificativo non valido');
    const parti = id.slice(2).split('/');
    let h = await this._radice(parti[0]);
    for (let i = 1; i < parti.length; i++) {
      try { h = await h.getDirectoryHandle(parti[i]); }
      catch (e) { h = await h.getFileHandle(parti[i]); }
    }
    this.maniglie.set(id, h);
    return h;
  }

  // --- lettura ---
  async figli(cartellaId) {
    const dir = await this.handle(cartellaId);
    const out = [];
    for await (const [nome, eh] of dir.entries()) {
      if (nome.startsWith('.') || nome.startsWith('~$')) continue;
      const id = cartellaId + '/' + nome;
      this.maniglie.set(id, eh);
      const e = { id, name: nome, mimeType: eh.kind === 'directory' ? CARTELLA : tipoMime(nome) };
      if (eh.kind === 'file' && /\.(dvw|json)$/i.test(nome)) {          // data e dimensione servono solo per i file dei dati
        try { const f = await eh.getFile(); e.size = f.size; e.modifiedTime = new Date(f.lastModified).toISOString(); } catch (err) {}
      }
      out.push(e);
    }
    out.sort((a, b) => ((a.mimeType !== CARTELLA) - (b.mimeType !== CARTELLA)) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base', numeric: true }));
    return out;
  }

  async meta(id) {
    const h = await this.handle(id);
    return { id, name: h.name, mimeType: h.kind === 'directory' ? CARTELLA : tipoMime(h.name) };
  }

  async scarica(id) {
    const h = await this.handle(id);
    return await (await h.getFile()).arrayBuffer();
  }

  // Indirizzo (blob:) col quale il lettore video legge il file dal disco, anche a pezzi: i salti sono immediati
  async urlVideo(id) {
    if (this.urlVideoCache.has(id)) return this.urlVideoCache.get(id);
    let f;
    try { f = await (await this.handle(id)).getFile(); }
    catch (e) { throw new Error('Video non leggibile: il browser non ha più il permesso sulla cartella dei video. Premi «Cartella Video» e scegli di nuovo la cartella.'); }
    const u = URL.createObjectURL(f);
    this.urlVideoCache.set(id, u);
    return u;
  }

  // --- scrittura (flag, traiettorie, associazioni video) nella cartella delle partite ---
  async caricaFile(cartellaId, nome, corpo) {
    try {
      const dir = await this.handle(cartellaId);
      const fh = await dir.getFileHandle(nome, { create: true });
      const w = await fh.createWritable();
      await w.write(corpo); await w.close();
      const id = cartellaId + '/' + nome;
      this.maniglie.set(id, fh);
      return id;
    } catch (e) { console.warn('scrittura su disco non riuscita', e); return null; }
  }
}

// ------------------------------------------------------------------------------------------
// Finestra di scelta: una cartella (o un video) del PC
// ------------------------------------------------------------------------------------------
export function sceltaPC(drive, { titolo = 'Scegli una cartella', file = false, tipo = 'dvw' } = {}) {
  return new Promise((risolvi) => {
    const fondo = document.createElement('div');
    fondo.className = 'dlg-fondo dlg-aperto';
    fondo.innerHTML = `
      <div class="dlg dlg-drive" role="dialog" aria-modal="true" style="max-width:560px">
        <div class="dlg-testa"><span class="dlg-titolo"></span><button class="dlg-x" title="Annulla">✕</button></div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:12px">
          <p class="pc-testo" style="margin:0;opacity:.85;line-height:1.4"></p>
          <button class="btn-pri pc-scegli" style="padding:10px 14px;font-size:15px"></button>
          <div class="pc-recenti" hidden>
            <div style="opacity:.7;font-size:12px;margin-bottom:4px">Scelte di recente su questo computer</div>
            <div class="pc-lista" style="display:flex;flex-direction:column;gap:6px"></div>
          </div>
          <p class="pc-err" style="margin:0;color:#fca5a5"></p>
        </div>
        <div class="dlg-piede"><button class="btn-sec pc-annulla">Annulla</button></div>
      </div>`;
    document.body.append(fondo);
    const $ = (s) => fondo.querySelector(s);
    $('.dlg-titolo').textContent = titolo;
    $('.pc-testo').textContent = file
      ? 'Scegli il file video sul tuo computer. Viene letto direttamente dal disco, senza caricarlo da nessuna parte.'
      : (tipo === 'dvw'
        ? 'Scegli la cartella dove stanno le partite (.dvw). Il browser chiederà il permesso di leggerla e di salvarci i dati del tracciamento (flag, traiettorie).'
        : 'Scegli la cartella dove stanno i video (anche con sottocartelle). I video restano sul disco: vengono letti direttamente da lì.');
    $('.pc-scegli').textContent = file ? '🎬 Scegli il video…' : '📂 Scegli la cartella…';
    const chiudi = (v) => { fondo.remove(); risolvi(v); };
    $('.dlg-x').onclick = $('.pc-annulla').onclick = () => chiudi(null);
    fondo.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudi(null); });
    const scrittura = !file && tipo === 'dvw';
    const err = (t) => { $('.pc-err').textContent = t; };

    const esito = async (h) => {
      const id = await drive.registra(h, file ? 'file' : tipo);
      chiudi(file ? { id, name: h.name, mimeType: tipoMime(h.name) } : { id, name: h.name });
    };
    $('.pc-scegli').onclick = async () => {
      err('');
      if (!pcDisponibile()) { err('Questo browser non può leggere le cartelle del PC: usa Chrome o Edge su computer.'); return; }
      try {
        if (file) {
          const [h] = await window.showOpenFilePicker({ id: 'vps-video-file', multiple: false, types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'] } }] });
          await esito(h);
        } else {
          const h = await window.showDirectoryPicker({ id: 'vps-' + tipo, mode: scrittura ? 'readwrite' : 'read' });
          await esito(h);
        }
      } catch (e) { if (e && e.name !== 'AbortError') err(e.message || String(e)); }
    };

    drive.recenti(file ? 'file' : tipo).then((lista) => {
      if (!lista.length) return;
      $('.pc-recenti').hidden = false;
      for (const r of lista) {
        const b = document.createElement('button');
        b.className = 'btn-sec';
        b.style.textAlign = 'left';
        b.textContent = '↩ Usa di nuovo: ' + r.name;
        b.onclick = async () => {
          err('');
          try {
            const mode = scrittura ? 'readwrite' : 'read';
            let perm = await r.handle.queryPermission({ mode });
            if (perm !== 'granted') perm = await r.handle.requestPermission({ mode });
            if (perm !== 'granted') { err('Permesso non concesso.'); return; }
            await esito(r.handle);
          } catch (e) { err((e && e.message) || String(e)); }
        };
        $('.pc-lista').append(b);
      }
    });
  });
}
