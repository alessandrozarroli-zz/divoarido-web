// Profili d'uso della versione web: «completo», «reader» e profili personalizzati (21/11/2026).
//
// Come funziona
// - Ogni profilo ha una CARTELLA-MARCATORE sul Drive del proprietario. Chi ha quella cartella condivisa (anche solo in lettura) ha quel profilo:
//   la pagina prova a leggerla all'avvio. Nessun elenco di email, nessuna mail nei file: si cambia profilo aggiungendo o togliendo la condivisione.
// - Completo = cartella `MARCATORE_COMPLETO` (config.js): tutte le funzioni. Il proprietario (chi possiede quella cartella) è sempre completo.
// - Personalizzati = nel file `divoarido_profili.json` (cartella dati): nome, cartella-marcatore e funzioni abilitate. Li gestisce SOLO il proprietario
//   dalla pagina «Gestione profili» (gli altri completi la vedono in sola lettura).
// - Nessun marcatore = reader (funzioni di base: vedi FUNZIONI_PROFILO nel programma, terza colonna).
// - Non è sicurezza vera (la pagina gira nel browser dell'utente): i dati restano protetti dalle condivisioni di Drive. Il salvataggio sul Drive
//   dei profili senza la funzione «salva» è bloccato anche dai permessi (sola lettura sulla cartella dati).

export const NOME_FILE_PROFILI = 'divoarido_profili.json';
const CARTELLA = 'application/vnd.google-apps.folder';
const attesa = (ms) => new Promise((x) => setTimeout(x, ms));
const ERRORE_ACCESSO = /not found|404|403|forbidden|insufficient|permission|non trovat|notFound/i;

// Ha l'utente accesso a questa cartella-marcatore? {ok, ownedByMe}. Un errore di rete si ripete una volta poi si rilancia.
async function haAccesso(drive, id) {
  for (let i = 0; i < 2; i++) {
    try {
      const m = await drive.get('/files/' + id, { fields: 'id,name,ownedByMe,trashed', supportsAllDrives: true });
      return { ok: !m.trashed, ownedByMe: !!m.ownedByMe };
    } catch (e) {
      if (ERRORE_ACCESSO.test(String((e && e.message) || e))) return { ok: false, ownedByMe: false };
      if (i === 1) throw e;
      await attesa(700);
    }
  }
  return { ok: false, ownedByMe: false };
}

// Legge il file dei profili personalizzati dalla cartella dati: {id, cfg} (cfg = {versione, profili: []}).
export async function leggiConfigProfili(drive, CFG) {
  const vuoto = { id: null, cfg: { versione: 1, profili: [] } };
  if (!CFG.CARTELLA_DATI) return vuoto;
  const trovati = await drive.elenca(`'${CFG.CARTELLA_DATI}' in parents and name = '${NOME_FILE_PROFILI}' and trashed = false`);
  if (!trovati.length) return vuoto;
  try {
    const cfg = JSON.parse(new TextDecoder().decode(await drive.scarica(trovati[0].id)));
    if (!cfg || !Array.isArray(cfg.profili)) return { id: trovati[0].id, cfg: { versione: 1, profili: [] } };
    return { id: trovati[0].id, cfg };
  } catch (e) {
    console.warn('file dei profili non letto', e);
    return { id: trovati[0].id, cfg: { versione: 1, profili: [] } };
  }
}

function parametriProva(CFG, drive) {
  // solo per le prove (server locale / Drive finto): ?profilo=reader oppure ?funzioni=ricerca,organico
  if (!(drive.mock || CFG.MODALITA_LOCALE)) return null;
  const q = new URLSearchParams(location.search);
  if (q.get('funzioni') != null) return { nome: 'Prova', funzioni: q.get('funzioni').split(',').map((s) => s.trim()).filter(Boolean) };
  if (q.get('profilo')) return { nome: q.get('profilo') };
  return null;
}

function costruisci(base, chiave, nome, funzioni, extra = {}) {
  const f = funzioni == null ? null : funzioni.filter((k) => base.tutte.includes(k));
  return Object.assign({ chiave, nome, funzioni: f, scrive: f == null || f.includes('salva'), gestione: false, proprietario: false, incerto: false,
                         tutte: base.tutte, elenco: base.elenco, config: null, idConfig: null, personalizzati: [] }, extra);
}

// Determina il profilo dell'utente. Non lancia errori: nel dubbio ripiega sul reader (default sicuro) e lo segnala con «incerto».
export async function determinaProfilo({ drive, CFG, motore }) {
  let elenco = [];
  try { elenco = JSON.parse(await motore.chiama('profilo_funzioni')); } catch (e) { console.warn('profilo_funzioni', e); }
  const base = { elenco, tutte: elenco.map((x) => x[0]), reader: elenco.filter((x) => x[2]).map((x) => x[0]) };
  const completo = (extra = {}) => costruisci(base, 'completo', 'Completo', null, Object.assign({ gestione: true }, extra));
  // programma senza profili (o cartelle del PC): tutto abilitato
  if (!elenco.length || drive.pc) return completo({ gestione: false });
  const prova = parametriProva(CFG, drive);
  if (prova) {
    if (prova.funzioni) return costruisci(base, 'prova', prova.nome, prova.funzioni);
    if (/^reader$/i.test(prova.nome)) return costruisci(base, 'reader', 'Reader', base.reader);
    if (/^proprietario$/i.test(prova.nome)) return completo({ proprietario: true, config: { versione: 1, profili: [{ id: 'pprova', nome: 'Allenatore', marcatore: 'XYZ', funzioni: ['ricerca', 'organico'] }] } });   // solo per provare la pagina Gestione profili
    return completo({ gestione: false });
  }
  if (CFG.MODALITA_LOCALE || drive.mock || !CFG.MARCATORE_COMPLETO) return completo({ gestione: false });     // profili non ancora attivati: tutto aperto come prima
  const reader = (incerto) => costruisci(base, 'reader', 'Reader', base.reader, { incerto: !!incerto });
  let cfgProfili = { id: null, cfg: { versione: 1, profili: [] } };
  try {
    const mc = await haAccesso(drive, CFG.MARCATORE_COMPLETO);
    if (mc.ok) {
      try { cfgProfili = await leggiConfigProfili(drive, CFG); } catch (e) { console.warn('profili personalizzati non letti', e); }
      const p = completo({ proprietario: mc.ownedByMe, config: cfgProfili.cfg, idConfig: cfgProfili.id });
      p.personalizzati = cfgProfili.cfg.profili;
      // il proprietario può provare gli altri profili senza cambiare account (solo in questo browser)
      let prova2 = null; try { prova2 = sessionStorage.getItem('vps_prova_profilo'); } catch (e) {}
      if (mc.ownedByMe && prova2 && prova2 !== 'completo') {
        const q = prova2 === 'reader' ? { nome: 'Reader', funzioni: base.reader } : cfgProfili.cfg.profili.find((x) => x.id === prova2);
        if (q) {
          const sim = costruisci(base, prova2, q.nome, q.funzioni, { config: cfgProfili.cfg, idConfig: cfgProfili.id, personalizzati: cfgProfili.cfg.profili, simulato: true, proprietario: mc.ownedByMe, gestione: true });
          return sim;
        }
      }
      return p;
    }
    cfgProfili = await leggiConfigProfili(drive, CFG);
    for (const q of cfgProfili.cfg.profili) {
      if (!q.marcatore) continue;
      const a = await haAccesso(drive, q.marcatore);
      if (a.ok) return costruisci(base, q.id, q.nome, q.funzioni || [], { personalizzati: [] });
    }
    return reader(false);
  } catch (e) {
    console.warn('profilo non verificato', e);
    return reader(true);
  }
}

// ------------------------------------------------------------------------------------------
// pagina «Gestione profili»
// ------------------------------------------------------------------------------------------
const el = (tag, cls, testo) => { const e = document.createElement(tag); if (cls) e.className = cls; if (testo != null) e.textContent = testo; return e; };
const linkDrive = (id) => 'https://drive.google.com/drive/folders/' + id;

async function creaCartellaMarcatore(drive, genitoreId, nome) {
  const t = await drive.token();
  const r = await fetch(drive.api + '/files?supportsAllDrives=true&fields=id,name', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, drive.mock ? {} : { Authorization: 'Bearer ' + t }),
    body: JSON.stringify({ name: nome, mimeType: CARTELLA, parents: [genitoreId] }),
  });
  if (!r.ok) throw new Error('Google Drive: ' + r.status);
  return (await r.json()).id;
}

export function apriGestione({ drive, CFG, profilo, messaggio }) {
  document.getElementById('gp-fondo')?.remove();
  const puoModificare = !!profilo.proprietario && !profilo.simulato;
  const cfg = JSON.parse(JSON.stringify(profilo.config || { versione: 1, profili: [] }));
  let idConfig = profilo.idConfig || null;
  let modificato = false;

  const fondo = el('div', 'dlg-fondo dlg-aperto'); fondo.id = 'gp-fondo';
  const dlg = el('div', 'dlg gp-dlg'); dlg.setAttribute('role', 'dialog');
  const testa = el('div', 'dlg-testa'); testa.append(el('span', 'dlg-titolo', '👥 Gestione profili'));
  const x = el('button', 'dlg-x', '✕'); x.onclick = () => chiudi();
  testa.append(x);
  const corpo = el('div', 'gp-corpo');
  const piede = el('div', 'dlg-piede');
  dlg.append(testa, corpo, piede); fondo.append(dlg); document.body.append(fondo);

  const chiudi = () => {
    if (modificato && !confirm('Ci sono modifiche non salvate. Chiudere lo stesso?')) return;
    fondo.remove();
  };
  fondo.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudi(); });

  const funzioniDi = (lista, sola) => {
    const box = el('div', 'gp-funzioni');
    for (const [k, etichetta] of profilo.elenco) {
      const l = el('label', 'gp-voce'); const c = document.createElement('input'); c.type = 'checkbox';
      c.checked = lista.includes(k); c.disabled = sola;
      c.onchange = () => { const i = lista.indexOf(k); if (c.checked && i < 0) lista.push(k); if (!c.checked && i >= 0) lista.splice(i, 1); modificato = true; piedeAggiorna(); };
      l.append(c, document.createTextNode(' ' + etichetta)); box.append(l);
    }
    return box;
  };

  const disegna = () => {
    corpo.replaceChildren();
    corpo.append(el('p', 'gp-nota', `Il tuo profilo: ${profilo.nome}${profilo.proprietario ? ' (proprietario)' : ''}${profilo.simulato ? ' — stai PROVANDO questo profilo' : ''}. `
      + (puoModificare ? 'Qui scegli quali funzioni vede ogni profilo.' : 'Solo il proprietario può modificare i profili: qui puoi solo guardarli.')));
    // reader e completo (fissi)
    const fissi = el('details', 'gp-profilo'); fissi.append(el('summary', null, '🔒 Completo e Reader (fissi)'));
    const pf = el('div', 'gp-interno');
    pf.append(el('p', 'gp-nota', 'Completo: tutte le funzioni (ha la cartella «Funzioni complete» condivisa). Reader: chi non ha nessuna cartella-marcatore; vede:'));
    pf.append(funzioniDi(profilo.elenco.filter((e) => e[2]).map((e) => e[0]), true));
    fissi.append(pf); corpo.append(fissi);
    for (const p of cfg.profili) {
      const d = el('details', 'gp-profilo'); d.open = true;
      d.append(el('summary', null, '🧩 ' + p.nome));
      const dentro = el('div', 'gp-interno');
      p.funzioni = Array.isArray(p.funzioni) ? p.funzioni : [];
      dentro.append(funzioniDi(p.funzioni, !puoModificare));
      const riga = el('div', 'gp-riga');
      if (p.marcatore) {
        const a = el('a', null, '📂 Apri su Drive la cartella di questo profilo'); a.href = linkDrive(p.marcatore); a.target = '_blank'; a.rel = 'noopener';
        riga.append(a);
      }
      riga.append(el('span', 'gp-nota', 'Per dare il profilo a una persona: condividi quella cartella con la sua email come «Visualizzatore» (senza notifica).'));
      dentro.append(riga);
      if (puoModificare) {
        const del = el('button', 'btn-sec', 'Togli questo profilo');
        del.onclick = () => { if (!confirm(`Togliere il profilo «${p.nome}»? Chi lo ha diventa Reader. La cartella resta su Drive (la puoi cancellare tu).`)) return; cfg.profili.splice(cfg.profili.indexOf(p), 1); modificato = true; disegna(); piedeAggiorna(); };
        dentro.append(del);
      }
      d.append(dentro); corpo.append(d);
    }
    if (!cfg.profili.length) corpo.append(el('p', 'gp-nota', 'Nessun profilo personalizzato.'));
    if (puoModificare) {
      const nuovo = el('div', 'gp-nuovo');
      const nome = document.createElement('input'); nome.type = 'text'; nome.placeholder = 'Nome del nuovo profilo (es. Allenatore)'; nome.maxLength = 40;
      const crea = el('button', 'btn-pri', '➕ Crea profilo');
      crea.onclick = async () => {
        const n = nome.value.trim();
        if (!n) { nome.focus(); return; }
        if (cfg.profili.some((p) => p.nome.toLowerCase() === n.toLowerCase())) { alert('Esiste già un profilo con questo nome.'); return; }
        if (!CFG.CARTELLA_PROFILI) { alert('Manca la cartella dei profili in config.js (CARTELLA_PROFILI).'); return; }
        crea.disabled = true;
        try {
          const id = await creaCartellaMarcatore(drive, CFG.CARTELLA_PROFILI, 'Profilo - ' + n);
          cfg.profili.push({ id: 'p' + Date.now().toString(36), nome: n, marcatore: id, funzioni: profilo.elenco.filter((e) => e[2]).map((e) => e[0]) });
          modificato = true; disegna(); piedeAggiorna();
        } catch (e) { alert('Non sono riuscito a creare la cartella del profilo su Drive: ' + (e.message || e)); crea.disabled = false; }
      };
      nuovo.append(nome, crea); corpo.append(nuovo);
    }
    // prova di un profilo (solo il proprietario, solo in questo browser)
    if (profilo.proprietario) {
      const pr = el('div', 'gp-nuovo');
      pr.append(el('span', 'gp-nota', 'Prova come:'));
      const sel = document.createElement('select');
      const opz = [['completo', 'Completo (tu)'], ['reader', 'Reader'], ...cfg.profili.map((p) => [p.id, p.nome])];
      let corrente = 'completo'; try { corrente = sessionStorage.getItem('vps_prova_profilo') || 'completo'; } catch (e) {}
      for (const [v, t] of opz) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === corrente) o.selected = true; sel.append(o); }
      const vai = el('button', 'btn-sec', 'Prova (ricarica la pagina)');
      vai.onclick = () => {
        if (modificato && !confirm('Hai modifiche non salvate: ricaricando andrebbero perse. Continuare?')) return;
        try { if (sel.value === 'completo') sessionStorage.removeItem('vps_prova_profilo'); else sessionStorage.setItem('vps_prova_profilo', sel.value); } catch (e) {}
        modificato = false; location.reload();
      };
      pr.append(sel, vai); corpo.append(pr);
    }
  };

  let btnSalva = null;
  const piedeAggiorna = () => { if (btnSalva) btnSalva.disabled = !modificato; };
  piede.replaceChildren();
  if (puoModificare) {
    btnSalva = el('button', 'btn-pri', 'Salva');
    btnSalva.disabled = true;
    btnSalva.onclick = async () => {
      btnSalva.disabled = true;
      try {
        const id = await drive.caricaJson(CFG.CARTELLA_DATI, NOME_FILE_PROFILI, { versione: 1, aggiornato: new Date().toISOString(), profili: cfg.profili }, idConfig);
        if (!id) throw new Error('file non salvato');
        idConfig = id; modificato = false; profilo.idConfig = id; profilo.config = JSON.parse(JSON.stringify(cfg)); profilo.personalizzati = cfg.profili;
        messaggio && messaggio('Profili salvati.');
      } catch (e) { btnSalva.disabled = false; alert('Profili non salvati: ' + (e.message || e)); }
    };
    piede.append(btnSalva);
  }
  const bChiudi = el('button', 'btn-sec', 'Chiudi'); bChiudi.onclick = chiudi; piede.append(bChiudi);
  disegna();
}
