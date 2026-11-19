// Accesso a Google Drive: login (Google Identity Services), elenco cartelle, download dei
// file .dvw, scelta delle cartelle e dei file video.

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const CAMPI = 'id,name,mimeType,size,modifiedTime,parents,shortcutDetails';
const CARTELLA = 'application/vnd.google-apps.folder';
const SCORCIATOIA = 'application/vnd.google-apps.shortcut';
export const EST_VIDEO = ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.m4v', '.webm'];

export class Drive {
  constructor(cfg) {
    this.cfg = cfg;
    this.api = cfg.DRIVE_API || 'https://www.googleapis.com/drive/v3';
    this.mock = !!cfg.MOCK_DRIVE;
    this.tok = null; this.scade = 0; this.client = null; this.utente = null;
    this._attesa = null;
    this.onToken = () => {};
    try {
      const s = JSON.parse(sessionStorage.getItem('vps_token') || 'null');
      if (s && s.scade > Date.now() + 60000) { this.tok = s.tok; this.scade = s.scade; }
    } catch (e) {}
  }

  connesso() { return this.mock || (this.tok && this.scade > Date.now() + 30000); }

  async caricaGis() {
    if (this.mock || window.google?.accounts?.oauth2) return;
    await new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.onload = ok; s.onerror = () => ko(new Error('Impossibile caricare il login di Google'));
      document.head.append(s);
    });
  }

  // Login: interattivo (bottone "Accedi") o silenzioso (rinnovo del token).
  async login(prompt = '') {
    if (this.mock) { this.onToken('mock'); return 'mock'; }
    await this.caricaGis();
    if (!this.client) {
      this.client = google.accounts.oauth2.initTokenClient({
        client_id: this.cfg.GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: () => {},
      });
    }
    return new Promise((ok, ko) => {
      this.client.callback = (r) => {
        if (r.error) { ko(new Error(r.error + (r.error_description ? ': ' + r.error_description : ''))); return; }
        this.tok = r.access_token;
        this.scade = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        try { sessionStorage.setItem('vps_token', JSON.stringify({ tok: this.tok, scade: this.scade })); } catch (e) {}
        this.onToken(this.tok);
        this.programmaRinnovo();
        ok(this.tok);
      };
      this.client.error_callback = (e) => ko(new Error((e && e.type ? e.type + ': ' : '') + (e && e.message ? e.message : 'Accesso annullato')));
      const hint = localStorage.getItem('vps_email') || undefined;
      this.client.requestAccessToken({ prompt, hint });
    });
  }

  programmaRinnovo() {
    clearTimeout(this._rinnovo);
    const tra = Math.max(60000, this.scade - Date.now() - 5 * 60000);
    this._rinnovo = setTimeout(() => this.login('').catch(() => this.onScaduto?.()), tra);
  }

  async token() {
    if (this.mock) return 'mock';
    if (this.connesso()) return this.tok;
    if (!this._attesa) this._attesa = this.login('').finally(() => { this._attesa = null; });
    return this._attesa;
  }

  async get(path, params = {}, tipo = 'json') {
    const u = new URL(this.api + path, location.href);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    for (let tentativo = 0; tentativo < 3; tentativo++) {
      const t = await this.token();
      const r = await fetch(u, { headers: this.mock ? {} : { Authorization: 'Bearer ' + t } });
      if (r.status === 401 && !this.mock) { this.tok = null; continue; }
      if (r.status === 429 || r.status >= 500) { await new Promise((x) => setTimeout(x, 800 * (tentativo + 1))); continue; }
      if (!r.ok) {
        let msg = r.status + '';
        try { const j = await r.json(); msg = j.error?.message || msg; } catch (e) {}
        throw new Error('Google Drive: ' + msg);
      }
      return tipo === 'json' ? r.json() : r.arrayBuffer();
    }
    throw new Error('Google Drive non risponde');
  }

  async utenteCorrente() {
    if (this.mock) return { displayName: 'Prova', emailAddress: 'prova@locale' };
    const r = await this.get('/about', { fields: 'user(displayName,emailAddress)' });
    this.utente = r.user;
    try { localStorage.setItem('vps_email', r.user.emailAddress); } catch (e) {}
    return r.user;
  }

  async elenca(q, extra = {}) {
    const out = [];
    let pageToken = null;
    do {
      const r = await this.get('/files', Object.assign({
        q, fields: `nextPageToken,files(${CAMPI})`, pageSize: 1000, orderBy: 'folder,name_natural',
        supportsAllDrives: true, includeItemsFromAllDrives: true, pageToken,
      }, extra));
      out.push(...(r.files || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out.map(risolviScorciatoia);
  }

  figli(cartellaId) { return this.elenca(`'${cartellaId}' in parents and trashed = false`); }
  condivisiConMe() { return this.elenca('sharedWithMe = true and trashed = false'); }

  async driveCondivisi() {
    const r = await this.get('/drives', { pageSize: 100, fields: 'drives(id,name)' });
    return r.drives || [];
  }

  async meta(id) { return this.get('/files/' + id, { fields: CAMPI, supportsAllDrives: true }); }

  async scarica(id) { return this.get('/files/' + id, { alt: 'media', supportsAllDrives: true }, 'bin'); }

  // Elenco di PIÙ cartelle con una sola richiesta ('a' in parents or 'b' in parents …): Map id -> [file].
  // Con 126 cartelle partita passa da 126 richieste a 4: il caricamento è molto più rapido e leggero.
  async figliDi(ids) {
    const out = new Map(ids.map((i) => [i, []]));
    if (this.pc || ids.length === 1) {
      await Promise.all(ids.map(async (id) => out.set(id, await this.figli(id))));
      return out;
    }
    const lista = await this.elenca('(' + ids.map((i) => `'${i}' in parents`).join(' or ') + ') and trashed = false');
    let senzaPadre = 0;
    for (const f of lista) {
      const padri = (f.parents || []).filter((p) => out.has(p));
      if (!padri.length) { senzaPadre++; continue; }
      for (const p of padri) out.get(p).push(f);
    }
    if (senzaPadre) {            // risposta senza l'indicazione della cartella (permessi particolari): si legge una cartella alla volta
      await Promise.all(ids.map(async (id) => out.set(id, await this.figli(id))));
    }
    return out;
  }

  // Tutti i file di una cartella e delle sue sottocartelle [{...file, rel, cartella}] (rel = percorso relativo).
  // Il risultato si tiene per un minuto: partite e video della STESSA cartella si leggono con un solo passaggio.
  alberoFile(cartellaId) {
    this._alberi = this._alberi || new Map();
    const c = this._alberi.get(cartellaId);
    if (c && Date.now() - c.t < 60000) return c.p;
    const p = this._leggiAlbero(cartellaId);
    this._alberi.set(cartellaId, { t: Date.now(), p });
    p.catch(() => this._alberi.delete(cartellaId));
    return p;
  }

  async _leggiAlbero(cartellaId, profondita = 6, perRichiesta = 40) {
    const out = [];
    let livello = [[cartellaId, '']];
    for (let d = 0; livello.length; d++) {
      const prossimo = [], gruppi = [];
      for (let i = 0; i < livello.length; i += perRichiesta) gruppi.push(livello.slice(i, i + perRichiesta));
      let k = 0;
      await Promise.all(Array.from({ length: Math.min(4, gruppi.length) }, async () => {
        while (k < gruppi.length) {
          const g = gruppi[k++];
          const m = await this.figliDi(g.map((x) => x[0]));
          for (const [id, rel] of g) {
            for (const f of m.get(id) || []) {
              if (f.mimeType === CARTELLA) { if (d < profondita) prossimo.push([f.id, rel + f.name + '/']); }
              else out.push(Object.assign({}, f, { rel: rel + f.name, cartella: rel }));
            }
          }
        }
      }));
      livello = prossimo;
    }
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    return out;
  }

  // File di una cartella e delle sue sottocartelle che soddisfano 'accetta'
  async ricorsivi(cartellaId, accetta) { return (await this.alberoFile(cartellaId)).filter(accetta); }

  // Tutti i video di una cartella e delle sue sottocartelle: [{id, name, mimeType, size, rel}]
  videoRicorsivi(cartellaId) { return this.ricorsivi(cartellaId, eVideo); }

  // Tutte le partite (.dvw) di una cartella e delle sue sottocartelle (anche una cartella per partita, come in Dvs_Video).
  // I file di backup di Data Volley («&##Backup##_…») non sono partite.
  dvwRicorsivi(cartellaId) {
    return this.ricorsivi(cartellaId, (f) => /\.dvw$/i.test(f.name) && !/^&##Backup##_/i.test(f.name));
  }

  // Cartelle del Drive (anche quelle dell'area «Computer» e quelle condivise) il cui nome contiene il testo
  async cercaCartelle(testo) {
    const t = String(testo).trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    if (!t) return [];
    return (await this.elenca(`mimeType = '${CARTELLA}' and name contains '${t}' and trashed = false`)).slice(0, 40);
  }

  // Caricamento di un file ("salva per tutti", es. associazioni video condivise)
  async caricaJson(cartellaId, nome, oggetto, idEsistente) {
    return this.caricaFile(cartellaId, nome, JSON.stringify(oggetto, null, 1), idEsistente);
  }

  // Scrive (o crea) un file di testo nella cartella: flag, traiettorie, associazioni...
  async caricaFile(cartellaId, nome, corpo, idEsistente) {
    const t = await this.token();
    const base = this.api.replace('/drive/v3', '/upload/drive/v3');
    if (idEsistente) {
      const r = await fetch(`${base}/files/${idEsistente}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, this.mock ? {} : { Authorization: 'Bearer ' + t }), body: corpo });
      return r.ok ? (await r.json()).id : null;
    }
    const meta = { name: nome, parents: [cartellaId], mimeType: 'application/json' };
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    fd.append('file', new Blob([corpo], { type: 'application/json' }));
    const r = await fetch(`${base}/files?uploadType=multipart&supportsAllDrives=true&fields=id`, { method: 'POST', headers: this.mock ? {} : { Authorization: 'Bearer ' + t }, body: fd });
    if (!r.ok) return null;
    return (await r.json()).id;
  }
}

function risolviScorciatoia(f) {
  if (f.mimeType === SCORCIATOIA && f.shortcutDetails) {
    return Object.assign({}, f, { id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType || f.mimeType, scorciatoia: true });
  }
  return f;
}

export function eVideo(f) {
  const n = (f.name || '').toLowerCase();
  return EST_VIDEO.some((e) => n.endsWith(e)) || (f.mimeType || '').startsWith('video/');
}

export function eCartella(f) { return f.mimeType === CARTELLA; }

// Sceglie le partite da copiare nel programma: salta le sedute di allenamento (nel web non c'è ancora la sezione
// Allenamenti) e, se lo stesso nome compare in più sottocartelle, tiene la prima (il nome è la chiave di flag, video e abbinamenti).
// -> { partite (in ordine alfabetico, come in Windows), doppi, allenamenti }
export function filtraPartite(lista, { includiAllenamenti = false } = {}) {
  const visti = new Set(), partite = [], doppi = [], allenamenti = [];
  for (const f of lista) {
    if (!includiAllenamenti && /allenam/i.test(f.rel || f.name)) { allenamenti.push(f.rel || f.name); continue; }
    const k = f.name.toUpperCase();
    if (visti.has(k)) { doppi.push(f.rel || f.name); continue; }
    visti.add(k); partite.push(f);
  }
  partite.sort((a, b) => a.name.toUpperCase().localeCompare(b.name.toUpperCase()));
  return { partite, doppi, allenamenti };
}

// Messaggi comprensibili per chi accede (anche per gli altri utenti, non solo per chi ha creato il programma)
export function messaggioLogin(e) {
  const m = String((e && e.message) || e || '');
  if (/access_denied/i.test(m)) return "Google ha rifiutato l'accesso: questo account non è tra gli utenti autorizzati (l'app è in fase di test) oppure i permessi non sono stati concessi. Chiedi a chi gestisce DivoArido di aggiungere la tua email, poi riprova.";
  if (/popup_closed|popup_failed|annullato/i.test(m)) return 'La finestra di Google è stata chiusa oppure bloccata dal browser. Consenti i popup per questo sito e riprova.';
  if (/invalid_client|origin_mismatch|redirect_uri/i.test(m)) return "La configurazione di Google non corrisponde a questo indirizzo: l'indirizzo della pagina non è tra le origini autorizzate del client.";
  if (/Failed to fetch|NetworkError|Impossibile caricare il login/i.test(m)) return 'Impossibile raggiungere Google: controlla la connessione a internet.';
  return m || 'Accesso non riuscito';
}

export function messaggioCartella(e, nome) {
  const m = String((e && e.message) || e || '');
  const n = nome ? `«${nome}»` : 'La cartella';
  if (/404|not found|non trovat/i.test(m)) return `${n} non esiste più oppure non è condivisa con questo account. Chiedi di condividerla con te (basta il permesso di visualizzazione), poi sceglila con Sfoglia.`;
  if (/403|forbidden|permission|insufficient/i.test(m)) return `${n}: questo account non ha il permesso di leggerla. Chiedi di condividerla con te (basta il permesso di visualizzazione), poi sceglila con Sfoglia.`;
  if (/Failed to fetch|NetworkError|non risponde/i.test(m)) return 'Google Drive non risponde: controlla la connessione a internet e riprova.';
  return `${n}: ${m}`;
}

export function idDaLink(testo) {
  const t = (testo || '').trim();
  let m = t.match(/\/folders\/([a-zA-Z0-9_-]{10,})/) || t.match(/[?&]id=([a-zA-Z0-9_-]{10,})/) || t.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(t)) return t;
  return null;
}

// ------------------------------------------------------------------------------------------
// Finestra di scelta (cartella o file video) sul Drive
// ------------------------------------------------------------------------------------------
export function sceltaDrive(drive, { titolo = 'Scegli una cartella', file = false, filtroFile = eVideo } = {}) {
  return new Promise((risolvi) => {
    const fondo = document.createElement('div');
    fondo.className = 'dlg-fondo dlg-aperto';
    fondo.innerHTML = `
      <div class="dlg dlg-drive" role="dialog" aria-modal="true">
        <div class="dlg-testa"><span class="dlg-titolo"></span><button class="dlg-x" title="Annulla">✕</button></div>
        <div class="drv-corpo">
          <nav class="drv-radici">
            <button data-r="root">📁 Il mio Drive</button>
            <button data-r="shared">👥 Condivisi con me</button>
            <button data-r="drives">🗄️ Drive condivisi</button>
            <div class="drv-cerca"><label>Cerca una cartella per nome (anche in «Computer»)</label><input type="text" placeholder="es. Dvs_Video"><button class="drv-cerca-vai">Cerca</button></div>
            <div class="drv-link"><label>Oppure incolla il link della cartella</label><input type="text" placeholder="https://drive.google.com/drive/folders/…"><button class="drv-vai">Apri</button></div>
          </nav>
          <section class="drv-lista">
            <div class="drv-percorso"></div>
            <div class="drv-elementi"><div class="drv-vuoto">Caricamento…</div></div>
          </section>
        </div>
        <div class="dlg-piede"><span class="drv-stato"></span><button class="btn-sec drv-annulla">Annulla</button><button class="btn-pri drv-ok" disabled></button></div>
      </div>`;
    document.body.append(fondo);
    const $ = (s) => fondo.querySelector(s);
    $('.dlg-titolo').textContent = titolo;
    const locale = !!drive.cfg.MODALITA_LOCALE;
    if (locale) {
      $('.drv-radici [data-r="root"]').textContent = '💻 Questo PC';
      $('.drv-radici [data-r="shared"]').remove(); $('.drv-radici [data-r="drives"]').remove(); $('.drv-cerca').remove();
      $('.drv-link label').textContent = 'Oppure incolla il percorso della cartella';
      $('.drv-link input').placeholder = 'C:\\Cartella\\Partite';
    }
    $('.drv-ok').textContent = file ? 'Scegli il file' : 'Usa questa cartella';
    let percorso = [];          // [{id, name}]
    let scelto = null;          // file scelto (modalità file)
    const chiudi = (v) => { fondo.remove(); risolvi(v); };
    $('.dlg-x').onclick = $('.drv-annulla').onclick = () => chiudi(null);
    fondo.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudi(null); });

    const aggiornaOk = () => {
      const corrente = percorso[percorso.length - 1];
      if (file) $('.drv-ok').disabled = !scelto;
      else $('.drv-ok').disabled = !corrente || corrente.virtuale;
      $('.drv-stato').textContent = file ? (scelto ? scelto.name : 'Seleziona un video') : (corrente && !corrente.virtuale ? 'Cartella: ' + corrente.name : '');
    };
    $('.drv-ok').onclick = () => {
      if (file) chiudi(scelto);
      else { const c = percorso[percorso.length - 1]; chiudi({ id: c.id, name: c.name }); }
    };

    const disegnaPercorso = () => {
      const p = $('.drv-percorso');
      p.replaceChildren();
      percorso.forEach((c, i) => {
        const b = document.createElement('button');
        b.textContent = c.name;
        b.onclick = () => { percorso = percorso.slice(0, i + 1); apri(); };
        p.append(b);
        if (i < percorso.length - 1) p.append(document.createTextNode(' › '));
      });
    };

    const apri = async () => {
      scelto = null;
      disegnaPercorso(); aggiornaOk();
      const box = $('.drv-elementi');
      box.innerHTML = '<div class="drv-vuoto">Caricamento…</div>';
      const c = percorso[percorso.length - 1];
      if (c.id === '__cerca') return cerca();
      let el;
      try {
        if (c.id === '__shared') el = await drive.condivisiConMe();
        else if (c.id === '__drives') el = (await drive.driveCondivisi()).map((d) => ({ id: d.id, name: d.name, mimeType: CARTELLA }));
        else el = await drive.figli(c.id);
      } catch (e) { box.innerHTML = ''; const d = document.createElement('div'); d.className = 'drv-vuoto errore'; d.textContent = messaggioCartella(e, c.name); box.append(d); return; }
      if (percorso[percorso.length - 1] !== c) return;
      const cartelle = el.filter(eCartella);
      const files = file ? el.filter((f) => !eCartella(f) && filtroFile(f)) : el.filter((f) => !eCartella(f));
      box.replaceChildren();
      if (!cartelle.length && !files.length) box.innerHTML = '<div class="drv-vuoto">Cartella vuota</div>';
      for (const f of cartelle) {
        const r = document.createElement('button');
        r.className = 'drv-el drv-cartella';
        r.textContent = '📁 ' + f.name;
        r.ondblclick = r.onclick = () => { percorso.push({ id: f.id, name: f.name }); apri(); };
        box.append(r);
      }
      for (const f of files) {
        const r = document.createElement('button');
        r.className = 'drv-el drv-file' + (file ? '' : ' muto');
        const kb = f.size ? ` · ${(f.size / 1048576).toFixed(f.size > 1048576 * 10 ? 0 : 1)} MB` : '';
        r.textContent = (eVideo(f) ? '🎬 ' : '📄 ') + f.name + kb;
        if (file) {
          r.onclick = () => { box.querySelectorAll('.drv-file').forEach((x) => x.classList.remove('sel')); r.classList.add('sel'); scelto = f; aggiornaOk(); };
          r.ondblclick = () => { scelto = f; chiudi(f); };
        }
        box.append(r);
      }
      if (!file) {
        const n = files.filter((f) => /\.dvw$/i.test(f.name)).length;
        const v = files.filter(eVideo).length;
        const info = document.createElement('div'); info.className = 'drv-info';
        info.textContent = [n ? `${n} file .dvw` : '', v ? `${v} video` : '', cartelle.length ? `${cartelle.length} sottocartelle (partite e video si cercano anche lì)` : ''].filter(Boolean).join(' · ');
        if (info.textContent) box.prepend(info);
      }
      aggiornaOk();
    };

    fondo.querySelectorAll('.drv-radici [data-r]').forEach((b) => {
      b.onclick = () => {
        const r = b.dataset.r;
        percorso = r === 'root' ? [{ id: 'root', name: locale ? 'Questo PC' : 'Il mio Drive' }] : r === 'shared' ? [{ id: '__shared', name: 'Condivisi con me', virtuale: true }] : [{ id: '__drives', name: 'Drive condivisi', virtuale: true }];
        apri();
      };
    });
    const cerca = async () => {
      const t = $('.drv-cerca input').value.trim();
      if (!t) { $('.drv-stato').textContent = 'Scrivi una parte del nome della cartella'; return; }
      percorso = [{ id: '__cerca', name: `Risultati per “${t}”`, virtuale: true }];
      disegnaPercorso(); aggiornaOk();
      const box = $('.drv-elementi'); box.innerHTML = '<div class="drv-vuoto">Ricerca…</div>';
      try {
        const trovate = await drive.cercaCartelle(t);
        if (percorso[percorso.length - 1].id !== '__cerca') return;
        box.replaceChildren();
        if (!trovate.length) { box.innerHTML = '<div class="drv-vuoto">Nessuna cartella trovata</div>'; return; }
        for (const f of trovate) {
          const r = document.createElement('button'); r.className = 'drv-el drv-cartella';
          r.textContent = '📁 ' + f.name;
          const dove = document.createElement('span'); dove.className = 'drv-dove'; r.append(dove);
          r.onclick = r.ondblclick = () => { percorso = [{ id: f.id, name: f.name }]; apri(); };
          box.append(r);
          (async () => {            // dove si trova (la cartella che la contiene), se leggibile
            try { const p = f.parents && f.parents[0] ? await drive.meta(f.parents[0]) : null; if (p && p.name) dove.textContent = '  in «' + p.name + '»'; } catch (e) {}
          })();
        }
      } catch (e) { box.innerHTML = ''; const d = document.createElement('div'); d.className = 'drv-vuoto errore'; d.textContent = messaggioCartella(e, ''); box.append(d); }
    };
    if (!locale) {          // la ricerca per nome c'è solo sul Google Drive (nel modo «cartelle del PC» il box è tolto)
      $('.drv-cerca-vai').onclick = cerca;
      $('.drv-cerca input').addEventListener('keydown', (e) => { if (e.key === 'Enter') cerca(); });
    }
    $('.drv-vai').onclick = async () => {
      const testoLink = $('.drv-link input').value.trim().replace(/^"|"$/g, '');
      const id = locale ? ('L' + btoa(unescape(encodeURIComponent(testoLink))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) : idDaLink(testoLink);
      if (!id) { $('.drv-stato').textContent = 'Link non riconosciuto'; return; }
      try { const m = await drive.meta(id); percorso = [{ id: m.id, name: m.name }]; apri(); }
      catch (e) { $('.drv-stato').textContent = e.message; }
    };
    $('.drv-link input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('.drv-vai').click(); });
    const ultima = (() => { try { return JSON.parse(localStorage.getItem('vps_ultima_cartella') || 'null'); } catch (e) { return null; } })();
    percorso = ultima && !file ? ultima : [{ id: 'root', name: locale ? 'Questo PC' : 'Il mio Drive' }];
    const salva = $('.drv-ok').onclick;
    $('.drv-ok').onclick = () => { try { if (!file) localStorage.setItem('vps_ultima_cartella', JSON.stringify(percorso.slice(0, -1).length ? percorso.slice(0, -1) : percorso)); } catch (e) {} salva(); };
    apri();
  });
}
