// Avvio della versione web di Volley Pro Suite.
import { creaMotore } from './engine.js';
import { Drive, sceltaDrive, eVideo, idDaLink, filtraPartite, messaggioLogin, messaggioCartella } from './drive.js';
import { DrivePC, sceltaPC, pcDisponibile } from './drivepc.js';
import { Video } from './video.js';
import * as UI from './ui.js';
import { determinaProfilo, apriGestione, leggiConfigProfili } from './profili.js';
import { DriveOspite, tokenOspiteDaUrl, messaggioOspite } from './ospite.js';
import { apriLinkOspiti, formatoData } from './linkospiti.js';

const CFG = window.VPS_CONFIG || {};
// MODALITA' OSPITE (link temporaneo, fase 7): l'indirizzo contiene #o=<codice>. Si lavora senza account Google e senza memoria nel browser:
// niente localStorage (alla scadenza non resta nulla), niente scritture sul Drive.
const TOKEN_OSPITE = tokenOspiteDaUrl();
const MODO_OSPITE = !!TOKEN_OSPITE;
// Profilo d'uso (completo / reader / personalizzato): lo decide determinaProfilo() dopo l'accesso. Fino ad allora tutto abilitato.
let PROFILO = { chiave: 'completo', nome: 'Completo', funzioni: null, scrive: true, gestione: false };
const $ = (s) => document.querySelector(s);
// TEMPI DI AVVIO: con «?tempi=1» nell'indirizzo, a caricamento finito compare un riquadro con i tempi di ogni fase (serve a capire dove si perde tempo).
const TEMPI = { t0: performance.now(), voci: [], dettaglio: [], attivo: /[?&]tempi=1\b/.test(location.search) };
const marca = (nome) => TEMPI.voci.push([nome, Math.round(performance.now() - TEMPI.t0)]);
const dettaglio = (nome, ms, extra) => TEMPI.dettaglio.push(`${nome}: ${(ms / 1000).toFixed(1)} s${extra ? ' (' + extra + ')' : ''}`);
function mostraTempi() {
  if (!TEMPI.attivo) return;
  let prec = 0;
  const righe = TEMPI.voci.map(([n, ms]) => { const r = `${n}: ${((ms - prec) / 1000).toFixed(1)} s (a ${(ms / 1000).toFixed(1)} s)`; prec = ms; return r; });
  const testo = 'TEMPI DI AVVIO\n' + righe.join('\n') + (TEMPI.dettaglio.length ? '\n\nDettaglio:\n' + TEMPI.dettaglio.join('\n') : '') + `\n\nPython: codice compilato ${motore && motore.pycUsato ? 'riusato' : 'ricompilato'}`;
  console.info(testo);
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:30000;background:#0b1220;color:#e2e8f0;border:1px solid #3b4a63;border-radius:8px;padding:10px 12px;font-size:12px;max-width:440px;white-space:pre-wrap;margin:0';
  d.textContent = testo; d.title = 'Clic per chiudere'; d.onclick = () => d.remove();
  document.body.append(d);
}
let motore = null;
let drive = null;
let video = null;
let coda = Promise.resolve();
let lavori = 0;

// Cartelle del Drive copiate nel file system del motore: percorso -> {id, name, kind}
const MONTAGGI = caricaJson('vps_montaggi', {});
// Video disponibili: percorso del segnaposto -> {id, name, mimeType}
const INDICE_VIDEO = new Map();

function caricaJson(k, def) { if (MODO_OSPITE) return def; try { return JSON.parse(localStorage.getItem(k) || 'null') ?? def; } catch (e) { return def; } }
function salvaJson(k, v) { if (MODO_OSPITE) return; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

// ------------------------------------------------------------------------------------------
// schermata di avvio
// ------------------------------------------------------------------------------------------
function stato(t) { const s = $('#avvio-stato'); if (s) s.textContent = t; }
function erroreAvvio(t, dettaglio) {
  $('#avvio-spinner').hidden = true;
  stato('');
  const e = $('#avvio-errore'); e.hidden = false;
  e.querySelector('.msg').textContent = t;
  e.querySelector('pre').textContent = dettaglio || '';
  e.querySelector('pre').hidden = !dettaglio;
}

async function avvio() {
  try {
    // Modalità: Google Drive oppure cartelle del PC (Chrome/Edge). Senza chiave Google si lavora sul PC.
    const soloPC = !CFG.GOOGLE_CLIENT_ID && !CFG.MOCK_DRIVE;
    const sceltaSalvata = localStorage.getItem('vps_modo') === 'pc' && pcDisponibile();
    if (MODO_OSPITE) {
      if (!CFG.OSPITI_URL) { erroreAvvio('Il servizio per gli ospiti non è ancora attivo: questo link non può essere usato.'); return; }
      drive = new DriveOspite(CFG, TOKEN_OSPITE);
      stato('Verifico il link…');
      try { await drive.apri(); } catch (e) { erroreAvvio(messaggioOspite(e)); return; }
    } else drive = (soloPC || sceltaSalvata) ? new DrivePC(CFG) : new Drive(CFG);
    // Se il programma (.py) sta sul Drive, Python si prepara subito ma il programma si legge
    // dopo l'accesso; altrimenti il caricamento parte insieme al login.
    let accesso;
    const loginFatto = new Promise((ok) => { accesso = ok; });
    const idProgramma = idDaLink(CFG.PROGRAMMA_DRIVE || '');
    const programma = (idProgramma || MODO_OSPITE) ? async () => {
      await loginFatto;
      if (drive.ospite) return await drive.programma();      // l'ospite riceve il programma dal servizio (non ha accesso al Drive)
      if (drive.pc) return new Uint8Array(await fetch('engine/volley.py', { cache: 'no-cache' }).then((r) => r.arrayBuffer()));
      return new Uint8Array(await drive.scarica(idProgramma));
    } : null;
    const pMotore = creaMotore(CFG, stato, programma, { cachePyc: !MODO_OSPITE }).then((m) => { motore = m; return m; });
    pMotore.catch(() => {});
    if (!drive.pc) await registraServiceWorker();
    if (!drive.connesso()) {
      await richiediLogin();
    }
    accesso(); marca('Accesso Google');
    $('#cambia-modo').hidden = !CFG.GOOGLE_CLIENT_ID || MODO_OSPITE;
    $('#cambia-modo').textContent = drive.pc ? '☁ Passa a Google Drive' : '💻 Usa le cartelle del PC';
    $('#cambia-modo').onclick = () => { try { localStorage.setItem('vps_modo', drive.pc ? 'google' : 'pc'); } catch (e) {} location.reload(); };
    await drive.utenteCorrente().then((u) => { $('#utente').textContent = drive.ospite ? 'Ospite' : drive.pc ? 'Cartelle del PC' : (u.emailAddress || u.displayName || ''); }).catch(() => {});
    if (!drive.pc) {
      passaTokenSW();
      drive.onToken = () => passaTokenSW();
      drive.onScaduto = () => mostraRinnovo();
    }
    stato('Preparazione del programma…');
    $('#avvio-login').hidden = true; $('#avvio-spinner').hidden = false;
    await pMotore; marca('Python e programma pronti');
    await applicaProfilo(); marca('Profilo');
    video = new Video({ elementoWidget: UI.elementoWidget, risolvi: risolviVideo, invia });
    UI.initUI({ invia, onOut: gestisciOut, video, ridisegnaTutto: () => invia({ a: 'noop' }, { tutto: true }) });
    await ripristinaImpostazioni(); marca('Partite e video letti');
    stato('Apertura…');
    const r = JSON.parse(await motore.chiama('avvia', true));
    $('#avvio').remove();
    $('#barra-sup').hidden = false;
    await applicaRisposta(r); marca('Finestra aperta'); mostraTempi();
  } catch (e) {
    console.error(e);
    erroreAvvio('Avvio non riuscito: ' + (e.message || e), e.stack || '');
  }
}

// Profilo d'uso: si decide DOPO l'accesso a Google e PRIMA che il programma apra la finestra principale (cosi' i pulsanti non abilitati non compaiono).
async function applicaProfilo() {
  stato('Verifico il tuo profilo…');
  try { PROFILO = drive.ospite ? await profiloOspite() : await determinaProfilo({ drive, CFG, motore }); } catch (e) { console.warn('profilo', e); }
  const f = PROFILO.funzioni;
  await motore.chiama('imposta_profilo', f == null ? '' : JSON.stringify({ nome: PROFILO.nome, funzioni: f }));
  const ind = $('#profilo-ind');
  if (ind) {
    ind.textContent = PROFILO.ospite ? `Ospite · accesso fino al ${formatoData(drive.scadenza)}`
      : PROFILO.chiave === 'completo' && !PROFILO.simulato ? '' : `Profilo: ${PROFILO.nome}${PROFILO.simulato ? ' (prova)' : ''}`;
    ind.title = PROFILO.incerto ? 'Non sono riuscito a verificare il tuo profilo: lavori con quello base. Ricarica la pagina (F5) per riprovare.' : '';
  }
  const g = $('#gest-profili');
  if (g) { g.hidden = !PROFILO.gestione; g.onclick = () => apriGestione({ drive, CFG, profilo: PROFILO, messaggio: (t) => avviso(t) }); }
  if (PROFILO.incerto) setTimeout(() => avviso('Non sono riuscito a verificare il tuo profilo: lavori con quello base. Ricarica la pagina (F5) per riprovare.'), 1500);
  if (drive.ospite) avviaControlloOspite(); else preparaLinkOspiti();
}

// ------------------------------------------------------------------------------------------
// ospiti (fase 7): profilo dell'ospite, controllo della scadenza e pulsante «Link ospiti» del proprietario
// ------------------------------------------------------------------------------------------
// Funzioni che l'ospite non ha mai, qualunque sia il profilo del link: servono un accesso Google o scrivono sul Drive.
const FUNZIONI_NO_OSPITE = ['cartelle', 'associa_video', 'loghi', 'salva'];
async function profiloOspite() {
  let elenco = [];
  try { elenco = JSON.parse(await motore.chiama('profilo_funzioni')); } catch (e) { console.warn('profilo_funzioni', e); }
  const tutte = elenco.map((x) => x[0]);
  const f = ((drive.info.profilo && drive.info.profilo.funzioni) || []).filter((k) => tutte.includes(k) && !FUNZIONI_NO_OSPITE.includes(k));
  return { chiave: 'ospite', nome: 'Ospite', funzioni: elenco.length ? f : null, scrive: false, gestione: false, proprietario: false, incerto: false,
           ospite: true, tutte, elenco, config: null, idConfig: null, personalizzati: [] };
}

function chiudiOspite(testo) {
  try { for (const p of (video && video.players ? video.players.values() : [])) { if (p.video) { p.video.pause(); p.video.removeAttribute('src'); p.video.load(); } } } catch (e) {}
  try { navigator.serviceWorker?.controller?.postMessage({ tipo: 'ospite', key: '', claves: {} }); } catch (e) {}
  window.onbeforeunload = null;
  document.body.className = '';
  document.body.replaceChildren();
  const d = document.createElement('div'); d.className = 'ospite-fine';
  const t = document.createElement('h2'); t.textContent = 'Accesso terminato';
  const p = document.createElement('p'); p.textContent = testo;
  d.append(t, p); document.body.append(d);
}

function avviaControlloOspite() {
  let fermo = false;
  const ferma = (testo) => { if (fermo) return; fermo = true; chiudiOspite(testo); };
  setInterval(() => { if (drive.scaduto()) ferma(messaggioOspite({ codice: 'link_scaduto' })); }, 15000);
  setInterval(async () => {                          // ogni 2 minuti: il link potrebbe essere stato annullato dal proprietario
    try { await drive.controlla(); }
    catch (e) { if (e && /^link_/.test(e.codice || '')) ferma(messaggioOspite(e)); }
  }, 120000);
}

// Il pulsante «Link ospiti» lo vede solo il proprietario (chi possiede la cartella dei dati sul Drive) e solo se il servizio e' attivo
async function eProprietario() {
  if (CFG.MODALITA_LOCALE || drive.mock) return new URLSearchParams(location.search).get('ospiti') === '1';        // solo per le prove
  const id = CFG.CARTELLA_DATI || CFG.CARTELLA_PROFILI;
  if (!id) return false;
  try { const m = await drive.get('/files/' + id, { fields: 'ownedByMe', supportsAllDrives: true }); return !!m.ownedByMe; } catch (e) { return false; }
}

async function preparaLinkOspiti() {
  const b = $('#link-ospiti');
  if (!b || !CFG.OSPITI_URL || drive.pc || drive.ospite) return;
  if (!(await eProprietario())) return;
  b.hidden = false;
  b.onclick = async () => {
    b.disabled = true;
    try {
      const elenco = PROFILO.elenco || [];
      const profili = [{ id: 'reader', nome: 'Reader', funzioni: elenco.filter((e) => e[2]).map((e) => e[0]) }];
      try { for (const p of (await leggiConfigProfili(drive, CFG)).cfg.profili) profili.push({ id: p.id, nome: p.nome, funzioni: p.funzioni || [] }); } catch (e) { console.warn('profili personalizzati non letti', e); }
      const gare = await raccogliGare();
      apriLinkOspiti({ drive, CFG, elementi: () => gare, profili, messaggio: (t) => avviso(t) });
    } finally { b.disabled = false; }
  };
}

// Le gare e le sedute caricate (con il loro video, se abbinato): servono a scegliere cosa mostrare con un link
// Copie leggere (720p) dei video, in una cartella parallela del Drive («Video gare web», una sottocartella per gara, file «<nome> (web).mp4»).
// Se per un video esiste la copia, il link per gli ospiti usa quella: pesa circa un quarto, parte subito e non esaurisce il limite di scarico di Google.
async function copieWeb() {
  const m = new Map();
  if (!CFG.CARTELLA_VIDEO_WEB || drive.pc) return m;
  try { for (const v of await drive.videoRicorsivi(CFG.CARTELLA_VIDEO_WEB)) m.set(v.name.toLowerCase(), v); }
  catch (e) { console.warn('copie leggere non lette', e); }
  return m;
}
const nomeCopiaWeb = (nome) => nome.replace(/\.[^.\/]+$/, '').toLowerCase() + ' (web).mp4';

async function raccogliGare() {
  const imp = await leggiImpostazioniMotore();
  const vm = imp.video_map || {};
  const web = await copieWeb();
  const out = [];
  for (const [, d] of DVW_ID) {
    const o = INDICE_VIDEO.get(vm[d.nome]);
    const c = o ? web.get(nomeCopiaWeb(o.name)) : null;
    const v = c || o;
    out.push({ n: d.nome, d: d.id, s: d.allen ? 'a' : 'g', v: v ? v.id : null, r: v ? (v.rel || v.name) : '', m: v ? (v.mimeType || '') : '', z: v ? Number(v.size) || 0 : 0, web: !!c, zo: o ? Number(o.size) || 0 : 0 });
  }
  out.sort((a, b) => (a.s === b.s ? 0 : a.s === 'g' ? -1 : 1) || a.n.localeCompare(b.n));
  return out;
}

let avvisoFlagFatto = false;
function avvisoFlagNonSalvati() {
  if (avvisoFlagFatto) return;
  avvisoFlagFatto = true;
  messaggio('info', 'Flag non salvate', `Il tuo profilo (${PROFILO.nome}) non salva sul Drive: le flag che inserisci valgono solo finché questa pagina resta aperta.`);
}

function richiediLogin() {
  return new Promise((ok) => {
    $('#avvio-spinner').hidden = true;
    stato('');
    const box = $('#avvio-login'); box.hidden = false;
    const b = box.querySelector('button');
    const bPC = box.querySelector('.btn-pc');
    bPC.hidden = false;
    bPC.onclick = () => {                      // alternativa al Google Drive: cartelle del PC
      if (!pcDisponibile()) { box.querySelector('.err').textContent = 'Per usare le cartelle del PC serve Chrome o Edge su computer.'; return; }
      try { localStorage.setItem('vps_modo', 'pc'); } catch (e) {}
      drive = new DrivePC(CFG);
      ok();
    };
    b.onclick = async () => {
      b.disabled = true;
      box.querySelector('.err').textContent = '';
      try { await drive.login(localStorage.getItem('vps_email') ? '' : 'consent'); ok(); }
      catch (e) { box.querySelector('.err').textContent = messaggioLogin(e); b.disabled = false; }
    };
  });
}

function mostraRinnovo() {
  const b = $('#rinnova'); b.hidden = false;
  b.onclick = async () => { try { await drive.login(''); b.hidden = true; } catch (e) {} };
}

// ------------------------------------------------------------------------------------------
// service worker (streaming video)
// ------------------------------------------------------------------------------------------
// Dopo Ctrl+F5 (ricaricamento forzato) il browser carica la pagina SENZA il lettore dei video (service worker): i video non
// partirebbero. Se all'avvio il lettore c'e' ma la pagina non e' sotto il suo controllo, si fa UN ricaricamento normale
// (protetto contro i cicli: al massimo uno al minuto) che la riporta sotto controllo. All'avvio non c'e' ancora nulla da perdere.
async function assicuraControlloSW() {
  if (navigator.serviceWorker.controller) return;
  // prima installazione: il lettore prende il controllo da solo, di solito entro pochi istanti
  await new Promise((ok) => {
    const t = setTimeout(ok, 1500);
    navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); ok(); }, { once: true });
  });
  if (navigator.serviceWorker.controller) return;
  const k = 'vps_sw_ricarica', ora = Date.now();
  let ultimo = 0;
  try { ultimo = Number(sessionStorage.getItem(k)) || 0; } catch (e) { return; }
  if (ora - ultimo < 60000) return;
  try { sessionStorage.setItem(k, String(ora)); } catch (e) { return; }
  location.reload();
  await new Promise(() => {});      // la pagina sta per essere ricaricata: si ferma qui l'avvio
}

async function registraServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    await assicuraControlloSW();
    navigator.serviceWorker.addEventListener('message', async (e) => {
      if (e.data && e.data.tipo === 'serve-token') {
        let t = null;
        try { t = e.data.rinnova ? await drive.login('') : await drive.token(); } catch (err) { mostraRinnovo(); }
        e.ports[0]?.postMessage({ token: t, api: apiAssoluta(), ospite: drive.ospite ? drive.datiVideoSW() : null });
      }
    });
  } catch (e) { console.warn('Service worker non disponibile', e); }
}

function apiAssoluta() { return new URL(drive.api, location.href).href.replace(/\/$/, ''); }

async function passaTokenSW() {
  if (drive.pc) return;
  const reg = await navigator.serviceWorker?.ready;
  if (drive.ospite) {            // l'ospite non ha un token Google: il lettore dei video usa la chiave API pubblica
    const m = Object.assign({ tipo: 'ospite', api: apiAssoluta() }, drive.datiVideoSW());
    reg?.active?.postMessage(m); navigator.serviceWorker?.controller?.postMessage(m);
    return;
  }
  const t = await drive.token().catch(() => null);
  reg?.active?.postMessage({ tipo: 'token', token: t, api: apiAssoluta() });
  navigator.serviceWorker?.controller?.postMessage({ tipo: 'token', token: t, api: apiAssoluta() });
}

function risolviVideo(path) {
  const v = INDICE_VIDEO.get(path);
  if (!v) return null;
  if (drive.ospite && drive.scaduto()) return null;
  // cartelle del PC: il video si legge dal disco tramite un indirizzo blob: (risposta asincrona)
  if (drive.pc) return drive.urlVideo(v.id).then((url) => ({ url, nome: v.name }));
  // prova sul PC (avvia_locale): il server locale risponde già a pezzi (Range), non serve il service worker
  if (CFG.MODALITA_LOCALE) return { url: apiAssoluta() + '/files/' + encodeURIComponent(v.id) + '?alt=media', nome: v.name };
  if (!navigator.serviceWorker?.controller) {
    // pagina non ancora controllata dal service worker (primo caricamento): basta ricaricare
    avviso('Per vedere i video serve ricaricare la pagina una volta (F5).');
  }
  return { url: '__drive__/' + encodeURIComponent(v.id), nome: v.name };
}

// ------------------------------------------------------------------------------------------
// comunicazione con il motore
// ------------------------------------------------------------------------------------------
function invia(azione, opz = {}) {
  coda = coda.then(async () => {
    if (!opz.silenzioso) occupato(+1);
    try {
      const vars = UI.variabiliPendenti();
      const a = Object.assign({}, azione, { vars });
      let r = JSON.parse(await motore.chiama('azione', JSON.stringify(a)));
      UI.svuotaPendenti(vars);
      if (opz.tutto) r = JSON.parse(await motore.chiama('tutto'));
      await applicaRisposta(r);
    } catch (e) {
      console.error(e);
      mostraErrore('Errore interno della pagina', String(e.stack || e));
    } finally {
      if (!opz.silenzioso) occupato(-1);
    }
  });
  return coda;
}

function occupato(d) {
  lavori += d;
  clearTimeout(occupato._t);
  if (lavori > 0) occupato._t = setTimeout(() => document.body.classList.add('occupato'), 250);
  else document.body.classList.remove('occupato');
}

async function applicaRisposta(r) {
  if (r.styles) { window.__TK_STYLES__ = r.styles; window.__TK_STYLE_MAPS__ = r.stylemaps; }
  UI.applica(r);
  video?.riaggancia();
  if (r.impostazioni != null) salvaImpostazioni(r.impostazioni);
  for (const f of r.salva || []) salvaDato(f.path, f.testo);
  for (const f of r.files || []) scaricaFile(f.name, f.b64);
}

const DIALOGHI = [];
function gestisciOut(o) {
  switch (o.t) {
    case 'msg': messaggio(o.kind, o.title, o.text); break;
    case 'error': mostraErrore('Errore nel programma', o.text); break;
    case 'player': video.comando(o); break;
    case 'dialog': DIALOGHI.push(o); if (DIALOGHI.length === 1) setTimeout(prossimoDialogo, 0); break;
    case 'clipboard': navigator.clipboard?.writeText(o.text).catch(() => {}); break;
    default: console.log('uscita non gestita', o);
  }
}

async function prossimoDialogo() {
  const o = DIALOGHI[0];
  if (!o) return;
  let valore = '';
  try {
    if (o.kind === 'askdirectory') valore = await dialogoCartella(o.opts || {});
    else if (o.kind === 'askopenfilename') valore = await dialogoFileVideo(o.opts || {});
    else if (o.kind === 'ask') valore = await domanda(o.opts.title, o.opts.message);
    else valore = '';
  } catch (e) {
    mostraErrore('Google Drive', String(e.message || e));
    valore = '';
  }
  DIALOGHI.shift();
  await invia(Object.assign({}, o.azione, { risposta: { kind: o.kind, value: valore ?? '' } }));
  if (DIALOGHI.length) prossimoDialogo();
}

// ------------------------------------------------------------------------------------------
// cartelle del Drive -> file system del motore
// ------------------------------------------------------------------------------------------
const DOVE = () => ((CFG.MODALITA_LOCALE || (drive && drive.pc)) ? ' — cartelle del PC' : ' — Google Drive');
// File di dati scritti dal programma nella cartella delle partite (flag, traiettorie...): si copiano
// all'apertura e si riscrivono nella cartella vera (Drive o PC) ogni volta che il programma li modifica.
// (dal 21/11/2026 i file si chiamano DivoArido_*.json: i vecchi VolleyProSuite_*.json si leggono ancora e il programma li rinomina da solo)
const DATI_CARTELLA = /^(?:DivoArido|VolleyProSuite)_[^/]*\.json$/i;
// Cartella dei dati del programma nel file system del motore: dal 21/11/2026 si chiama DivoArido (prima VolleyProSuite). Si scrivono entrambe
// finché il programma sul Drive e la pagina possono essere di versioni diverse (cache del browser ~10 minuti); si legge prima la nuova.
const DIR_DATI = () => motore.root + '/appdata/DivoArido';
const DIR_DATI_VECCHIA = () => motore.root + '/appdata/VolleyProSuite';
async function leggiImpostazioniMotore() {
  for (const dir of [DIR_DATI(), DIR_DATI_VECCHIA()]) {
    try { return JSON.parse(decodeURIComponent(escape(atob(await motore.chiama('fs_leggi', dir + '/impostazioni.json'))))); } catch (e) {}
  }
  return {};
}
async function scriviImpostazioniMotore(imp) {
  const testo = JSON.stringify(imp, null, 1);
  for (const dir of [DIR_DATI(), DIR_DATI_VECCHIA()]) await motore.chiama('fs_scrivi_testo', dir + '/impostazioni.json', testo);
}
const FILE_DATI = new Map();   // percorso nel motore -> {cartellaId, nome, id}

// Cartella dove il programma legge e scrive i propri dati (flag, traiettorie, abbinamenti partita↔video). Se in config.js c'è
// CARTELLA_DATI (solo con il Google Drive) sono lì, separati dalle partite e dai video: così la cartella di Data Volley
// (es. Dvs_Video sincronizzata) non si riempie di file del programma e si possono dare permessi diversi (partite: sola lettura;
// dati: modifica). Altrimenti restano nella cartella delle partite, come nel programma per Windows.
function cartellaDati(m) { return (drive && !drive.pc && !CFG.MODALITA_LOCALE && CFG.CARTELLA_DATI) || m.id; }

function nomeSicuro(n) { return String(n).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'cartella'; }

function percorsoPer(item, kind) {
  for (const [p, m] of Object.entries(MONTAGGI)) if (m.id === item.id && m.kind === kind) return p;
  // partite e video della STESSA cartella (es. Dvs_Video) hanno percorsi interni distinti: altrimenti i video svuoterebbero le partite
  const base = motore.root + (kind === 'file' ? '/Drive/_video_scelti/' : '/Drive/') + nomeSicuro(item.name) + (kind === 'video' ? ' (video)' : '');
  let p = base, k = 2;
  while (MONTAGGI[p] && MONTAGGI[p].id !== item.id) p = `${base} (${k++})`;
  return p;
}

async function dialogoCartella(opts) {
  const perVideo = /video/i.test(opts.title || '');
  const allen = /allenament|sedut/i.test(opts.title || '');          // sezione Allenamenti (il programma lo scrive nel titolo)
  const c = drive.pc
    ? await sceltaPC(drive, { titolo: opts.title || 'Scegli una cartella', tipo: perVideo ? 'video' : 'dvw' })
    : await sceltaDrive(drive, { titolo: (opts.title || 'Scegli una cartella') + DOVE() });
  if (!c) return '';
  try {
    const p = perVideo ? await montaVideo(c, false, allen) : await montaDvw(c, false, allen);
    await iniettaAssociazioni();
    return p;
  } catch (e) {
    console.warn('cartella non letta', c, e);
    avviso(messaggioCartella(e, c.name));
    return '';
  }
}

// Aggiunge alle impostazioni del programma gli abbinamenti partita↔video salvati da altri
// utenti (file condiviso nella cartella delle partite), per le partite ancora senza video.
async function iniettaAssociazioni() {
  const haAssoc = Object.keys(ASSOC.perCartella).length && INDICE_VIDEO.size;
  const haImpDrive = IMPD.pronto && !IMPD.applicato;
  if (!haAssoc && !haImpDrive) return;
  const imp = await leggiImpostazioniMotore();
  const prima = JSON.stringify(imp);
  if (haAssoc) await applicaAssociazioniCondivise(imp);
  await applicaImpostazioniDrive(imp);
  if (JSON.stringify(imp) !== prima) await scriviImpostazioniMotore(imp);
}

// La finestra di scelta del video si apre già nella cartella dei video (es. Dvs_Video, che sfogliando da «Il mio Drive» non si
// trova perché sta nell'area «Computer») e permette di cercare il video per nome in tutte le sue sottocartelle.
function impostazioniScelta() {
  if (CFG.MODALITA_LOCALE || (drive && drive.pc)) return {};
  const e = Object.entries(MONTAGGI).find(([, m]) => m.kind === 'video' && !String(m.id).startsWith('P:'));
  if (!e) return {};
  const inizio = { id: e[1].id, name: e[1].name };
  return { inizio, cercaVideo: () => drive.videoRicorsivi(inizio.id) };
}

// Immagine (es. logo di una squadra) scelta dal computer dell'utente: si copia nel file system del programma e si restituisce
// il percorso, come se fosse un file del disco (il programma la legge con Pillow e la riduce a 120 px).
const eDialogoImmagine = (opts) => /\.(png|jpe?g)\b/i.test(JSON.stringify((opts && opts.filetypes) || '')) && !/video/i.test(opts.title || '');
function dialogoFileImmagine(opts) {
  return new Promise((ok) => {
    document.getElementById('vps-file-immagine')?.remove();
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.id = 'vps-file-immagine'; inp.hidden = true;
    document.body.append(inp);
    let finito = false;
    const fine = (v) => { if (finito) return; finito = true; inp.remove(); ok(v || ''); };
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return fine('');
      try {
        const p = motore.root + '/Drive/_immagini_scelte/' + nomeSicuro(f.name);
        await motore.scriviFile(p, new Uint8Array(await f.arrayBuffer()));
        fine(p);
      } catch (e) { mostraErrore('Immagine', String((e && e.message) || e)); fine(''); }
    });
    inp.addEventListener('cancel', () => fine(''));
    inp.click();
  });
}

async function dialogoFileVideo(opts) {
  if (eDialogoImmagine(opts)) return dialogoFileImmagine(opts);
  const f = drive.pc
    ? await sceltaPC(drive, { titolo: opts.title || 'Scegli il video', file: true })
    : await sceltaDrive(drive, Object.assign({ titolo: (opts.title || 'Scegli il video') + DOVE(), file: true, filtroFile: eVideo }, impostazioniScelta()));
  if (!f) return '';
  const p = percorsoPer(f, 'file').replace(/\/[^/]*$/, '/') + nomeSicuro(f.name);
  MONTAGGI[p] = { id: f.id, name: f.name, kind: 'file' };
  salvaJson('vps_montaggi', MONTAGGI);
  INDICE_VIDEO.set(p, { id: f.id, name: f.name, mimeType: f.mimeType });
  await motore.chiama('fs_segnaposto', JSON.stringify([p]));
  return p;
}

const CACHE_DVW = 'vps-dvw-v1';
// Partite e sedute caricate: «g|nome» -> {nome, id, allen}. Servono al proprietario per scegliere cosa mostrare con un link per ospiti.
const DVW_ID = new Map();
async function scaricaConCache(f) {
  if (drive.ospite) return new Uint8Array(await drive.scarica(f.id));         // l'ospite non lascia nulla nella memoria del browser
  const chiave = new URL(`./__cache_dvw__/${f.id}/${encodeURIComponent(f.modifiedTime || '')}`, location.href).href;
  let cache = null;
  try { cache = await caches.open(CACHE_DVW); } catch (e) {}
  if (cache) {
    const r = await cache.match(chiave);
    if (r) return new Uint8Array(await r.arrayBuffer());
  }
  const buf = await drive.scarica(f.id);
  if (cache) { try { await cache.put(chiave, new Response(buf)); } catch (e) {} }
  return new Uint8Array(buf);
}

// Nomi dei file .dvw copiati nella sezione Allenamenti (servono a distinguere i loro abbinamenti video da quelli delle gare).
const NOMI_ALLEN = new Set();
// Nella sezione Allenamenti i file di dati (flag, traiettorie) stanno nella stessa cartella dati delle gare ma con questo prefisso:
// stesso nome = si sovrascriverebbero a vicenda.
const PREF_DATI_ALLEN = 'Allenamenti_';

async function montaDvw(cartella, silenzioso, allen) {
  const tIni = performance.now(); let nDvw = 0;
  const path = percorsoPer(cartella, 'dvw');
  if (!silenzioso) avvisoLungo(`Copio ${allen ? 'le sedute' : 'le partite'} da “${cartella.name}”…`);
  try {
    const figli = await drive.figli(cartella.id);        // i dati (flag, traiettorie, associazioni) stanno nella cartella scelta
    // le partite si cercano nella cartella e nelle sue sottocartelle (anche una cartella per partita);
    // le sedute di allenamento: solo i file con @ nel nome (corretti e associati al video), come nel programma per Windows
    let elencoDvw = await drive.dvwRicorsivi(cartella.id);
    elencoDvw = elencoDvw.filter((f) => f.name.includes('@'));      // gare e sedute: solo i file con @ nel nome (gli altri non sono ancora attendibili per lo studio)
    const { partite: dvw, doppi, allenamenti } = filtraPartite(elencoDvw, { includiAllenamenti: !!allen || !!CFG.INCLUDI_ALLENAMENTI });
    if (allen) for (const f of dvw) NOMI_ALLEN.add(f.name);
    for (const f of dvw) DVW_ID.set((allen ? 'a|' : 'g|') + f.name, { nome: f.name, id: f.id, allen: !!allen });
    if (doppi.length) console.warn('Partite con lo stesso nome in più sottocartelle, ignorate:', doppi);
    const note = [];
    if (allenamenti.length) note.push(`${allenamenti.length} sedute di allenamento non incluse (nel web non c'è ancora la sezione Allenamenti)`);
    if (doppi.length) note.push(`${doppi.length} partite con un nome già presente in un'altra sottocartella non sono state caricate`);
    if (note.length && !silenzioso) avviso(note.join(' · '));
    nDvw = dvw.length;
    const tElenco = performance.now() - tIni;
    await motore.chiama('fs_svuota', path);
    let fatti = 0;
    // download in parallelo, scrittura nell'ordine alfabetico (come in Windows)
    const dati = new Array(dvw.length);
    let k = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (k < dvw.length) { const i = k++; dati[i] = await scaricaConCache(dvw[i]); fatti++; if (!silenzioso) avvisoLungo(`Copio le partite da “${cartella.name}”… ${fatti}/${dvw.length}`); }
    }));
    for (let i = 0; i < dvw.length; i++) await motore.scriviFile(path + '/' + dvw[i].name, dati[i]);
    const idDati = cartellaDati(cartella);
    let figliDati = figli;
    if (idDati !== cartella.id) {
      try { figliDati = await drive.figli(idDati); }
      catch (e) { console.warn('cartella dei dati non letta', e); figliDati = []; if (!silenzioso) avviso('Non riesco a leggere la cartella dei dati del programma (flag e abbinamenti): ' + messaggioCartella(e, 'dei dati')); }
    }
    const rxDati = allen ? new RegExp('^' + PREF_DATI_ALLEN + '((?:DivoArido|VolleyProSuite)_[^/]*\\.json)$', 'i') : DATI_CARTELLA;
    for (const f of figliDati.filter((x) => rxDati.test(x.name) && !/backup/i.test(x.name))) {
      const locale = allen ? f.name.slice(PREF_DATI_ALLEN.length) : f.name;
      try {
        await motore.scriviFile(path + '/' + locale, new Uint8Array(await drive.scarica(f.id)));
        FILE_DATI.set(path + '/' + locale, { cartellaId: idDati, nome: f.name, id: f.id });
      } catch (e) { console.warn('dati non letti', f.name, e); }
    }
    try { await leggiImpostazioniDrive(figliDati, idDati); } catch (e) { console.warn('impostazioni del Drive non lette', e); }
    await motore.chiama('dati_base');
    dettaglio((allen ? 'Sedute ' : 'Partite ') + cartella.name, performance.now() - tIni, `${nDvw} file; elenco ${(tElenco / 1000).toFixed(1)} s`);
    MONTAGGI[path] = { id: cartella.id, name: cartella.name, kind: 'dvw' };
    if (allen) MONTAGGI[path].sez = 'allen';
    salvaJson('vps_montaggi', MONTAGGI);
    await leggiAssociazioniCondivise(cartella, path, figliDati, allen);
    return path;
  } finally { if (!silenzioso) avvisoLungo(null); }
}

async function montaVideo(cartella, silenzioso, allen) {
  const tIni = performance.now();
  const path = percorsoPer(cartella, 'video');
  if (!silenzioso) avvisoLungo(`Leggo l'elenco dei video in “${cartella.name}”…`);
  try {
    const vids = await drive.videoRicorsivi(cartella.id);
    const lista = [];
    for (const v of vids) {
      const p = path + '/' + v.rel.split('/').map(nomeSicuro).join('/');
      INDICE_VIDEO.set(p, { id: v.id, name: v.name, mimeType: v.mimeType, size: v.size, rel: v.rel });
      lista.push(p);
    }
    await motore.chiama('fs_svuota', path);
    await motore.chiama('fs_segnaposto', JSON.stringify(lista));
    dettaglio('Video ' + cartella.name, performance.now() - tIni, `${lista.length} video`);
    MONTAGGI[path] = { id: cartella.id, name: cartella.name, kind: 'video' };
    if (allen) MONTAGGI[path].sez = 'allen';
    salvaJson('vps_montaggi', MONTAGGI);
    return path;
  } finally { if (!silenzioso) avvisoLungo(null); }
}

// Al riavvio: le cartelle usate l'ultima volta vengono ricopiate dal Drive (aggiornate), così
// la finestra di avvio le propone già pronte, come nel programma per Windows.
async function ripristinaImpostazioni() {
  const testo = caricaJson('vps_impostazioni', null);
  let imp = {};
  try { imp = testo ? JSON.parse(testo) : {}; } catch (e) { imp = {}; }
  const daMontare = [];
  // se sono cambiate le cartelle predefinite (config.js: REV_CARTELLE_PREDEFINITE) si dimenticano, una sola volta, quelle ricordate
  if (CFG.REV_CARTELLE_PREDEFINITE && !(drive && drive.pc) && !CFG.MODALITA_LOCALE && !MODO_OSPITE) {
    try {
      if (localStorage.getItem('vps_predef') !== String(CFG.REV_CARTELLE_PREDEFINITE)) {
        delete imp.cartella_dvw; delete imp.cartella_video; delete imp.allen_cartella_dvw; delete imp.allen_cartella_video;
        localStorage.setItem('vps_predef', String(CFG.REV_CARTELLE_PREDEFINITE));
      }
    } catch (e) {}
  }
  // le cartelle ricordate valgono solo per la modalità in uso (Drive o PC)
  const compat = (m) => !!(drive && drive.pc) === String(m.id).startsWith('P:');
  // (le voci 'allen_…' sono quelle della sezione Allenamenti)
  for (const k of ['cartella_dvw', 'cartella_video', 'allen_cartella_dvw', 'allen_cartella_video']) {
    const p = imp[k];
    if (p && MONTAGGI[p] && compat(MONTAGGI[p])) daMontare.push([p, MONTAGGI[p]]);
    else if (p && MONTAGGI[p]) delete imp[k];
  }
  // cartelle proposte al primo avvio (solo con il Google Drive vero: non hanno senso con le cartelle del PC)
  const conDrive = !(drive && drive.pc) && (MODO_OSPITE || !CFG.MODALITA_LOCALE || !!CFG.PROVA_PREDEFINITE_LOCALI);
  if (conDrive && !imp.cartella_dvw && CFG.CARTELLA_DVW_PREDEFINITA) daMontare.push([null, { id: CFG.CARTELLA_DVW_PREDEFINITA, name: CFG.NOME_CARTELLA_DVW || 'Partite', kind: 'dvw' }]);
  if (conDrive && !imp.cartella_video && CFG.CARTELLA_VIDEO_PREDEFINITA) daMontare.push([null, { id: CFG.CARTELLA_VIDEO_PREDEFINITA, name: CFG.NOME_CARTELLA_VIDEO || 'Video', kind: 'video' }]);
  if (conDrive && !imp.allen_cartella_dvw && CFG.CARTELLA_ALLEN_DVW_PREDEFINITA) daMontare.push([null, { id: CFG.CARTELLA_ALLEN_DVW_PREDEFINITA, name: CFG.NOME_CARTELLA_ALLEN_DVW || 'Allenamenti', kind: 'dvw', sez: 'allen' }]);
  if (conDrive && !imp.allen_cartella_video && CFG.CARTELLA_ALLEN_VIDEO_PREDEFINITA) daMontare.push([null, { id: CFG.CARTELLA_ALLEN_VIDEO_PREDEFINITA, name: CFG.NOME_CARTELLA_ALLEN_VIDEO || 'Allenamenti - video', kind: 'video', sez: 'allen' }]);
  for (const [p, m] of daMontare) {
    const allen = m.sez === 'allen';
    try {
      stato(m.kind === 'video' ? `Leggo l'elenco dei video (${m.name})…` : `Copio ${allen ? 'le sedute' : 'le partite'} (${m.name})…`);
      const nuovo = m.kind === 'video' ? await montaVideo({ id: m.id, name: m.name }, true, allen) : await montaDvw({ id: m.id, name: m.name }, true, allen);
      if (!p) imp[(allen ? 'allen_' : '') + (m.kind === 'video' ? 'cartella_video' : 'cartella_dvw')] = nuovo;
    } catch (e) {
      console.warn('cartella non più disponibile', m, e);
      // la cartella degli allenamenti proposta in automatico, se non è condivisa con questo account, semplicemente non compare (niente avviso)
      // (lo stesso per l'ospite: le sezioni non incluse nel suo link semplicemente non compaiono)
      if (!MODO_OSPITE && !(allen && !p && /404|403|not found|non trovat|forbidden|permission|insufficient/i.test(String((e && e.message) || e)))) avviso(messaggioCartella(e, m.name));
    }
  }
  // video scelti a mano in passato
  const singoli = Object.entries(MONTAGGI).filter(([, m]) => m.kind === 'file' && compat(m));
  if (singoli.length) {
    for (const [p, m] of singoli) INDICE_VIDEO.set(p, { id: m.id, name: m.name });
    await motore.chiama('fs_segnaposto', JSON.stringify(singoli.map(([p]) => p)));
  }
  const vm = imp.video_map || {};
  await applicaAssociazioniCondivise(imp);
  await applicaImpostazioniDrive(imp);
  if (Object.keys(imp).length || Object.keys(vm).length) await scriviImpostazioniMotore(imp);
  programmaSalvataggioImp(imp);      // prima volta: copia sul Drive quanto era già nel browser
}

// ------------------------------------------------------------------------------------------
// associazioni video condivise (file nella cartella delle partite sul Drive)
// ------------------------------------------------------------------------------------------
// Ogni utente salva i propri abbinamenti in "volleyprosuite_video (email).json" nella cartella
// delle partite; leggendo si uniscono quelli di tutti (il proprio file ha la precedenza).
// (dal 21/11/2026 i file si chiamano «divoarido_video (email).json»; i vecchi «volleyprosuite_video (email).json» si leggono ancora e restano dove sono)
const PREF_ASSOC = 'divoarido_video';
const PREF_ASSOC_ALLEN = 'divoarido_allen_video';       // sezione Allenamenti: file proprio (stessa cartella dati, nome diverso)
const PREF_ASSOC_VECCHIO = 'volleyprosuite_video';
const PREF_ASSOC_ALLEN_VECCHIO = 'volleyprosuite_allen_video';
const ASSOC = { perCartella: {} };   // id cartella dvw -> {fileId (mio), map: {nome dvw: {id, name}}}

function emailAssoc() { return (drive.utente && drive.utente.emailAddress) || localStorage.getItem('vps_email') || 'utente'; }
function mioNomeAssoc(allen) { return `${allen ? PREF_ASSOC_ALLEN : PREF_ASSOC} (${emailAssoc()}).json`; }
function mioNomeAssocVecchio(allen) { return `${allen ? PREF_ASSOC_ALLEN_VECCHIO : PREF_ASSOC_VECCHIO} (${emailAssoc()}).json`; }

async function leggiAssociazioniCondivise(cartella, path, figli, allen) {
  const mio = mioNomeAssoc(allen), mioVecchio = mioNomeAssocVecchio(allen);
  const prefissi = [(allen ? PREF_ASSOC_ALLEN : PREF_ASSOC) + ' (', (allen ? PREF_ASSOC_ALLEN_VECCHIO : PREF_ASSOC_VECCHIO) + ' ('];
  const eMio = (n) => n === mio || n === mioVecchio;          // il proprio file (nuovo o vecchio) ha la precedenza sugli altri
  const files = figli.filter((x) => prefissi.some((p) => x.name.startsWith(p)) && x.name.endsWith('.json'))
    .sort((a, b) => eMio(a.name) - eMio(b.name) || (a.name === mio) - (b.name === mio) || String(a.modifiedTime).localeCompare(String(b.modifiedTime)));
  const map = {};
  let mioId = null;
  for (const f of files) {
    try {
      const dati = JSON.parse(new TextDecoder().decode(await drive.scarica(f.id)));
      Object.assign(map, dati.video || {});
    } catch (e) {}
    if (f.name === mio) mioId = f.id;
  }
  ASSOC.perCartella[cartella.id] = { fileId: mioId, map, path };
}

async function applicaAssociazioniCondivise(imp) {
  // per ogni partita senza video associato, se qualcuno l'ha già associata (file condiviso)
  // e quel video è presente nella cartella video attuale, lo si propone già collegato.
  imp.video_map = imp.video_map || {};
  const perId = new Map();
  for (const [p, v] of INDICE_VIDEO) perId.set(v.id, p);
  for (const a of Object.values(ASSOC.perCartella)) {
    for (const [nf, v] of Object.entries(a.map || {})) {
      if (imp.video_map[nf]) continue;
      const p = perId.get(v.id);
      if (p) imp.video_map[nf] = p;
    }
  }
  // OSPITE: il video di ogni gara e' quello indicato dal suo link (puo' essere la copia leggera, con un id diverso da quello degli abbinamenti salvati)
  if (drive.ospite) for (const g of drive.info.gare || []) { const p = g.v && perId.get(g.v); if (p) imp.video_map[g.n] = p; }
}

// ------------------------------------------------------------------------------------------
// impostazioni personali sul Drive (cartella dati): loghi delle squadre (abbinamenti + immagini PNG), soglie degli
// allenamenti e analisi salvate. Nel browser restano solo in localStorage (per browser, e si perdono se si cancellano
// i dati del sito): qui si copiano nel file «divoarido_impostazioni (email).json» e nei PNG «divoarido_logo (email) nome.png».
// Un file per utente (nessuno scrive sopra le impostazioni di un altro). All'avvio il Drive vince sul browser.
// ------------------------------------------------------------------------------------------
const PREF_IMP = 'divoarido_impostazioni';
const IMPD = { pronto: false, applicato: false, cartellaId: null, fileId: null, dati: null, ultimo: '', logoIds: {}, logoB64: {}, timer: null, inCorso: Promise.resolve() };

function emailImp() { return (drive.utente && drive.utente.emailAddress) || localStorage.getItem('vps_email') || 'utente'; }
function nomeFileImp() { return `${PREF_IMP} (${emailImp()}).json`; }
function prefLogo() { return `divoarido_logo (${emailImp()}) `; }
const DIR_LOGHI = () => DIR_DATI() + '/loghi/';
const DIR_LOGHI_VECCHIA = () => DIR_DATI_VECCHIA() + '/loghi/';      // si scrive anche qui finché possono girare programma e pagina di versioni diverse
const daB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const aB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
function selezioneImp(imp) {
  return { loghi: imp.loghi || {}, soglie_allenamenti: imp.soglie_allenamenti || null, analisi_salvate: imp.analisi_salvate || [] };
}
const firmaImp = (s) => JSON.stringify([s.loghi || {}, s.soglie_allenamenti || null, s.analisi_salvate || []]);

// Legge dalla cartella dati il file delle impostazioni dell'utente (e l'elenco dei suoi loghi).
async function leggiImpostazioniDrive(figli, idDati) {
  if (!drive || drive.pc || IMPD.pronto) return;        // (con le cartelle del PC in modalità prova i file stanno accanto alle partite)
  IMPD.cartellaId = idDati;
  const pref = prefLogo();
  for (const f of figli) if (f.name.startsWith(pref) && /\.png$/i.test(f.name)) IMPD.logoIds[f.name.slice(pref.length)] = f.id;
  const mio = figli.find((f) => f.name === nomeFileImp());
  if (mio) {
    IMPD.fileId = mio.id;
    try { IMPD.dati = JSON.parse(new TextDecoder().decode(await drive.scarica(mio.id))); }
    catch (e) { console.warn('impostazioni dal Drive non lette', e); IMPD.dati = null; }
  }
  IMPD.ultimo = IMPD.dati ? firmaImp(IMPD.dati) : '';
  IMPD.pronto = true;
}

// Una sola volta per sessione: i valori salvati sul Drive sostituiscono quelli del browser, e le immagini dei loghi
// vengono copiate nel file system del programma (dove le cerca imposta_logo / png_logo_squadra).
async function applicaImpostazioniDrive(imp) {
  if (!IMPD.pronto || IMPD.applicato) return;
  IMPD.applicato = true;
  const d = IMPD.dati;
  if (d) {
    if (d.loghi) imp.loghi = d.loghi;
    if (d.soglie_allenamenti) imp.soglie_allenamenti = d.soglie_allenamenti;
    if (d.analisi_salvate) imp.analisi_salvate = d.analisi_salvate;
  }
  for (const v of Object.values(imp.loghi || {})) {
    if (typeof v !== 'string' || !v.startsWith('file:')) continue;
    const nome = v.slice(5), id = IMPD.logoIds[nome];
    if (!id || IMPD.logoB64[nome]) continue;
    try {
      const bytes = new Uint8Array(await drive.scarica(id));
      await motore.scriviFile(DIR_LOGHI() + nome, bytes);
      await motore.scriviFile(DIR_LOGHI_VECCHIA() + nome, bytes);
      IMPD.logoB64[nome] = aB64(bytes);
    } catch (e) { console.warn('logo non letto dal Drive', nome, e); }
  }
}

// Chiamata a ogni modifica delle impostazioni: se loghi/soglie/analisi sono cambiati li salva sul Drive (dopo 1,5 s).
function programmaSalvataggioImp(imp) {
  if (!PROFILO.scrive) return;               // profili senza «salva» (reader...): niente scritture sul Drive
  if (!IMPD.pronto || !IMPD.applicato) return;
  const sel = selezioneImp(imp), f = firmaImp(sel);
  const vuoto = !Object.keys(sel.loghi).length && !sel.soglie_allenamenti && !sel.analisi_salvate.length;
  if (f === IMPD.ultimo || (vuoto && !IMPD.fileId)) return;
  clearTimeout(IMPD.timer);
  IMPD.timer = setTimeout(() => { IMPD.inCorso = IMPD.inCorso.then(() => salvaImpostazioniDrive(sel, f)); }, 1500);
}

async function salvaImpostazioniDrive(sel, f) {
  try {
    for (const v of Object.values(sel.loghi)) {
      if (typeof v !== 'string' || !v.startsWith('file:')) continue;
      const nome = v.slice(5);
      let b64;
      try { b64 = await motore.chiama('fs_leggi', DIR_LOGHI() + nome); } catch (e) { continue; }   // immagine non presente: niente da salvare
      if (IMPD.logoB64[nome] === b64) continue;                                                   // già uguale sul Drive
      const id = await drive.caricaFile(IMPD.cartellaId, prefLogo() + nome, daB64(b64), IMPD.logoIds[nome] || null, 'image/png');
      if (!id) throw new Error('logo ' + nome + ' non caricato');
      IMPD.logoIds[nome] = id; IMPD.logoB64[nome] = b64;
    }
    const id = await drive.caricaJson(IMPD.cartellaId, nomeFileImp(), Object.assign({ programma: 'DivoArido', aggiornato: new Date().toISOString() }, sel), IMPD.fileId);
    if (!id) throw new Error('file delle impostazioni non caricato');
    IMPD.fileId = id; IMPD.ultimo = f;
  } catch (e) {
    console.warn('impostazioni non salvate sul Drive', e);
    avviso('Attenzione: loghi/soglie/analisi non salvati sul Drive (restano su questo browser). Riprova o rinnova l\'accesso Google.');
  }
}

const salvataggioAssoc = {};
// Gli abbinamenti video (video_map: nome del .dvw -> video) delle gare vanno nel file delle gare, quelli delle sedute di
// allenamento (nomi dei .dvw della sezione Allenamenti) nel file degli allenamenti.
async function salvaAssociazioniCondivise(testo) {
  if (!PROFILO.scrive) return;
  let imp; try { imp = JSON.parse(testo); } catch (e) { return; }
  for (const allen of [false, true]) {
    const m = MONTAGGI[imp[allen ? 'allen_cartella_dvw' : 'cartella_dvw']];
    if (!m || m.kind !== 'dvw') continue;
    const a = ASSOC.perCartella[m.id] || (ASSOC.perCartella[m.id] = { fileId: null, map: {} });
    let cambiato = false;
    for (const [nf, p] of Object.entries(imp.video_map || {})) {
      if (NOMI_ALLEN.has(nf) !== allen) continue;
      const v = INDICE_VIDEO.get(p);
      if (!v) continue;
      if (!a.map[nf] || a.map[nf].id !== v.id) { a.map[nf] = { id: v.id, name: v.name }; cambiato = true; }
    }
    if (!cambiato) continue;
    const k = allen ? 'a' : 'g';
    clearTimeout(salvataggioAssoc[k]);
    salvataggioAssoc[k] = setTimeout(async () => {
      try {
        const id = await drive.caricaJson(cartellaDati(m), mioNomeAssoc(allen), { programma: 'DivoArido', aggiornato: new Date().toISOString(), video: a.map }, a.fileId);
        if (id) a.fileId = id;
      } catch (e) { console.warn('associazioni non salvate sul Drive', e); }
    }, 1500);
  }
}

// ------------------------------------------------------------------------------------------
// messaggi, errori, download
// ------------------------------------------------------------------------------------------
const ICONE = { info: 'ℹ️', warning: '⚠️', error: '⛔' };
function messaggio(kind, titolo, testo) {
  return new Promise((ok) => {
    const f = document.createElement('div');
    f.className = 'dlg-fondo dlg-aperto';
    f.innerHTML = `<div class="dlg dlg-msg ${kind}" role="alertdialog"><div class="dlg-testa"><span class="dlg-titolo"></span></div><div class="dlg-testo"><span class="ico"></span><p></p></div><div class="dlg-piede"><button class="btn-pri">OK</button></div></div>`;
    f.querySelector('.dlg-titolo').textContent = titolo || '';
    f.querySelector('.ico').textContent = ICONE[kind] || '';
    f.querySelector('p').textContent = testo || '';
    document.body.append(f);
    const b = f.querySelector('button'); b.focus();
    const chiudi = () => { f.remove(); ok(); };
    b.onclick = chiudi;
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); chiudi(); } });
  });
}

function domanda(titolo, testo) {
  return new Promise((ok) => {
    const f = document.createElement('div');
    f.className = 'dlg-fondo dlg-aperto';
    f.innerHTML = `<div class="dlg dlg-msg"><div class="dlg-testa"><span class="dlg-titolo"></span></div><div class="dlg-testo"><span class="ico">❓</span><p></p></div><div class="dlg-piede"><button class="btn-sec no">No</button><button class="btn-pri si">Sì</button></div></div>`;
    f.querySelector('.dlg-titolo').textContent = titolo || '';
    f.querySelector('p').textContent = testo || '';
    document.body.append(f);
    f.querySelector('.si').onclick = () => { f.remove(); ok(true); };
    f.querySelector('.no').onclick = () => { f.remove(); ok(false); };
  });
}

function mostraErrore(titolo, dettaglio) {
  const box = $('#errori');
  const d = document.createElement('details');
  d.innerHTML = `<summary></summary><pre></pre><button>Chiudi</button>`;
  d.querySelector('summary').textContent = '⛔ ' + titolo + ' — clicca per i dettagli';
  d.querySelector('pre').textContent = dettaglio;
  d.querySelector('button').onclick = () => d.remove();
  box.append(d);
}

let avvisoTimer = null;
function avviso(t) {
  const a = $('#avviso'); a.textContent = t; a.hidden = false;
  clearTimeout(avvisoTimer); avvisoTimer = setTimeout(() => { a.hidden = true; }, 5000);
}
function avvisoLungo(t) {
  const a = $('#avviso-lungo');
  if (!t) { a.hidden = true; return; }
  a.textContent = t; a.hidden = false;
}

function scaricaFile(nome, b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const tipo = nome.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([u8], { type: tipo }));
  const a = document.createElement('a');
  a.href = url; a.download = nome.split('/').pop();
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  avviso('PDF scaricato: ' + a.download);
}

const ATTESA_SALVA = new Map();
function salvaDato(path, testo) {
  if (!PROFILO.scrive) { avvisoFlagNonSalvati(); return; }       // profilo senza «salva»: i dati restano solo nella pagina aperta
  const dir = path.substring(0, path.lastIndexOf('/')), nome = path.substring(path.lastIndexOf('/') + 1);
  const m = MONTAGGI[dir];
  if (!m || m.kind !== 'dvw') return;
  clearTimeout(ATTESA_SALVA.get(path));
  ATTESA_SALVA.set(path, setTimeout(async () => {
    // sezione Allenamenti: stessa cartella dati delle gare, nome con prefisso (altrimenti i due file si sovrascriverebbero)
    const info = FILE_DATI.get(path) || { cartellaId: cartellaDati(m), nome: (m.sez === 'allen' ? PREF_DATI_ALLEN : '') + nome, id: null };
    try {
      const id = await drive.caricaFile(info.cartellaId, info.nome, testo, info.id);
      if (id) { info.id = id; FILE_DATI.set(path, info); }
      else avviso('Attenzione: ' + info.nome + ' non salvato' + DOVE());
    } catch (e) { avviso('Attenzione: ' + info.nome + ' non salvato' + DOVE()); console.warn(e); }
  }, 700));
}

function salvaImpostazioni(testo) {
  salvaJson('vps_impostazioni', testo); salvaAssociazioniCondivise(testo);
  try { programmaSalvataggioImp(JSON.parse(testo)); } catch (e) {}
}

// Il token di Google dura un'ora: quando sta per scadere lo si rinnova al primo click
// dell'utente (il browser permette la finestrella di Google solo dopo un click).
document.addEventListener('pointerdown', () => {
  if (!drive || drive.mock || !drive.tok) return;
  if (drive.scade - Date.now() < 8 * 60000 && !drive._rinnovoInCorso) {
    drive._rinnovoInCorso = true;
    drive.login('').then(() => { $('#rinnova').hidden = true; }).catch(() => mostraRinnovo()).finally(() => { drive._rinnovoInCorso = false; });
  }
}, true);

window.addEventListener('beforeunload', (e) => {
  if (document.querySelector('.tk-finestra:not(.tk-radice)')) { e.preventDefault(); e.returnValue = ''; }
});

avvio();
