// Motore Python: nel browser è Pyodide (Python compilato per il web) che esegue il programma
// originale; in fase di sviluppo può essere un server locale con lo stesso ponte (bridge.py).

const FILE_MOTORE = ['htk.py', 'bridge.py', 'volley.py'];

class MotorePyodide {
  constructor(py, bridge) { this.py = py; this.bridge = bridge; this.root = ''; }

  static async crea(cfg, avanzamento, programma) {
    avanzamento('Carico Python nel browser…');
    const mod = await import(cfg.PYODIDE_URL + 'pyodide.mjs');
    const py = await mod.loadPyodide({ indexURL: cfg.PYODIDE_URL });
    avanzamento('Carico le librerie per i PDF…');
    await py.loadPackage(['pillow', 'numpy']);
    const whl = await fetch('engine/' + cfg.REPORTLAB_WHEEL).then((r) => { if (!r.ok) throw new Error('reportlab non trovato'); return r.arrayBuffer(); });
    py.unpackArchive(whl, 'wheel');
    avanzamento('Carico il programma DivoArido…');
    py.FS.mkdirTree('/engine');
    for (const f of FILE_MOTORE) {
      if (f === 'volley.py' && programma) continue;
      const t = await fetch('engine/' + f, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(f + ' non trovato'); return r.text(); });
      py.FS.writeFile('/engine/' + f, t);
    }
    if (programma) {
      avanzamento('Carico il programma dal Google Drive…');
      py.FS.writeFile('/engine/volley.py', await programma());
    }
    py.runPython("import sys\nif '/engine' not in sys.path: sys.path.insert(0, '/engine')");
    const bridge = py.pyimport('bridge');
    const m = new MotorePyodide(py, bridge);
    avanzamento('Avvio del programma…');
    m.chiamaSync('prepara', '');
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
export async function creaMotore(cfg, avanzamento, programma) {
  if (cfg.DEV_ENGINE_URL) return MotoreHttp.crea(cfg, avanzamento);
  return MotorePyodide.crea(cfg, avanzamento, programma);
}
