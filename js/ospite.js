// MODALITA' OSPITE (fase 7, 21/11/2026): chi riceve un «link per ospiti» usa DivoArido senza account Google.
//
// Il link ha la forma  https://…/#o=<codice>.  La pagina non legge il Drive con l'accesso di una persona: parla con il SERVIZIO OSPITI
// (Google Apps Script del proprietario, ospiti/Code.gs) che consegna solo cio' che quel link elenca: programma, partite (.dvw) e file
// dei dati (flag, abbinamenti). I VIDEO si leggono direttamente da Google Drive con la chiave API pubblica, perche' il servizio ha aperto
// «chiunque abbia il link» solo sui video scelti, per il tempo scelto. Allo scadere (o se il link viene revocato) il servizio non risponde
// piu' e i video tornano privati.
//
// DriveOspite ha la stessa interfaccia della classe Drive (come DrivePC), cosi' il resto della pagina non cambia.

import { Drive } from './drive.js';

const CARTELLA = 'application/vnd.google-apps.folder';
const attesa = (ms) => new Promise((x) => setTimeout(x, ms));
const daB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Codice del link dall'indirizzo (la parte dopo # non viene mai inviata ai server): null se non c'e'
export function tokenOspiteDaUrl(hash = (typeof location !== 'undefined' ? location.hash : '')) {
  const m = /(?:^#|&)o=([0-9a-f]{32})(?:&|$)/.exec(hash || '');
  return m ? m[1] : null;
}

// VIDEO DELL'OSPITE SENZA IL LETTORE (service worker). Su Safari (iPad, iPhone, Mac) il lettore non riesce a chiedere a Google i pezzi di video
// («FetchEvent.respondWith received an error: TypeError: Load failed») e negli altri browser puo' cadere dopo un po' («Failed to fetch»).
// I video dell'ospite sono pubblici (solo per la durata del link): il <video> li legge direttamente da Google con la chiave API pubblica.
// 25/11/2026. Se il file ha una «chiave di risorsa» (serve un'intestazione speciale) non e' possibile e resta il lettore.
export function eWebKit(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : ''), tocchi = (typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0)) {
  ua = String(ua || '');
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && tocchi > 1);               // iPadOS si presenta come un Mac
  const safari = /AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Android|OPR/.test(ua);
  return ios || safari;
}
export function urlVideoDiretto(api, id, dati) {
  if (!dati || !dati.key || (dati.claves && dati.claves[id])) return null;
  return `${String(api).replace(/\/$/, '')}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(dati.key)}`;
}

// Modi diretti di chiedere a Google lo stesso video (si provano in ordine finche' uno funziona): 0 = download diretto «drive.usercontent.google.com»
// (non usa la chiave API: e' quello che dal PC risponde subito e a pezzi), 1 = API con chiave pubblica, 2 = «drive.google.com/uc».
// Con una «chiave di risorsa» si aggiunge come parametro (resourcekey). Restituisce null se quel modo non e' possibile.
export function urlVideoCandidato(api, id, dati, n) {
  const rk = dati && dati.claves && dati.claves[id];
  const q = rk ? '&resourcekey=' + encodeURIComponent(rk) : '';
  if (n === 0) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t${q}`;
  if (n === 1) return urlVideoDiretto(api, id, dati);
  if (n === 2) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}&confirm=t${q}`;
  return null;
}

// Messaggi comprensibili per chi ha un link che non funziona
export function messaggioOspite(e) {
  const c = e && e.codice, m = String((e && e.message) || e || '');
  if (c === 'link_scaduto') return 'Questo link è scaduto. Chiedi a chi te l\'ha mandato di crearne uno nuovo.';
  if (c === 'link_revocato') return 'Questo link è stato annullato da chi te l\'ha mandato.';
  if (c === 'link_non_valido') return 'Questo link non è valido: controlla di averlo copiato per intero.';
  if (c === 'link_non_pronto') return 'Questo link non è ancora pronto: riprova fra qualche minuto.';
  if (c === 'occupato') return 'Il servizio è occupato in questo momento: riprova fra qualche secondo.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Impossibile raggiungere il servizio: controlla la connessione a internet e riprova.';
  return m || 'Il link non funziona';
}

// Una richiesta al servizio. Il corpo e' «text/plain» apposta: cosi' il browser non fa la richiesta preliminare (che Apps Script non gestisce).
export async function chiamaServizio(cfg, corpo, { tentativi = 2 } = {}) {
  if (!cfg.OSPITI_URL) { const e = new Error('Il servizio degli ospiti non è attivo.'); e.codice = 'servizio_assente'; throw e; }
  let ultimo = null;
  for (let i = 0; i < tentativi; i++) {
    try {
      const r = await fetch(cfg.OSPITI_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(corpo) });
      let j;
      try { j = await r.json(); } catch (x) { throw new Error('Risposta non valida dal servizio (' + r.status + ')'); }
      if (!j.ok) { const e = new Error(j.messaggio || j.errore || 'Errore del servizio'); e.codice = j.errore || 'errore'; e.definitivo = true; throw e; }
      return j;
    } catch (e) {
      ultimo = e;
      if (e.definitivo || i === tentativi - 1) break;
      await attesa(900 * (i + 1));
    }
  }
  throw ultimo;
}

export class DriveOspite extends Drive {
  constructor(cfg, codice) {
    super(cfg);
    this.ospite = true;
    this.codice = codice;
    this.utente = { displayName: 'Ospite', emailAddress: 'ospite' };
    this.info = null;
    this.sfasamento = 0;             // differenza fra l'orologio del servizio e quello di questo computer
    this._dvw = null;                // id gara -> promessa dei byte del .dvw (si scaricano tutti insieme, a gruppi)
    this._dati = null;               // elenco dei file dei dati
    this._datiBytes = new Map();
  }

  connesso() { return true; }
  async login() { return 'ospite'; }
  async token() { return null; }
  async utenteCorrente() { return this.utente; }
  async condivisiConMe() { return []; }
  async driveCondivisi() { return []; }
  async cercaCartelle() { return []; }
  async elenca() { return []; }
  async get() { const e = new Error('Non disponibile per gli ospiti'); e.codice = 'non_disponibile'; throw e; }
  async caricaFile() { return null; }               // gli ospiti non scrivono mai sul Drive
  async caricaJson() { return null; }

  chiama(corpo, opz) { return chiamaServizio(this.cfg, Object.assign({ o: this.codice }, corpo), opz); }

  // Legge dal servizio le informazioni del link (lancia un errore con «codice» se il link non e' valido, scaduto o revocato)
  async apri() {
    const r = await this.chiama({ a: 'info' });
    this.info = r;
    this.sfasamento = Number(r.ora) - Date.now();
    this.scadenza = Number(r.scadenza);
    this._dvw = null; this._dati = null; this._datiBytes.clear();
    return r;
  }

  // Controllo periodico: il link e' ancora valido? (se e' stato annullato o e' scaduto lancia l'errore con il suo «codice»)
  async controlla() {
    const r = await this.chiama({ a: 'info' }, { tentativi: 1 });
    this.scadenza = Number(r.scadenza);
    this.sfasamento = Number(r.ora) - Date.now();
    return r;
  }

  ora() { return Date.now() + this.sfasamento; }
  scaduto() { return !!this.scadenza && this.ora() >= this.scadenza; }
  secondiRimasti() { return Math.max(0, Math.floor((this.scadenza - this.ora()) / 1000)); }

  async programma() { const r = await this.chiama({ a: 'programma' }); return daB64(r.b64); }

  // ---- le «cartelle» dell'ospite: sezione gare (g) o allenamenti (a) ----
  sezioneDvw(id) {
    if (id && id === this.cfg.CARTELLA_DVW_PREDEFINITA) return 'g';
    if (id && id === this.cfg.CARTELLA_ALLEN_DVW_PREDEFINITA) return 'a';
    return null;
  }
  sezioneVideo(id) {
    if (id && id === this.cfg.CARTELLA_VIDEO_PREDEFINITA) return 'g';
    if (id && id === this.cfg.CARTELLA_ALLEN_VIDEO_PREDEFINITA) return 'a';
    return null;
  }
  gareDi(s) { return (this.info?.gare || []).filter((g) => g.s === s); }

  _non_trovata() { const e = new Error('404: non trovata'); e.codice = 'non_trovata'; return e; }

  async figli(id) {
    const cfg = this.cfg;
    if (cfg.CARTELLA_DATI && id === cfg.CARTELLA_DATI) return this._elencoDati();
    const sd = this.sezioneDvw(id), sv = this.sezioneVideo(id);
    const s = sd || sv;
    if (!s) return [];
    if (!this.gareDi(s).length) throw this._non_trovata();      // sezione non inclusa in questo link: come una cartella non condivisa
    return [];                                                  // (partite e video si leggono con dvwRicorsivi / videoRicorsivi)
  }

  async dvwRicorsivi(id) {
    const s = this.sezioneDvw(id);
    if (!s) return [];
    const quando = new Date(this.info.ora).toISOString();
    return this.gareDi(s).map((g) => ({ id: g.d, name: g.n, mimeType: 'application/octet-stream', modifiedTime: quando, rel: g.n, cartella: '' }));
  }

  async videoRicorsivi(id) {
    const s = this.sezioneVideo(id);
    if (!s) return [];
    const visti = new Set(), out = [];
    for (const g of this.gareDi(s)) {
      if (!g.v || visti.has(g.v)) continue;
      visti.add(g.v);
      const nome = (g.r || '').split('/').pop() || (g.n || '').replace(/\.dvw$/i, '') + '.mp4';
      out.push({ id: g.v, name: nome, mimeType: g.m || 'video/mp4', size: String(g.z || ''), rel: g.r || nome, cartella: '' });
    }
    return out;
  }

  async meta(id) {
    const g = (this.info?.gare || []).find((x) => x.d === id || x.v === id);
    if (g) return { id, name: g.d === id ? g.n : ((g.r || '').split('/').pop() || g.n), mimeType: g.d === id ? 'application/octet-stream' : (g.m || 'video/mp4') };
    throw this._non_trovata();
  }

  // ---- download: le partite si prendono tutte insieme (a gruppi di 12, quattro gruppi alla volta) alla prima richiesta ----
  _avviaDvw() {
    if (this._dvw) return;
    this._dvw = new Map();
    const ids = (this.info?.gare || []).map((g) => g.d);
    const risolutori = new Map();
    for (const id of ids) this._dvw.set(id, new Promise((ok, ko) => risolutori.set(id, { ok, ko })));
    for (const p of this._dvw.values()) p.catch(() => {});
    const gruppi = [];
    for (let i = 0; i < ids.length; i += 12) gruppi.push(ids.slice(i, i + 12));
    let k = 0;
    const lavoratore = async () => {
      while (k < gruppi.length) {
        const g = gruppi[k++];
        try {
          const r = await this.chiama({ a: 'dvw', ids: g });
          for (const f of r.files) risolutori.get(f.id)?.ok(daB64(f.b64).buffer);
        } catch (e) { for (const id of g) risolutori.get(id)?.ko(e); }
      }
    };
    for (let i = 0; i < Math.min(4, gruppi.length); i++) lavoratore();
  }

  async _elencoDati() {
    if (!this._dati) this._dati = this.chiama({ a: 'dati' }).then((r) => r.files.map((f) => ({ id: f.id, name: f.name, mimeType: 'application/json', size: String(f.size), modifiedTime: f.modifiedTime })));
    return this._dati;
  }

  async scarica(id) {
    if ((this.info?.gare || []).some((g) => g.d === id)) { this._avviaDvw(); return this._dvw.get(id); }
    if (!this._datiBytes.has(id)) this._datiBytes.set(id, this.chiama({ a: 'dato', id }).then((r) => daB64(r.b64).buffer));
    return this._datiBytes.get(id);
  }

  // Dati per il lettore dei video (service worker): chiave API pubblica e, se serve, le «chiavi di risorsa» dei file
  datiVideoSW() {
    const claves = {};
    for (const g of this.info?.gare || []) if (g.v && g.k) claves[g.v] = g.k;
    return { key: this.info?.chiaveApi || '', claves };
  }
}
