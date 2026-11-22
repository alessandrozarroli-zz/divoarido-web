// Motore Python: nel browser è Pyodide (Python compilato per il web) che esegue il programma
// originale; in fase di sviluppo può essere un server locale con lo stesso ponte (bridge.py).
//
// Velocità di avvio (22/11/2026):
// - i file da scaricare (libreria dei PDF, htk.py, bridge.py e il programma) partono TUTTI subito, insieme al caricamento di Python;
// - il programma (20.000 righe) viene COMPILATO da Python a ogni apertura: la prima volta si conserva nel browser (IndexedDB) il
//   codice già compilato (file .pyc «unchecked-hash» generato qui con compile + marshal), e le volte dopo lo si rimette al suo posto prima dell'importazione:
//   Python lo carica senza ricompilare (circa 4 secondi in meno). La chiave è l'impronta (SHA-256) del programma e la versione di Pyodide:
//   se il programma cambia, si ricompila da sé. Se il codice conservato fosse rovinato, si cancella e si ricompila come prima.
//   Per gli ospiti (link temporaneo) non si conserva nulla nel browser.

const FILE_MOTORE = ['htk.py', 'bridge.py', 'volley.py'];

// ---------- cache del codice compilato ----------
const PYC_DB = 'vps-pyc', PYC_ST = 'p', PYC_CHIAVE = 'ultimo';
function pycApri() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(PYC_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(PYC_ST);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}
async function pycLeggi() {
  const db = await pycApri();
  try { return await new Promise((ok, ko) => { const q = db.transaction(PYC_ST).objectStore(PYC_ST).get(PYC_CHIAVE); q.onsuccess = () => ok(q.result || null); q.onerror = () => ko(q.error); }); }
  finally { db.close(); }
}
async function pycScrivi(rec) {
  const db = await pycApri();
  try { await new Promise((ok, ko) => { const t = db.transaction(PYC_ST, 'readwrite'); t.objectStore(PYC_ST).put(rec, PYC_CHIAVE); t.oncomplete = ok; t.onerror = () => ko(t.error); }); }
  finally { db.close(); }
}
async function pycCancella() {
  try { const db = await pycApri(); try { await new Promise((ok) => { const t = db.transaction(PYC_ST, 'readwrite'); t.objectStore(PYC_ST).delete(PYC_CHIAVE); t.oncomplete = ok; t.onerror = ok; }); } finally { db.close(); } } catch (e) {}
}
async function impronta(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
const cacheDisponibile = () => typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle;

class MotorePyodide {
  constructor(py, bridge) { this.py = py; this.bridge = bridge; this.root = ''; this.pycUsato = false; }

  static async crea(cfg, avanzamento, programma, opz = {}) {
    const usaCache = opz.cachePyc !== false && cacheDisponibile();
    avanzamento('Carico Python nel browser…');
    // --- tutti i download partono subito, in parallelo con il caricamento di Python ---
    const scarica = (f, tipo) => fetch('engine/' + f, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(f + ' non trovato'); return tipo === 'bin' ? r.arrayBuffer() : r.text(); });
    const pWhl = fetch('engine/' + cfg.REPORTLAB_WHEEL).then((r) => { if (!r.ok) throw new Error('reportlab non trovato'); return r.arrayBuffer(); });
    const pFile = {};
    for (const f of FILE_MOTORE) if (f !== 'volley.py' || !programma) pFile[f] = scarica(f);
    const pProg = programma ? Promise.resolve().then(() => programma()) : null;     // (attende da solo l'accesso a Google)
    for (const p of [pWhl, pProg, ...Object.values(pFile)]) if (p) p.catch(() => {});

    const mod = await import(cfg.PYODIDE_URL + 'pyodide.mjs');
    const py = await mod.loadPyodide({ indexURL: cfg.PYODIDE_URL });
    avanzamento('Carico le librerie per i PDF…');
    await py.loadPackage(['pillow', 'numpy']);
    py.unpackArchive(await pWhl, 'wheel');
    avanzamento('Carico il programma DivoArido…');
    py.FS.mkdirTree('/engine');
    for (const f of FILE_MOTORE) {
      if (f === 'volley.py' && programma) continue;
      py.FS.writeFile('/engine/' + f, await pFile[f]);
    }
    let progBytes = null;
    if (programma) {
      avanzamento('Carico il programma dal Google Drive…');
      progBytes = await pProg;
      py.FS.writeFile('/engine/volley.py', progBytes);
    }
    py.runPython("import sys\nif '/engine' not in sys.path: sys.path.insert(0, '/engine')");

    // --- codice compilato conservato nel browser ---
    let chiave = null, pycPercorso = null, usato = false;
    if (usaCache) {
      try {
        if (!progBytes) progBytes = py.FS.readFile('/engine/volley.py');
        chiave = (await impronta(progBytes)) + '|' + cfg.PYODIDE_URL;
        pycPercorso = py.runPython("import importlib.util\nimportlib.util.cache_from_source('/engine/volley.py')");
        const rec = await pycLeggi();
        if (rec && rec.chiave === chiave && rec.pyc && rec.pyc.length) {
          py.FS.mkdirTree(pycPercorso.substring(0, pycPercorso.lastIndexOf('/')));
          py.FS.writeFile(pycPercorso, rec.pyc);
          usato = true;
        }
      } catch (e) { console.warn('cache del programma compilato non usabile', e); chiave = null; }
    }
    // Pyodide non scrive da solo il .pyc: se manca la cache lo si compila qui (una volta sola, poi l'importazione lo trova pronto) e lo si conserva
    let generato = false;
    if (usaCache && chiave && !usato) {
      try {
        py.runPython(`
import importlib.util, marshal
from importlib import _bootstrap_external as _be
_src = open('/engine/volley.py', 'rb').read()
_code = compile(_src, '/engine/volley.py', 'exec', dont_inherit=True)
_pyc = _be._code_to_hash_pyc(_code, importlib.util.source_hash(_src), False)
import os
os.makedirs(os.path.dirname(${JSON.stringify(pycPercorso)}), exist_ok=True)
open(${JSON.stringify(pycPercorso)}, 'wb').write(_pyc)
del _src, _code, _pyc
`);
        generato = true;
      } catch (e) { console.warn('codice compilato non generato', e); }
    }
    avanzamento('Avvio del programma…');
    let bridge;
    try { bridge = py.pyimport('bridge'); }
    catch (e) {
      if (!usato && !generato) throw e;
      console.warn('codice compilato conservato non valido: lo ricompilo', e);       // ripiego: si cancella e si fa come prima
      await pycCancella();
      try { py.FS.unlink(pycPercorso); } catch (x) {}
      py.runPython("import sys\nfor k in ('bridge', 'volley'): sys.modules.pop(k, None)");
      usato = false; generato = false;
      bridge = py.pyimport('bridge');
    }
    const m = new MotorePyodide(py, bridge);
    m.pycUsato = usato;
    m.chiamaSync('prepara', '');
    // prima volta (o programma cambiato): si conserva il codice compilato
    if (usaCache && generato && chiave) {
      try { await pycScrivi({ chiave, pyc: py.FS.readFile(pycPercorso), quando: Date.now() }); }
      catch (e) { console.warn('codice compilato non conservato', e); }
    }
    return m;
  }

  chiamaSync(fn, ...args) { return this.bridge[fn](...args); }
  async chiama(fn, ...args) { return this.bridge[fn](...args); }

  async scriviFile(path, bytes) {
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir) this.py.FS.mkdirTree(dir);
    this.py.FS.writeFile(path, bytes);
  }
}

class MotoreHttp {
  constructor(url, root) { this.url = url; this.root = root; }

  static async crea(cfg, avanzamento) {
    avanzamento('Collego il motore di sviluppo…');
    const info = await fetch(cfg.DEV_ENGINE_URL + '/info').then((r) => r.json());
    const m = new MotoreHttp(cfg.DEV_ENGINE_URL, info.root);
    await m.chiama('prepara', info.root);
    return m;
  }

  async chiama(fn, ...args) {
    const r = await fetch(this.url + '/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) });
    if (!r.ok) throw new Error(await r.text());
    return r.text();
  }

  async scriviFile(path, bytes) {
    let bin = '';
    const passo = 0x8000;
    for (let i = 0; i < bytes.length; i += passo) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
    await this.chiama('fs_scrivi', path, btoa(bin));
  }
}

// programma: funzione asincrona che restituisce i byte di volley.py (se il programma sta sul
// Drive invece che accanto alla pagina), oppure null.
// opz.cachePyc = false: non conservare nulla nel browser (ospiti).
export async function creaMotore(cfg, avanzamento, programma, opz = {}) {
  if (cfg.DEV_ENGINE_URL) return MotoreHttp.crea(cfg, avanzamento);
  return MotorePyodide.crea(cfg, avanzamento, programma, opz);
}
