// Finestra «Link ospiti» (fase 7, 21/11/2026): SOLO per il proprietario. Crea un link temporaneo con profilo, durata e contenuto scelti
// (gare tutte/alcune/nessuna, allenamenti inclusi/esclusi/alcuni, video si/no), mostra i link attivi e permette di revocarli.
// Il lavoro vero lo fa il servizio ospiti (ospiti/Code.gs), che riconosce il proprietario dal suo accesso Google.

import { chiamaServizio } from './ospite.js';

const el = (tag, cls, testo) => { const e = document.createElement(tag); if (cls) e.className = cls; if (testo != null) e.textContent = testo; return e; };
const attesa = (ms) => new Promise((x) => setTimeout(x, ms));

export const DURATE = [[2, '2 ore'], [6, '6 ore'], [12, '12 ore'], [24, '1 giorno'], [48, '2 giorni'], [72, '3 giorni'], [168, '1 settimana'], [336, '2 settimane'], [720, '30 giorni'], [0, 'Altro…']];

export function formatoData(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function formatoDimensione(byte) {
  if (!byte) return '0 MB';
  return byte >= 1073741824 ? (byte / 1073741824).toFixed(1) + ' GB' : Math.round(byte / 1048576) + ' MB';
}
export function indirizzoLink(token, base = location.origin + location.pathname) { return base + '#o=' + token; }

// Elenco delle gare da mandare al servizio, secondo le scelte: [{n,d,s,v,r,m,z}]
export function sceltaElementi(tutti, { gare, allenamenti, video }) {
  const out = [];
  for (const g of tutti) {
    const sez = g.s === 'a' ? allenamenti : gare;
    const incluso = sez.modo === 'tutti' || (sez.modo === 'scelti' && sez.scelti.has(g.d));
    if (!incluso) continue;
    out.push(video ? Object.assign({}, g) : Object.assign({}, g, { v: null, r: '', m: '', z: 0, web: false }));
  }
  return out;
}

export function descrizioneStato(l) {
  if (l.stato === 'attivo') return 'attivo fino al ' + formatoData(l.scadenza);
  if (l.stato === 'scaduto') return 'scaduto il ' + formatoData(l.scadenza);
  if (l.stato === 'revocato') return 'revocato';
  if (l.stato === 'preparazione') return 'in preparazione';
  if (l.stato === 'abbandonato') return 'interrotto (non completato)';
  return l.stato;
}

// elementi: [{n (nome .dvw), d (id .dvw), s ('g' gara | 'a' allenamento), v (id video | null), r (percorso del video), m (tipo), z (byte)}]
// profili: [{id, nome, funzioni}]  (il primo e' il Reader)
export function apriLinkOspiti({ drive, CFG, elementi, profili, messaggio }) {
  document.getElementById('lo-fondo')?.remove();
  const tutti = elementi();
  const fondo = el('div', 'dlg-fondo dlg-aperto'); fondo.id = 'lo-fondo';
  const dlg = el('div', 'dlg gp-dlg lo-dlg'); dlg.setAttribute('role', 'dialog');
  const testa = el('div', 'dlg-testa'); testa.append(el('span', 'dlg-titolo', '🔗 Link per ospiti'));
  const x = el('button', 'dlg-x', '✕'); testa.append(x);
  const corpo = el('div', 'gp-corpo lo-corpo');
  const piede = el('div', 'dlg-piede');
  const bChiudi = el('button', 'btn-sec', 'Chiudi'); piede.append(bChiudi);
  dlg.append(testa, corpo, piede); fondo.append(dlg); document.body.append(fondo);
  const chiudi = () => fondo.remove();
  x.onclick = bChiudi.onclick = chiudi;
  fondo.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudi(); });

  // ---------------- nuovo link ----------------
  const nuovo = el('div', 'lo-sezione');
  nuovo.append(el('h4', null, 'Nuovo link'));
  nuovo.append(el('p', 'gp-nota', 'Chi riceve il link usa DivoArido senza account Google e senza essere aggiunto fra gli utenti. Alla scadenza, o se lo annulli, perde l\'accesso e i video tornano privati. Un ospite non può modificare nulla.'));

  const riga = (etichetta, ...cose) => { const r = el('div', 'lo-riga'); r.append(el('label', null, etichetta), ...cose); return r; };
  const nome = el('input'); nome.type = 'text'; nome.maxLength = 60; nome.placeholder = 'es. Staff Maaseik'; nome.className = 'lo-nome';
  nuovo.append(riga('Nome del link (solo per te)', nome));

  const selProfilo = el('select');
  for (const p of profili) { const o = el('option', null, p.nome); o.value = p.id; selProfilo.append(o); }
  nuovo.append(riga('Cosa può usare', selProfilo));

  const selDurata = el('select');
  for (const [h, t] of DURATE) { const o = el('option', null, t); o.value = String(h); if (h === 24) o.selected = true; selDurata.append(o); }
  const altro = el('input'); altro.type = 'number'; altro.min = '1'; altro.max = '720'; altro.value = '5'; altro.hidden = true; altro.className = 'lo-ore';
  const oreTxt = el('span', 'gp-nota', 'ore'); oreTxt.hidden = true;
  selDurata.onchange = () => { const a = selDurata.value === '0'; altro.hidden = oreTxt.hidden = !a; riepilogo(); };
  nuovo.append(riga('Per quanto tempo', selDurata, altro, oreTxt));

  // scelta di gare e allenamenti
  const stato = { gare: { modo: 'tutti', scelti: new Set() }, allenamenti: { modo: 'nessuno', scelti: new Set() }, video: true };
  const sezioni = [];
  const costruisciSezione = (chiave, titolo, lista, modi) => {
    const box = el('div', 'lo-gruppo');
    const testaS = el('div', 'lo-riga'); testaS.append(el('label', null, titolo));
    const modoSel = el('select');
    for (const [v, t] of modi) { const o = el('option', null, t); o.value = v; modoSel.append(o); }
    modoSel.value = stato[chiave].modo;
    testaS.append(modoSel); box.append(testaS);
    const pannello = el('div', 'lo-pannello'); pannello.hidden = true;
    const filtro = el('input'); filtro.type = 'text'; filtro.placeholder = 'Filtra per nome, squadra o data…'; filtro.className = 'lo-filtro';
    const azioni = el('div', 'lo-azioni');
    const bTutte = el('button', 'btn-sec', 'Seleziona le visibili'), bNessuna = el('button', 'btn-sec', 'Deseleziona le visibili');
    azioni.append(bTutte, bNessuna);
    const elenco = el('div', 'lo-elenco');
    pannello.append(filtro, azioni, elenco); box.append(pannello);
    const voci = lista.map((g) => {
      const l = el('label', 'lo-voce'); const c = el('input'); c.type = 'checkbox';
      c.onchange = () => { c.checked ? stato[chiave].scelti.add(g.d) : stato[chiave].scelti.delete(g.d); riepilogo(); };
      l.append(c, document.createTextNode(' ' + g.n.replace(/\.dvw$/i, '') + (g.v ? (g.web ? '  · copia leggera' : (g.z ? `  · originale ${formatoDimensione(g.z)}` : '')) : '  (senza video)')));
      elenco.append(l);
      return { g, l, c };
    });
    const visibili = () => voci.filter((v) => !v.l.hidden);
    filtro.oninput = () => { const t = filtro.value.trim().toLowerCase(); for (const v of voci) v.l.hidden = !!t && !v.g.n.toLowerCase().includes(t); };
    bTutte.onclick = () => { for (const v of visibili()) { v.c.checked = true; stato[chiave].scelti.add(v.g.d); } riepilogo(); };
    bNessuna.onclick = () => { for (const v of visibili()) { v.c.checked = false; stato[chiave].scelti.delete(v.g.d); } riepilogo(); };
    modoSel.onchange = () => { stato[chiave].modo = modoSel.value; pannello.hidden = modoSel.value !== 'scelti'; riepilogo(); };
    if (!lista.length) { modoSel.disabled = true; stato[chiave].modo = 'nessuno'; modoSel.value = 'nessuno'; testaS.append(el('span', 'gp-nota', ' (non ce ne sono di caricate)')); }
    sezioni.push({ chiave, voci });
    return box;
  };
  const listaG = tutti.filter((g) => g.s !== 'a'), listaA = tutti.filter((g) => g.s === 'a');
  nuovo.append(costruisciSezione('gare', 'Gare', listaG, [['tutti', 'Tutte'], ['scelti', 'Solo alcune…'], ['nessuno', 'Nessuna']]));
  nuovo.append(costruisciSezione('allenamenti', 'Allenamenti', listaA, [['nessuno', 'Esclusi'], ['tutti', 'Tutti'], ['scelti', 'Solo alcuni…']]));

  const cVideo = el('input'); cVideo.type = 'checkbox'; cVideo.checked = true;
  cVideo.onchange = () => { stato.video = cVideo.checked; riepilogo(); };
  const lVideo = el('label', 'lo-voce'); lVideo.append(cVideo, document.createTextNode(' Includi i video (restano visibili a chi ha il link, ma solo per la durata scelta)'));
  nuovo.append(lVideo);

  const sintesi = el('p', 'lo-sintesi');
  const avvisoGrandi = el('p', 'lo-errore');
  const errore = el('p', 'lo-errore');
  const avanzamento = el('p', 'gp-nota');
  const esito = el('div', 'lo-esito'); esito.hidden = true;
  const bCrea = el('button', 'btn-pri', '🔗 Crea il link');
  nuovo.append(sintesi, avvisoGrandi, errore, avanzamento, bCrea, esito);

  const ore = () => { const v = Number(selDurata.value); return v === 0 ? Math.round(Number(altro.value) * 100) / 100 : v; };
  const scelti = () => sceltaElementi(tutti, stato);
  function riepilogo() {
    const e = scelti();
    const nG = e.filter((g) => g.s !== 'a').length, nA = e.filter((g) => g.s === 'a').length, nV = e.filter((g) => g.v).length, nW = e.filter((g) => g.v && g.web).length;
    const peso = e.reduce((s, g) => s + (g.v ? Number(g.z) || 0 : 0), 0);
    sintesi.textContent = e.length ? `Il link darà accesso a ${nG} gare e ${nA} allenamenti${stato.video ? `, con ${nV} video${nW ? ' (' + nW + ' in copia leggera)' : ''}${peso ? ' (' + formatoDimensione(peso) + ')' : ''}` : ', senza video'}.` : 'Nessuna gara scelta.';
    const grandi = stato.video ? e.filter((g) => g.v && Number(g.z) > 1.5 * 1073741824).length : 0;
    avvisoGrandi.textContent = grandi ? `⚠️  video superano 1,5 GB: Google limita quanto può essere scaricato da un file condiviso con un link e, dopo alcune visioni, può bloccarlo per qualche ora. Le copie leggere (720p) non hanno questo problema: crea quelle mancanti con crea_copie_web.py --gare.` : '';
    bCrea.disabled = !e.length;
  }
  riepilogo();

  bCrea.onclick = async () => {
    errore.textContent = '';
    const o = ore();
    if (!(o >= 0.25 && o <= 720)) { errore.textContent = 'La durata deve essere fra 1 ora e 30 giorni.'; return; }
    const gare = scelti();
    if (!gare.length) return;
    const p = profili.find((x) => x.id === selProfilo.value) || profili[0];
    bCrea.disabled = true; esito.hidden = true;
    try {
      const t = await drive.token();
      avanzamento.textContent = 'Creo il link…';
      const r = await chiamaServizio(CFG, { a: 'crea', t, nome: nome.value.trim() || p.nome, ore: o, profilo: { nome: p.nome, funzioni: p.funzioni }, gare }, { tentativi: 1 });
      let a;
      do {
        a = await chiamaServizio(CFG, { a: 'apri', t: await drive.token(), token: r.token, max: 20 }, { tentativi: 2 });
        avanzamento.textContent = `Preparo i video… ${a.fatti}/${a.totale}`;
      } while (!a.finito);
      avanzamento.textContent = '';
      mostraEsito(r.token, a, gare.length);
      aggiornaElenco();
    } catch (e) {
      avanzamento.textContent = '';
      errore.textContent = 'Non sono riuscito a creare il link: ' + messaggioErrore(e);
    } finally { riepilogo(); }
  };

  const mostraEsito = (token, a, n) => {
    esito.hidden = false; esito.replaceChildren();
    const url = indirizzoLink(token);
    esito.append(el('p', 'lo-ok', `✅ Link pronto: ${n} elementi, valido fino al ${formatoData(a.scadenza)}.`));
    if (a.problemi) esito.append(el('p', 'lo-errore', `Attenzione: ${a.problemi} elementi non sono stati inclusi (file non trovato o video non condivisibile).`));
    const campo = el('input'); campo.type = 'text'; campo.readOnly = true; campo.value = url; campo.className = 'lo-url';
    campo.onfocus = () => campo.select();
    const copia = el('button', 'btn-pri', '📋 Copia il link');
    copia.onclick = async () => { try { await navigator.clipboard.writeText(url); copia.textContent = '✅ Copiato'; } catch (e) { campo.select(); copia.textContent = 'Seleziona e copia (Ctrl+C)'; } };
    const r = el('div', 'gp-nuovo'); r.append(campo, copia);
    esito.append(r);
  };

  // ---------------- link attivi ----------------
  const elencoBox = el('div', 'lo-sezione');
  const titoloElenco = el('h4', null, 'Link creati');
  const stampaElenco = el('div', 'lo-link-elenco');
  elencoBox.append(titoloElenco, stampaElenco);
  corpo.append(nuovo, elencoBox);

  const avviso = (testo) => { messaggio && messaggio(testo); };
  async function aggiornaElenco() {
    stampaElenco.replaceChildren(el('p', 'gp-nota', 'Carico…'));
    let r;
    try { r = await chiamaServizio(CFG, { a: 'elenca', t: await drive.token() }, { tentativi: 2 }); }
    catch (e) { stampaElenco.replaceChildren(el('p', 'lo-errore', 'Elenco non disponibile: ' + messaggioErrore(e))); return; }
    stampaElenco.replaceChildren();
    if (!r.chiaveApi) stampaElenco.append(el('p', 'lo-errore', '⚠️ Nel servizio manca la chiave API: i video degli ospiti non partiranno finché non viene inserita.'));
    if (!r.trigger) stampaElenco.append(el('p', 'lo-errore', '⚠️ La chiusura automatica dei video non è attiva: esegui «PRIMA_AUTORIZZAZIONE» nel servizio.'));
    if (!r.link.length) { stampaElenco.append(el('p', 'gp-nota', 'Nessun link creato.')); return; }
    for (const l of r.link) {
      const riga = el('div', 'lo-link lo-' + l.stato);
      const info = el('div', 'lo-link-info');
      info.append(el('b', null, l.nome), el('span', 'gp-nota', ` · ${l.profilo && l.profilo.nome || ''} · ${l.gare} elementi, ${l.video} video · ${descrizioneStato(l)}`));
      riga.append(info);
      const az = el('div', 'lo-azioni');
      if (l.stato === 'attivo') {
        const c = el('button', 'btn-sec', '📋 Copia link');
        c.onclick = async () => { try { await navigator.clipboard.writeText(indirizzoLink(l.token)); c.textContent = '✅ Copiato'; } catch (e) { prompt('Copia il link:', indirizzoLink(l.token)); } };
        az.append(c);
      }
      if (l.stato === 'attivo' || l.stato === 'preparazione') {
        const rv = el('button', 'btn-sec', '⛔ Annulla ora');
        rv.onclick = async () => {
          if (!confirm(`Annullare il link «${l.nome}»? Chi lo usa perde subito l'accesso e i suoi video tornano privati.`)) return;
          rv.disabled = true; rv.textContent = 'Annullo…';
          try {
            let q = await chiamaServizio(CFG, { a: 'revoca', t: await drive.token(), token: l.token }, { tentativi: 1 });
            for (let i = 0; i < 6 && q.restanti > 0; i++) { await attesa(1500); q = await chiamaServizio(CFG, { a: 'chiudi', t: await drive.token() }, { tentativi: 1 }); }
            avviso(q.restanti ? `Link annullato, ma ${q.restanti} video non sono stati richiusi: riprova fra poco.` : 'Link annullato: i video sono tornati privati.');
          } catch (e) { avviso('Non sono riuscito ad annullare il link: ' + messaggioErrore(e)); }
          aggiornaElenco();
        };
        az.append(rv);
      } else {
        const el2 = el('button', 'btn-sec', '🗑 Togli dall\'elenco');
        el2.onclick = async () => { try { await chiamaServizio(CFG, { a: 'elimina', t: await drive.token(), token: l.token }, { tentativi: 1 }); } catch (e) { avviso(messaggioErrore(e)); } aggiornaElenco(); };
        az.append(el2);
      }
      riga.append(az);
      stampaElenco.append(riga);
    }
  }
  aggiornaElenco();
  setTimeout(() => nome.focus(), 0);
  return { aggiornaElenco, chiudi };
}

export function messaggioErrore(e) {
  const c = e && e.codice, m = String((e && e.message) || e || '');
  if (c === 'non_autorizzato') return 'solo il proprietario può gestire i link (accedi con l\'account del proprietario).';
  if (c === 'servizio_assente') return 'il servizio degli ospiti non è ancora attivo.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'impossibile raggiungere il servizio (connessione o indirizzo del servizio errato).';
  return m;
}
