// Disegna in HTML le finestre del programma (descritte da Python/htk) e rimanda a Python
// click, tasti e timer. Ogni widget tkinter diventa un elemento HTML con lo stesso aspetto
// (colori, font, disposizione pack/grid) e gli stessi comandi.

const ELS = new Map();        // id widget -> elemento
const NODI = new Map();       // id widget -> ultimo nodo ricevuto
const IMGS = new Map();       // id immagine -> data URL
const FINESTRE = new Map();   // id finestra -> {box, body, node}
const TIMER = new Map();      // id timer -> handle setTimeout
const VAR_PENDENTI = {};      // id variabile -> valore digitato non ancora inviato
let zTop = 10;
let finestraAttiva = null;
let ctx = null;               // {invia(azione) -> Promise, onOut(item), video}

export function initUI(contesto) {
  ctx = contesto;
  document.addEventListener('keydown', tastiera, true);
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.tk-menu')) chiudiMenu();
  });
}

// ------------------------------------------------------------------------------------------
// utilità di stile
// ------------------------------------------------------------------------------------------
function font(f) {
  if (!f) return null;
  let fam = 'Helvetica', size = 9, extra = [];
  if (Array.isArray(f)) { fam = f[0] || fam; size = f[1] ?? size; extra = f.slice(2).map(String); }
  else if (typeof f === 'string') {
    const m = f.match(/^\{?([^}]+?)\}?\s+(-?\d+)\s*(.*)$/);
    if (m) { fam = m[1]; size = +m[2]; extra = m[3].split(/\s+/); } else fam = f;
  }
  const fams = { helvetica: 'Helvetica, Arial, sans-serif', consolas: 'Consolas, "Courier New", monospace', courier: '"Courier New", monospace', arial: 'Arial, Helvetica, sans-serif', 'segoe ui': '"Segoe UI", Arial, sans-serif' };
  const famCss = fams[String(fam).toLowerCase()] || `"${fam}", Helvetica, Arial, sans-serif`;
  const sz = size < 0 ? `${-size}px` : `${size}pt`;
  const w = extra.flat().join(' ').includes('bold') ? 'bold ' : '';
  const it = extra.flat().join(' ').includes('italic') ? 'italic ' : '';
  return `${it}${w}${sz} ${famCss}`;
}

function pad(v) {
  if (v == null) return [0, 0];
  if (Array.isArray(v)) return [+v[0] || 0, +(v[1] ?? v[0]) || 0];
  const n = parseFloat(v) || 0; return [n, n];
}

function colore(c) {
  if (!c || typeof c !== 'string') return null;
  const nomi = { systembuttonface: '#f0f0f0', systemwindow: '#ffffff', systembuttontext: '#000000' };
  return nomi[c.toLowerCase()] || c;
}

function justifyDaAnchor(a, asse) {
  // asse 'x': w/e ; asse 'y': n/s
  a = a || 'center';
  if (a === 'center') return 'center';
  if (asse === 'x') return a.includes('w') ? 'flex-start' : (a.includes('e') ? 'flex-end' : 'center');
  return a.includes('n') ? 'flex-start' : (a.includes('s') ? 'flex-end' : 'center');
}

function testo(s) { return s == null ? '' : String(s); }

// ------------------------------------------------------------------------------------------
// aggiornamenti dal motore
// ------------------------------------------------------------------------------------------
export function applica(r) {
  for (const [id, [mime, b64]] of Object.entries(r.images || {})) IMGS.set(id, `data:${mime};base64,${b64}`);
  for (const w of r.windows || []) disegnaFinestra(w);
  for (const id of r.closed || []) chiudiFinestra(id);
  ordinaFinestre(r.order || []);
  for (const o of r.out || []) gestisciOut(o);
}

function gestisciOut(o) {
  switch (o.t) {
    case 'after': {
      const h = setTimeout(() => { TIMER.delete(o.id); ctx.invia({ a: 'timer', id: o.id }); }, Math.max(0, o.ms));
      TIMER.set(o.id, h); break;
    }
    case 'cancel': { const h = TIMER.get(o.id); if (h) clearTimeout(h); TIMER.delete(o.id); break; }
    case 'menu': mostraMenu(o); break;
    case 'lift': { const f = FINESTRE.get(o.id); if (f) attiva(o.id); break; }
    case 'scroll': {
      const el = ELS.get(o.id); if (!el) break;
      const pagina = o.what === 'pages';
      const passo = pagina ? (o.dir === 'y' ? el.clientHeight * 0.9 : el.clientWidth * 0.9) : 40;
      if (o.dir === 'y') el.scrollBy({ top: o.n * passo }); else el.scrollBy({ left: o.n * passo });
      break;
    }
    default: ctx.onOut(o);
  }
}

// ------------------------------------------------------------------------------------------
// finestre
// ------------------------------------------------------------------------------------------
function geometria(g) {
  const m = /^(\d+)x(\d+)/.exec(g || '');
  return m ? [+m[1], +m[2]] : null;
}

function disegnaFinestra(node) {
  let f = FINESTRE.get(node.id);
  const wm = (node.x && node.x.wm) || (f && f.wm) || {};
  if (!f) {
    const radice = FINESTRE.size === 0;
    const box = document.createElement('div');
    box.className = 'tk-finestra' + (radice ? ' tk-radice' : '');
    box.dataset.id = node.id;
    const barra = document.createElement('div');
    barra.className = 'tk-barra';
    barra.innerHTML = `<span class="tk-titolo"></span><span class="tk-azioni"><button class="tk-scambia" title="Passa fra elenco e video">↕</button><button class="tk-max" title="Ingrandisci">▢</button><button class="tk-x" title="Chiudi">✕</button></span>`;
    const body = document.createElement('div');
    body.className = 'tk-corpo';
    box.append(barra, body);
    document.getElementById('desktop').append(box);
    f = { box, body, barra, wm: {}, radice, posizionata: false };
    FINESTRE.set(node.id, f);
    barra.querySelector('.tk-x').onclick = () => ctx.invia({ a: 'close', id: node.id });
    barra.querySelector('.tk-max').onclick = () => { box.classList.toggle('tk-massimizzata'); };
    // schermi stretti: se il contenuto e' piu' largo della finestra (elenco + video affiancati) compare il tasto ↔ che porta all'altro lato
    const bS = barra.querySelector('.tk-scambia');
    // elenco e video sono uno sopra l'altro dentro il riquadro a due parti (che scorre in verticale); se non c'e', si scorre di lato
    const duePezzi = () => { const pn = body.querySelector('.tk-paned-o'); return pn && pn.scrollHeight > pn.clientHeight + 20 ? pn : null; };
    bS.onclick = () => {
      const pn = duePezzi();
      if (pn) { pn.scrollTo({ top: pn.scrollTop > 10 ? 0 : pn.scrollHeight, behavior: 'smooth' }); return; }
      body.scrollTo({ left: body.scrollLeft > 10 ? 0 : body.scrollWidth, behavior: 'smooth' });
    };
    let aggiorna = 0;
    const aggiornaTasto = () => { aggiorna = 0; bS.classList.toggle('ha-scorrimento', !!duePezzi() || body.scrollWidth > body.clientWidth + 20); };
    const programma = () => { if (!aggiorna) aggiorna = requestAnimationFrame(aggiornaTasto); };
    new ResizeObserver(programma).observe(body);
    new MutationObserver(programma).observe(body, { childList: true, subtree: true });
    if (radice) { barra.querySelector('.tk-x').remove(); bS.remove(); }
    box.addEventListener('mousedown', () => attiva(node.id), true);
    trascinabile(box, barra);
  }
  if (node.x && node.x.wm) f.wm = node.x.wm;
  f.barra.querySelector('.tk-titolo').textContent = f.wm.title || '';
  if (f.radice) document.title = f.wm.title || 'DivoArido';
  adattaElencoClip(f);
  const el = disegna(node);
  if (el !== f.body.firstChild) { f.body.replaceChildren(el); }
  el.classList.add('tk-root');
  // dimensioni e stato
  f.box.classList.toggle('tk-nascosta', !!f.wm.withdrawn);
  f.box.classList.toggle('tk-modale', !!f.wm.modal);
  f.box.classList.toggle('tk-sopra', !!f.wm.topmost);
  const eraFull = f.box.classList.contains('tk-fullscreen');
  f.box.classList.toggle('tk-fullscreen', !!f.wm.fullscreen);
  if (f.wm.fullscreen && !eraFull) {
    try { document.documentElement.requestFullscreen?.()?.then?.(() => { if (tocco()) screen.orientation?.lock?.('landscape')?.catch?.(() => {}); }, () => {}); } catch (e) {}
  }
  if (!f.wm.fullscreen && eraFull) {
    try { screen.orientation?.unlock?.(); } catch (e) {}
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
  }
  aggiornaVelo();
  if (!f.radice && !f.posizionata) {
    const g = geometria(f.wm.geometry);
    const W = window.innerWidth, H = window.innerHeight - 8;
    let w = g ? g[0] : null, h = g ? g[1] : null;
    if (w) { w = Math.min(w, W - 16); f.box.style.width = w + 'px'; }
    if (h) { h = Math.min(h + 30, H - 16); f.box.style.height = h + 'px'; }
    requestAnimationFrame(() => {
      const bw = f.box.offsetWidth, bh = f.box.offsetHeight;
      const n = [...FINESTRE.values()].filter((x) => !x.radice).length - 1;
      const sp = (n % 6) * 26;
      f.box.style.left = Math.max(4, Math.round((W - bw) / 2) + sp - 60) + 'px';
      f.box.style.top = Math.max(4, Math.min(Math.round((H - bh) / 3) + sp, H - bh)) + 'px';
    });
    f.posizionata = true;
    attiva(node.id);
  }
}

function aggiornaVelo() {
  const modale = [...FINESTRE.values()].some((f) => f.wm.modal && !f.wm.withdrawn);
  document.getElementById('velo').classList.toggle('attivo', modale);
  // a schermo intero la barra in alto della pagina (z-index 50) copriva l'angolo del video con il punteggio: si nasconde
  document.documentElement.classList.toggle('scena-intera', [...FINESTRE.values()].some((x) => x.box.classList.contains('tk-fullscreen') && !x.wm.withdrawn));
}

// Elenco delle clip a schermo intero (finestra «Elenco Clip», sempre in primo piano): come la barra dell'exe, vista NORMALE o TRASPARENTE
// (quasi invisibile sopra il video, torna piena col mouse sopra) e RIDUCI A ICONA (tasto L o clic sull'icona per riaprirla).
// La vista scelta resta nel browser. 21/11/2026.
// Telefono e tablet (schermo stretto o tocco): lo schermo intero e' una scena unica (video + punteggio + comandi) e l'elenco delle clip e' un
// cassetto sul bordo destro che si apre con la linguetta ☰ e si richiude da solo quando si sceglie una clip. 24/11/2026.
const MQ_TOCCO = window.matchMedia ? window.matchMedia('(max-width: 820px), (pointer: coarse)') : null;
function tocco() { return !!(MQ_TOCCO && MQ_TOCCO.matches); }
function segnaTocco() { document.documentElement.classList.toggle('tocco', tocco()); }
segnaTocco();
if (MQ_TOCCO) { try { MQ_TOCCO.addEventListener('change', segnaTocco); } catch (e) { try { MQ_TOCCO.addListener(segnaTocco); } catch (e2) {} } }

function adattaElencoClip(f) {
  if (f.elencoClip || f.radice || f.wm.title !== 'Elenco Clip') return;
  f.elencoClip = true;
  f.box.classList.add('tk-elenco');
  const xs = f.barra.querySelector('.tk-x'); if (xs) xs.title = 'Esci dallo schermo intero';
  const az = f.barra.querySelector('.tk-azioni');
  const bT = document.createElement('button'); bT.className = 'tk-trasp-b'; bT.title = 'Vista trasparente / normale'; bT.textContent = '◌';
  const bR = document.createElement('button'); bR.className = 'tk-riduci'; bR.title = 'Riduci a icona (tasto L)'; bR.textContent = '▁';
  az.prepend(bT, bR);
  let trasp = false;
  try { trasp = localStorage.getItem('vps_elenco_trasp') === '1'; } catch (e) {}
  const applica = () => { f.box.classList.toggle('tk-trasp', trasp); bT.textContent = trasp ? '◉' : '◌'; };
  applica();
  bT.onclick = () => { trasp = !trasp; try { localStorage.setItem('vps_elenco_trasp', trasp ? '1' : '0'); } catch (e) {} applica(); };
  const ic = document.createElement('button'); ic.id = 'elenco-icona'; ic.hidden = true; ic.textContent = '☰'; ic.title = "Riapri l'elenco delle clip (tasto L)";
  document.body.append(ic);
  f.icona = ic;
  f.riduciElenco = (si) => { f.box.classList.toggle('tk-ridotta', si); ic.hidden = !si; if (!si) attiva([...FINESTRE].find(([, x]) => x === f)?.[0]); };
  bR.onclick = () => f.riduciElenco(true);
  ic.onclick = () => f.riduciElenco(false);
  // telefono/tablet: si parte con il solo bordo (linguetta); scegliendo una clip dall'elenco il cassetto si richiude e il video resta libero
  if (tocco()) f.riduciElenco(true);
  f.body.addEventListener('click', (e) => { if (tocco() && e.target.closest && e.target.closest('tr')) setTimeout(() => f.riduciElenco(true), 350); });
}
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'l' && e.key !== 'L') || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  const f = [...FINESTRE.values()].find((x) => x.elencoClip);
  if (!f) return;
  e.preventDefault(); e.stopImmediatePropagation();
  f.riduciElenco(!f.box.classList.contains('tk-ridotta'));
}, true);

function chiudiFinestra(id) {
  const f = FINESTRE.get(id);
  if (!f) return;
  if (f.icona) f.icona.remove();
  if (f.wm.fullscreen && document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
  f.box.remove();
  FINESTRE.delete(id);
  // pulizia degli elementi dei widget della finestra
  for (const [wid, el] of ELS) if (!el.isConnected) { ELS.delete(wid); NODI.delete(wid); }
  ctx.video?.pulisci?.();
  aggiornaVelo();
  if (finestraAttiva === id) {
    const ultime = [...FINESTRE.keys()];
    finestraAttiva = ultime[ultime.length - 1] || null;
  }
}

function ordinaFinestre(order) {
  for (const id of [...FINESTRE.keys()]) if (!order.includes(id)) chiudiFinestra(id);
}

function attiva(id) {
  const f = FINESTRE.get(id);
  if (!f) return;
  finestraAttiva = id;
  if (!f.radice) f.box.style.zIndex = String(++zTop + (f.wm.topmost ? 5000 : 0) + (f.wm.modal ? 2000 : 0));
  for (const [k, x] of FINESTRE) x.box.classList.toggle('tk-attiva', k === id);
}

function trascinabile(box, barra) {
  let dx = 0, dy = 0, su = false;
  barra.addEventListener('pointerdown', (e) => {
    if (box.classList.contains('tk-radice') || e.target.closest('button')) return;
    su = true; dx = e.clientX - box.offsetLeft; dy = e.clientY - box.offsetTop;
  });
  window.addEventListener('pointermove', (e) => {
    if (!su) return;
    box.style.left = Math.max(-box.offsetWidth + 80, Math.min(window.innerWidth - 60, e.clientX - dx)) + 'px';
    box.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - dy)) + 'px';
  });
  window.addEventListener('pointerup', () => { su = false; });
  window.addEventListener('pointercancel', () => { su = false; });
  barra.addEventListener('dblclick', () => { if (!box.classList.contains('tk-radice')) box.classList.toggle('tk-massimizzata'); });
}

// ------------------------------------------------------------------------------------------
// disegno dei widget
// ------------------------------------------------------------------------------------------
const TAG = { frame: 'div', labelframe: 'fieldset', label: 'div', button: 'button', entry: 'input', combobox: 'select',
  listbox: 'div', treeview: 'div', notebook: 'div', canvas: 'div', paned: 'div', scrollbar: 'div', menu: 'div',
  window: 'div', checkbutton: 'label', radiobutton: 'label', scale: 'div', text: 'div', spinbox: 'input' };

function disegna(node) {
  if (node.same) {
    const el = ELS.get(node.id);
    if (el) return el;
    // elemento perso (non dovrebbe succedere): si chiede di ridisegnare tutto
    ctx.ridisegnaTutto?.();
    const ph = document.createElement('div'); ELS.set(node.id, ph); return ph;
  }
  const k = node.k;
  let el = ELS.get(node.id);
  const tagVoluto = (k === 'combobox' && !comboReadonly(node)) ? 'input' : (TAG[k] || 'div');
  if (!el || el.tagName.toLowerCase() !== tagVoluto || el.dataset.k !== k) {
    const nuovo = document.createElement(tagVoluto);
    nuovo.dataset.k = k; nuovo.dataset.id = node.id;
    if (el && el.parentNode) el.replaceWith(nuovo);
    el = nuovo;
    ELS.set(node.id, el);
    collegaEventi(el, node);
  }
  NODI.set(node.id, node);
  const kw = node.kw || {};
  stileBase(el, node, kw);
  if (node.b && node.b.includes('<Configure>') && !el._ro) osservaDimensioni(el, node.id);
  switch (k) {
    case 'label': disegnaLabel(el, node, kw); break;
    case 'button': case 'checkbutton': case 'radiobutton': disegnaBottone(el, node, kw); break;
    case 'entry': disegnaEntry(el, node, kw); break;
    case 'spinbox': disegnaEntry(el, node, kw); el.type = 'number'; if (kw.from_ != null) el.min = kw.from_; if (kw.to != null) el.max = kw.to; if (kw.increment) el.step = kw.increment; break;
    case 'text': disegnaText(el, node, kw); break;
    case 'combobox': disegnaCombo(el, node, kw); break;
    case 'listbox': disegnaListbox(el, node, kw); break;
    case 'treeview': disegnaTree(el, node, kw); break;
    case 'notebook': disegnaNotebook(el, node, kw); break;
    case 'paned': disegnaPaned(el, node, kw); break;
    case 'canvas': disegnaCanvas(el, node, kw); break;
    case 'scrollbar': case 'menu': el.style.display = 'none'; break;
    case 'labelframe': disegnaLabelframe(el, node, kw); break;
    default: disegnaContenitore(el, node, kw);
  }
  return el;
}

function stileBase(el, node, kw) {
  const s = el.style;
  const bg = colore(kw.bg || kw.background);
  s.backgroundColor = bg || '';
  const fg = colore(kw.fg || kw.foreground);
  s.color = fg || '';
  const f = font(kw.font);
  s.font = f || '';
  if (kw.cursor === 'hand2' || kw.cursor === 'hand1') s.cursor = 'pointer';
  const tipiConTesto = ['label', 'button', 'checkbutton', 'radiobutton', 'entry', 'spinbox', 'combobox', 'listbox'];
  // larghezza/altezza "in caratteri" (widget di testo) o in pixel (frame, canvas)
  s.width = ''; s.height = ''; s.minWidth = ''; s.minHeight = ''; s.flexBasis = '';
  if (tipiConTesto.includes(node.k)) {
    if (kw.width && !kw.image) {
      const extra = node.k === 'entry' || node.k === 'spinbox' || node.k === 'combobox' ? (node.k === 'spinbox' ? 26 : 10) : (2 * (pad(kw.padx)[0] || (node.k === 'button' ? 4 : 1)));
      s.width = `calc(${kw.width}ch + ${extra + (node.k === 'combobox' ? 18 : 0)}px)`;
      s.minWidth = s.width;
    }
  } else if (['frame', 'canvas', 'labelframe'].includes(node.k)) {
    const senzaFigli = !(node.po && node.po.length) && !(node.ch || []).some((c) => (NODI.get(c.id) || c).L);
    if (node.noprop || senzaFigli) {
      if (kw.width) { s.width = kw.width + 'px'; s.minWidth = kw.width + 'px'; }
      if (kw.height) { s.height = kw.height + 'px'; s.minHeight = node.noprop ? '' : kw.height + 'px'; s.flexBasis = kw.height + 'px'; }
    } else if (node.k === 'canvas') {
      if (kw.width) s.width = kw.width + 'px';
      if (kw.height) s.height = kw.height + 'px';
    }
  }
  if (kw.state === 'disabled') el.classList.add('tk-disabilitato'); else el.classList.remove('tk-disabilitato');
  const rel = kw.relief;
  el.classList.toggle('tk-rilievo', rel === 'raised' || rel === 'groove' || rel === 'ridge' || rel === 'sunken' || rel === 'solid');
  const hb = colore(kw.highlightbackground), hc = colore(kw.highlightcolor);
  if (kw.highlightthickness && (hb || hc)) {
    s.boxShadow = `inset 0 0 0 ${kw.highlightthickness}px ${hb || hc}`;
    el.style.setProperty('--tk-focus', hc || hb);
  } else { s.boxShadow = ''; }
}

function disegnaLabel(el, node, kw) {
  el.classList.add('tk-label');
  const [px, py] = pad(kw.padx ?? 1), [, pyy] = pad(kw.pady ?? 1);
  el.style.padding = `${pyy}px ${px}px`;
  el.style.justifyContent = justifyDaAnchor(kw.anchor || 'center', 'x');
  el.style.alignItems = justifyDaAnchor(kw.anchor || 'center', 'y');
  const anc = kw.anchor && kw.anchor !== 'center' ? kw.anchor : '';
  el.style.textAlign = kw.justify || (anc.includes('w') ? 'left' : (anc.includes('e') ? 'right' : 'center'));
  const wl = parseFloat(kw.wraplength) || 0;
  el.style.whiteSpace = wl ? 'pre-wrap' : 'pre';
  el.style.maxWidth = wl ? wl + 'px' : '';
  const img = kw.image && kw.image.img;
  let t = node.val != null && kw.textvariable ? testo(node.val) : testo(kw.text);
  const firma = JSON.stringify([t, img]);
  if (el.dataset.firma !== firma) {
    el.dataset.firma = firma;
    el.replaceChildren();
    if (img) {
      const im = document.createElement('img');
      im.src = IMGS.get(img) || '';
      im.draggable = false;
      el.append(im);
      el.classList.add('tk-immagine');
    } else el.classList.remove('tk-immagine');
    if (t) { const sp = document.createElement('span'); sp.textContent = t; el.append(sp); }
  }
  el.classList.toggle('tk-cliccabile', !!(node.b && node.b.some((b) => /Button|ButtonRelease/.test(b))));
}

function disegnaBottone(el, node, kw) {
  el.classList.add('tk-bottone');
  el.type = 'button';
  let t = testo(kw.text);
  if (node.k === 'checkbutton' || node.k === 'radiobutton') {         // stato della casella/del pulsante di scelta (arriva dal programma in node.x.on)
    const on = !!(node.x && node.x.on);
    if (kw.indicatoron === false) el.style.boxShadow = on ? 'inset 0 0 0 2px #8b5cf6' : '';
    else t = (node.k === 'radiobutton' ? (on ? '◉ ' : '○ ') : (on ? '☑ ' : '☐ ')) + t;
  }
  if (el.textContent !== t) el.textContent = t;
  const [px] = pad(kw.padx ?? 4), [, py] = pad(kw.pady ?? 1);
  el.style.padding = `${py}px ${px}px`;
  el.disabled = kw.state === 'disabled';
  const ab = colore(kw.activebackground);
  el.style.setProperty('--tk-hover', ab || '');
  if (kw.anchor === 'w') el.style.textAlign = 'left'; else el.style.textAlign = '';
  if (!kw.bg && !kw.background) el.classList.add('tk-bottone-std'); else el.classList.remove('tk-bottone-std');
}

function disegnaEntry(el, node, kw) {
  el.classList.add('tk-entry');
  const v = testo(node.val);
  const vid = kw.textvariable && kw.textvariable.var;
  el.dataset.var = vid || '';
  if (document.activeElement !== el && el.value !== v && !(vid in VAR_PENDENTI)) el.value = v;
  if (vid in VAR_PENDENTI && VAR_PENDENTI[vid] === v) delete VAR_PENDENTI[vid];
  el.style.textAlign = kw.justify || 'left';
  el.type = kw.show ? 'password' : 'text';
  el.disabled = kw.state === 'disabled';
  el.spellcheck = false;
  el.style.caretColor = colore(kw.insertbackground) || '';
}

function comboReadonly(node) {
  const st = (node.kw || {}).state;
  return st === 'readonly' || st === 'disabled' || (Array.isArray((node.kw || {}).values) && st !== 'normal');
}

function disegnaCombo(el, node, kw) {
  el.classList.add('tk-combo');
  const vid = kw.textvariable && kw.textvariable.var;
  el.dataset.var = vid || '';
  let vals = kw.values;
  if (typeof vals === 'string') vals = vals ? vals.split(' ') : [];
  vals = (vals || []).map(String);
  const v = testo(node.val);
  if (el.tagName === 'SELECT') {
    const firma = JSON.stringify(vals);
    if (el.dataset.firma !== firma || !vals.includes(v)) {
      el.dataset.firma = firma;
      el.replaceChildren();
      const tutti = vals.includes(v) || v === '' ? vals : [v, ...vals];
      if (!tutti.length) tutti.push('');
      for (const x of tutti) { const o = document.createElement('option'); o.value = x; o.textContent = x; el.append(o); }
    }
    el.value = v;
    el.disabled = kw.state === 'disabled';
  } else {
    if (document.activeElement !== el && el.value !== v) el.value = v;
    let dl = el._datalist;
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'dl-' + node.id; el._datalist = dl; document.body.append(dl); el.setAttribute('list', dl.id); }
    dl.replaceChildren(...vals.map((x) => { const o = document.createElement('option'); o.value = x; return o; }));
  }
}

function disegnaListbox(el, node, kw) {
  el.classList.add('tk-listbox');
  const { items = [], sel = [] } = node.x || {};
  const h = kw.height || 10;
  const f = font(kw.font);
  el.style.minHeight = `calc(${h} * 1.45em)`;
  el.style.maxHeight = `calc(${Math.max(h, 4)} * 1.45em + 4px)`;
  el.replaceChildren();
  const sb = colore(kw.selectbackground) || '#3b82f6';
  items.forEach((t, i) => {
    const r = document.createElement('div');
    r.className = 'tk-lb-riga' + (sel.includes(i) ? ' sel' : '');
    if (sel.includes(i)) { r.style.background = sb; r.style.color = colore(kw.selectforeground) || '#fff'; }
    r.textContent = t;
    r.title = t;
    r.dataset.i = i;
    el.append(r);
  });
  el._sel = new Set(sel);
  el._mode = kw.selectmode || 'browse';
}

function disegnaTree(el, node, kw) {
  el.classList.add('tk-tree');
  const x = node.x || {};
  const stile = (window.__TK_STYLES__ || {})[kw.style] || {};
  const mappa = (window.__TK_STYLE_MAPS__ || {})[kw.style] || {};
  const show = String(kw.show || 'tree headings');
  const conAlbero = show.includes('tree');
  el.dataset.albero = conAlbero ? '1' : '';
  const conIntest = show.includes('headings');
  const cols = (x.cols || []);
  const colopt = x.colopt || {};
  const head = x.head || {};
  const rh = stile.rowheight || 20;
  const fRighe = font(stile.font) || '9pt Helvetica, Arial, sans-serif';
  const bgSel = (mappa.background || []).find?.((p) => Array.isArray(p) && p[0] === 'selected')?.[1] || '#3b82f6';
  const fgSel = (mappa.foreground || []).find?.((p) => Array.isArray(p) && p[0] === 'selected')?.[1] || '#fff';
  el.style.setProperty('--sel-bg', bgSel); el.style.setProperty('--sel-fg', fgSel);
  el.style.background = colore(stile.fieldbackground || stile.background) || '';
  el.style.color = colore(stile.foreground) || '';
  const nRighe = kw.height || 10;
  el.style.height = (nRighe * rh + (conIntest ? 26 : 2)) + 'px';
  el.style.minHeight = Math.min(nRighe, 3) * rh + 26 + 'px';
  const tutte = (conAlbero ? ['#0'] : []).concat(cols);
  const firmaTesta = JSON.stringify([tutte, head, colopt, conIntest, stile, kw.style]);
  let tab = el._tab;
  if (!tab || el.dataset.firmaTesta !== firmaTesta) {
    el.dataset.firmaTesta = firmaTesta;
    el.replaceChildren();
    tab = document.createElement('table');
    tab.className = 'tk-tabella';
    const cg = document.createElement('colgroup');
    for (const c of tutte) {
      const co = document.createElement('col');
      const w = (colopt[c] || {}).width || (c === '#0' ? 30 : 100);
      co.style.width = w + 'px';
      cg.append(co);
    }
    tab.append(cg);
    if (conIntest) {
      const th = document.createElement('thead');
      const tr = document.createElement('tr');
      const hs = (window.__TK_STYLES__ || {})[(kw.style || 'Treeview') + '.Heading'] || {};
      for (const c of tutte) {
        const t = document.createElement('th');
        t.textContent = (head[c] || {}).text || '';
        if (hs.background) t.style.background = hs.background;
        if (hs.foreground) t.style.color = hs.foreground;
        if (hs.font) t.style.font = font(hs.font);
        tr.append(t);
      }
      th.append(tr); tab.append(th);
    }
    const tb = document.createElement('tbody');
    tab.append(tb);
    el.append(tab);
    el._tab = tab;
    el._righe = new Map();
  }
  const tb = tab.tBodies[0];
  if (x.rows) el._rows = x.rows;
  else if (el.dataset.firmaTesta !== firmaTesta || !el._rows) el._rows = el._rows || [];
  const righeDati = el._rows || [];
  const sel = new Set(x.sel || []);
  const tags = x.tags || {};
  const visti = new Set();
  let prec = null;
  for (const [iid, vals, rtags, img, txt] of righeDati) {
    visti.add(iid);
    const firma = JSON.stringify([vals, rtags, img, txt, sel.has(iid)]);
    let tr = el._righe.get(iid);
    if (!tr || tr.dataset.firma !== firma) {
      const nuovo = document.createElement('tr');
      nuovo.dataset.iid = iid;
      nuovo.dataset.firma = firma;
      nuovo.style.height = rh + 'px';
      nuovo.style.font = fRighe;
      let bg = '', fg = '', fnt = '';
      for (const t of rtags) {
        const o = tags[t] || {};
        if (o.background) bg = o.background;
        if (o.foreground) fg = o.foreground;
        if (o.font) fnt = font(o.font);
      }
      if (bg) nuovo.style.background = bg;
      if (fg) nuovo.style.color = fg;
      if (fnt) nuovo.style.font = fnt;
      if (sel.has(iid)) nuovo.classList.add('sel');
      if (conAlbero) {
        const td = document.createElement('td');
        td.className = 'tk-td0';
        if (img && IMGS.get(img)) { const im = document.createElement('img'); im.src = IMGS.get(img); im.draggable = false; td.append(im); }
        else td.textContent = txt || '';
        nuovo.append(td);
      }
      cols.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = vals[i] == null ? '' : String(vals[i]);
        const an = (colopt[c] || {}).anchor || 'w';
        td.style.textAlign = an === 'center' ? 'center' : (an.includes('e') ? 'right' : 'left');
        nuovo.append(td);
      });
      if (tr) tr.replaceWith(nuovo);
      tr = nuovo;
      el._righe.set(iid, tr);
    }
    // ordine
    const atteso = prec ? prec.nextSibling : tb.firstChild;
    if (atteso !== tr) tb.insertBefore(tr, atteso);
    prec = tr;
  }
  for (const [iid, tr] of el._righe) if (!visti.has(iid)) { tr.remove(); el._righe.delete(iid); }
  if (x.see) {
    const tr = el._righe.get(x.see);
    if (tr) requestAnimationFrame(() => {
      const r = tr.getBoundingClientRect(), c = el.getBoundingClientRect();
      // si fa scorrere solo l'elenco stesso (scrollIntoView farebbe scorrere anche la pagina, sul telefono salterebbe via dalla vista)
      if (r.top < c.top + 24) el.scrollTop -= (c.top + 24 - r.top);
      else if (r.bottom > c.bottom) el.scrollTop += (r.bottom - c.bottom);
    });
  }
}

function disegnaNotebook(el, node, kw) {
  el.classList.add('tk-notebook');
  const x = node.x || {};
  const stileTab = (window.__TK_STYLES__ || {})[(kw.style || 'TNotebook') + '.Tab'] || {};
  const mappaTab = (window.__TK_STYLE_MAPS__ || {})[(kw.style || 'TNotebook') + '.Tab'] || {};
  const selBg = (mappaTab.background || []).find?.((p) => p[0] === 'selected')?.[1];
  let testa = el._testa, corpo = el._corpo;
  if (!testa) {
    testa = document.createElement('div'); testa.className = 'tk-nb-testa';
    corpo = document.createElement('div'); corpo.className = 'tk-nb-corpo';
    el.append(testa, corpo); el._testa = testa; el._corpo = corpo;
  }
  if (el._sel == null || el._selProgramma !== (x.sel || 0)) { el._sel = x.sel || 0; el._selProgramma = x.sel || 0; }
  const figli = new Map((node.ch || []).map((c) => [c.id, c]));
  testa.replaceChildren();
  const tabs = x.tabs || [];
  if (el._sel >= tabs.length) el._sel = 0;
  tabs.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'tk-nb-tab' + (i === el._sel ? ' sel' : '');
    b.textContent = t.text;
    b.style.background = i === el._sel ? (selBg || '#8b5cf6') : (stileTab.background || '');
    b.style.color = i === el._sel ? '#fff' : (stileTab.foreground || '');
    b.onclick = () => {
      el._sel = i; el._selProgramma = i;
      const n0 = NODI.get(node.id);
      if (n0 && n0.x) n0.x.sel = i;          // il nodo ricevuto dal programma dice ancora la scheda di prima: senza questo il ridisegno la rimette com'era
      ctx.invia({ a: 'notebook', id: node.id, i });
      disegnaNotebook(el, n0, kw);
    };
    testa.append(b);
  });
  const pagine = tabs.map((t) => {
    const c = figli.get(t.id);
    return c ? disegna(c) : ELS.get(t.id);
  });
  corpo.replaceChildren(...pagine.filter(Boolean));
  pagine.forEach((p, i) => { if (p) { p.style.display = i === el._sel ? '' : 'none'; p.classList.add('tk-nb-pagina'); } });
  // figli non schede (raro)
  for (const c of node.ch || []) if (!tabs.some((t) => t.id === c.id)) disegna(c);
}

function disegnaPaned(el, node, kw) {
  el.classList.add('tk-paned');
  el.classList.toggle('tk-paned-o', (kw.orient || 'horizontal') === 'horizontal');
  const orient = kw.orient || 'horizontal';
  el.style.flexDirection = orient === 'horizontal' ? 'row' : 'column';
  const figli = new Map((node.ch || []).map((c) => [c.id, c]));
  const panes = (node.x || {}).panes || [];
  const elems = [];
  panes.forEach((pid, i) => {
    const c = figli.get(pid);
    const pe = c ? disegna(c) : ELS.get(pid);
    if (!pe) return;
    const nodo = NODI.get(pid) || c || {};
    const opz = (nodo.L && nodo.L[1]) || {};
    pe.classList.add('tk-pane');
    if (!pe.dataset.ridim) {
      if (i < panes.length - 1 && opz.width) { pe.style.flex = `0 0 ${opz.width}px`; }
      else pe.style.flex = '1 1 0';
    }
    elems.push(pe);
    if (i < panes.length - 1) {
      let sash = el.querySelector(`:scope > .tk-sash[data-dopo="${pid}"]`);
      if (!sash) { sash = document.createElement('div'); sash.className = 'tk-sash'; sash.dataset.dopo = pid; trascinaSash(sash, () => ELS.get(pid), orient); }
      sash.style.background = colore(kw.bg) || '';
      sash.style.flex = `0 0 ${kw.sashwidth || 4}px`;
      elems.push(sash);
    }
  });
  for (const c of node.ch || []) if (!panes.includes(c.id)) disegna(c);
  sostituisciFigli(el, elems);
}

function trascinaSash(sash, paneEl, orient) {
  sash.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = paneEl(); if (!p) return;
    const inizio = orient === 'horizontal' ? e.clientX : e.clientY;
    const dim = orient === 'horizontal' ? p.offsetWidth : p.offsetHeight;
    const muovi = (ev) => {
      const d = (orient === 'horizontal' ? ev.clientX : ev.clientY) - inizio;
      p.style.flex = `0 0 ${Math.max(60, dim + d)}px`; p.dataset.ridim = '1';
    };
    const fine = () => { window.removeEventListener('pointermove', muovi); window.removeEventListener('pointerup', fine); window.removeEventListener('pointercancel', fine); };
    window.addEventListener('pointermove', muovi); window.addEventListener('pointerup', fine); window.addEventListener('pointercancel', fine);
  });
}

function disegnaCanvas(el, node, kw) {
  el.classList.add('tk-canvas');
  const elems = [];
  for (const c of node.ch || []) {
    const ce = disegna(c);
    const nodo = NODI.get(c.id) || c;
    if (nodo.L && nodo.L[0] === 'canvas') { ce.classList.add('tk-canvas-finestra'); elems.push(ce); }
  }
  const x = node.x || {};
  if (x.items && x.items.length) {
    let svg = el._svg;
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('tk-extra', 'tk-canvas-svg');
      el._svg = svg;
    }
    svg.innerHTML = svgElementi(x.items, new Set(x.tb || []));
    if (svg.parentNode !== el) el.prepend(svg);
  } else if (el._svg) { el._svg.innerHTML = ''; }
  el._tb = new Set(x.tb || []);
  sostituisciFigli(el, elems);
  if (el._svg && el._svg.parentNode !== el) el.prepend(el._svg);
}

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function svgElementi(items, tb) {
  const out = [], defs = new Map();
  const freccia = (col) => {
    const id = 'fr' + col.replace(/[^a-zA-Z0-9]/g, '');
    if (!defs.has(id)) defs.set(id, `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${col}"/></marker>`);
    return id;
  };
  for (const [iid, t, c, o, tags] of items) {
    const cliccabile = tags.concat([String(iid)]).some((g) => tb.has(g + '|<Button-1>'));
    const base = `data-iid="${iid}" data-tags="${esc(tags.join(' '))}"${cliccabile ? ' class="tk-cliccabile"' : ''}`;
    const w = o.width != null ? +o.width : 1;
    const dash = o.dash ? ` stroke-dasharray="${esc([].concat(o.dash).join(' '))}"` : '';
    const fill = colore(o.fill), outl = colore(o.outline);
    if (t === 'rect' || t === 'oval') {
      const [x0, y0, x1, y1] = c;
      const f = fill || 'none', st = o.outline === '' ? 'none' : (outl || '#000');
      const geo = t === 'rect' ? `<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}"`
        : `<ellipse cx="${(x0 + x1) / 2}" cy="${(y0 + y1) / 2}" rx="${Math.abs(x1 - x0) / 2}" ry="${Math.abs(y1 - y0) / 2}"`;
      out.push(`${geo} ${base} fill="${f}" stroke="${st}" stroke-width="${st === 'none' ? 0 : w}"${dash}/>`);
    } else if (t === 'line') {
      const st = fill || (o.fill === '' ? 'none' : '#000');
      const pts = []; for (let i = 0; i + 1 < c.length; i += 2) pts.push(c[i] + ',' + c[i + 1]);
      let mk = '';
      if (o.arrow && o.arrow !== 'none' && st !== 'none') {
        const id = freccia(st);
        if (o.arrow === 'last' || o.arrow === 'both') mk += ` marker-end="url(#${id})"`;
        if (o.arrow === 'first' || o.arrow === 'both') mk += ` marker-start="url(#${id})"`;
      }
      const cap = o.capstyle === 'round' ? ' stroke-linecap="round"' : '';
      out.push(`<polyline points="${pts.join(' ')}" ${base} fill="none" stroke="${st}" stroke-width="${w}"${dash}${cap}${mk}/>`);
    } else if (t === 'poly') {
      const pts = []; for (let i = 0; i + 1 < c.length; i += 2) pts.push(c[i] + ',' + c[i + 1]);
      const f = o.fill === '' ? 'none' : (fill || '#000'); const st = outl || 'none';
      out.push(`<polygon points="${pts.join(' ')}" ${base} fill="${f}" stroke="${st}" stroke-width="${st === 'none' ? 0 : w}"${dash}/>`);
    } else if (t === 'text') {
      const a = o.anchor || 'center';
      const ta = a.includes('w') ? 'start' : (a.includes('e') ? 'end' : 'middle');
      const righe = String(o.text ?? '').split('\n');
      const fs = font(o.font) || '9pt Helvetica, Arial, sans-serif';
      const lh = 1.2;
      const n = righe.length;
      const dy0 = a.startsWith('n') ? 0.8 : (a.startsWith('s') ? -(n - 1) * lh - 0.2 : -(n - 1) * lh / 2 + 0.35);
      const tspan = righe.map((r, i) => `<tspan x="${c[0]}" dy="${i === 0 ? dy0 : lh}em">${esc(r)}</tspan>`).join('');
      out.push(`<text x="${c[0]}" y="${c[1]}" ${base} text-anchor="${ta}" style="font:${esc(fs)}" fill="${fill || (o.fill === '' ? 'none' : '#000')}">${tspan}</text>`);
    } else if (t === 'image') {
      const src = IMGS.get(o.image); if (!src) continue;
      const iw = +o.iw || 0, ih = +o.ih || 0;
      const a = o.anchor || 'center';
      let x = c[0], y = c[1];
      if (!a.includes('w')) x -= a.includes('e') ? iw : iw / 2;
      if (!a.includes('n')) y -= a.includes('s') ? ih : ih / 2;
      out.push(`<image href="${src}" x="${x}" y="${y}" width="${iw}" height="${ih}" ${base} preserveAspectRatio="none"/>`);
    }
  }
  return (defs.size ? `<defs>${[...defs.values()].join('')}</defs>` : '') + out.join('');
}

function disegnaText(el, node, kw) {
  el.classList.add('tk-text');
  const t = (node.x && node.x.text) || '';
  if (el.textContent !== t) el.textContent = t;
}

// <Configure>: il programma riceve le dimensioni reali dell'elemento (es. campo che si adatta)
function osservaDimensioni(el, id) {
  let timer = null, ultima = '';
  el._ro = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const w = Math.round(el.clientWidth), h = Math.round(el.clientHeight);
      if (!w || !h || `${w}x${h}` === ultima) return;
      ultima = `${w}x${h}`;
      ctx.invia({ a: 'configure', id, w, h }, { silenzioso: true });
    }, 120);
  });
  el._ro.observe(el);
}

function disegnaLabelframe(el, node, kw) {
  el.classList.add('tk-labelframe');
  let lg = el._legend;
  if (!lg) { lg = document.createElement('legend'); el._legend = lg; }
  lg.textContent = testo(kw.text);
  lg.style.font = font(kw.font) || '';
  lg.style.color = colore(kw.fg) || '';
  disegnaContenitore(el, node, kw, [lg]);
}

// -- contenitori: pack / grid ---------------------------------------------------------------
function disegnaContenitore(el, node, kw, prima = []) {
  el.classList.add('tk-cont');
  const figli = node.ch || [];
  const nodiFigli = figli.map((c) => { const e = disegna(c); return { e, n: NODI.get(c.id) || c }; });
  const packati = (node.po || []).map((id) => nodiFigli.find((x) => x.n.id === id)).filter((x) => x && x.n.L && x.n.L[0] === 'pack');
  const grigliati = nodiFigli.filter((x) => x.n.L && x.n.L[0] === 'grid');
  const piazzati = nodiFigli.filter((x) => x.n.L && x.n.L[0] === 'place');
  if (grigliati.length) {
    disponiGriglia(el, grigliati, node, prima);
  } else {
    el.style.display = 'flex';
    el.style.gridTemplateColumns = '';
    disponiPack(el, packati, prima);
  }
  for (const p of piazzati) { p.e.style.position = 'absolute'; el.append(p.e); }
}

function sostituisciFigli(el, elems) {
  const extra = [...el.children].filter((c) => c.classList.contains('tk-extra'));
  const attuali = [...el.children].filter((c) => !c.classList.contains('tk-extra'));
  if (attuali.length === elems.length && attuali.every((c, i) => c === elems[i])) return;
  el.replaceChildren(...elems, ...extra);
}

function firmaLayout(items) {
  return items.map((x) => x.n.id + ':' + JSON.stringify(x.n.L)).join('|');
}

function disponiPack(el, items, prima) {
  const firma = firmaLayout(items) + '#' + prima.length;
  if (el.dataset.firmaLayout === firma && el._packEls && items.every((x, i) => x.e === el._packEls[i])) {
    items.forEach((x) => applicaPackFiglio(x.e, x.n.L[1], x.e.parentElement && x.e.parentElement.dataset.asse));
    return;
  }
  el.dataset.firmaLayout = firma;
  el._packEls = items.map((x) => x.e);
  const extra = [...el.children].filter((c) => c.classList.contains('tk-extra'));
  el.replaceChildren(...prima);
  if (items.length) packIn(el, items);
  else el.style.flexDirection = 'column';
  for (const x of extra) el.append(x);
}

function asse(side) { return side === 'left' || side === 'right' ? 'x' : 'y'; }

function packIn(box, items) {
  const a0 = asse((items[0].n.L[1] || {}).side || 'top');
  let k = 0;
  while (k < items.length && asse((items[k].n.L[1] || {}).side || 'top') === a0) k++;
  const gruppo = items.slice(0, k), resto = items.slice(k);
  box.style.display = 'flex';
  box.style.flexDirection = a0 === 'y' ? 'column' : 'row';
  box.dataset.asse = a0;
  const inizio = gruppo.filter((x) => ['top', 'left', undefined].includes((x.n.L[1] || {}).side));
  const fine = gruppo.filter((x) => ['bottom', 'right'].includes((x.n.L[1] || {}).side));
  for (const x of inizio) { box.append(x.e); applicaPackFiglio(x.e, x.n.L[1], a0); x.e.style.marginTop = x.e.style.marginTop; }
  if (resto.length) {
    const cav = document.createElement('div');
    cav.className = 'tk-cavita';
    box.append(cav);
    packIn(cav, resto);
  }
  const fineRev = [...fine].reverse();
  fineRev.forEach((x, i) => {
    box.append(x.e); applicaPackFiglio(x.e, x.n.L[1], a0);
    if (i === 0 && !resto.length) {
      if (a0 === 'y') x.e.style.marginTop = 'auto'; else x.e.style.marginLeft = 'auto';
    }
  });
}

function applicaPackFiglio(e, o, a0) {
  o = o || {};
  const s = e.style;
  const [pl, pr] = pad(o.padx), [pt, pb] = pad(o.pady);
  s.margin = `${pt}px ${pr}px ${pb}px ${pl}px`;
  const [ipx] = pad(o.ipadx), [ipy] = pad(o.ipady);
  if (ipx || ipy) s.padding = `${ipy}px ${ipx}px`;
  const fill = o.fill || 'none';
  const exp = o.expand === true || o.expand === 1 || o.expand === '1' || o.expand === 'yes' || o.expand === 'true';
  const anchor = o.anchor || 'center';
  s.position = '';
  if (a0 === 'y') {
    s.alignSelf = fill === 'x' || fill === 'both' ? 'stretch' : justifyDaAnchor(anchor, 'x');
    if (exp && (fill === 'y' || fill === 'both')) { s.flex = '1 1 auto'; s.minHeight = '0'; }
    else if (exp) { s.flex = '0 0 auto'; s.marginTop = 'auto'; s.marginBottom = 'auto'; }
    else s.flex = '0 0 auto';
    if (e.classList.contains('tk-cavita')) { s.flex = '1 1 0'; s.alignSelf = 'stretch'; }
  } else {
    s.alignSelf = fill === 'y' || fill === 'both' ? 'stretch' : justifyDaAnchor(anchor, 'y');
    if (exp && (fill === 'x' || fill === 'both')) { s.flex = '1 1 auto'; s.minWidth = '0'; }
    else if (exp) { s.flex = '0 0 auto'; s.marginLeft = 'auto'; s.marginRight = 'auto'; }
    else s.flex = '0 0 auto';
  }
  // una "cavità" (resto dello spazio) deve sempre poter crescere
  const p = e.parentElement;
  if (p) for (const c of p.children) if (c.classList.contains('tk-cavita')) { c.style.flex = '1 1 0'; c.style.alignSelf = 'stretch'; c.style.minWidth = '0'; c.style.minHeight = '0'; }
}

function disponiGriglia(el, items, node, prima) {
  el.style.display = 'grid';
  el.style.flexDirection = '';
  const gc = node.gc || { cols: {}, rows: {} };
  let nc = 0, nr = 0;
  for (const x of items) {
    const o = x.n.L[1] || {};
    nc = Math.max(nc, (+o.column || 0) + (+o.columnspan || 1));
    nr = Math.max(nr, (+o.row || 0) + (+o.rowspan || 1));
  }
  const cols = [], rows = [];
  for (let i = 0; i < nc; i++) { const w = (gc.cols[i] || {}).weight; cols.push(w ? `minmax(0, ${w}fr)` : 'auto'); }
  for (let i = 0; i < nr; i++) { const w = (gc.rows[i] || {}).weight; rows.push(w ? `minmax(0, ${w}fr)` : 'auto'); }
  el.style.gridTemplateColumns = cols.join(' ');
  el.style.gridTemplateRows = rows.join(' ');
  const elems = [...prima];
  for (const x of items) {
    const o = x.n.L[1] || {};
    const s = x.e.style;
    s.gridColumn = `${(+o.column || 0) + 1} / span ${+o.columnspan || 1}`;
    s.gridRow = `${(+o.row || 0) + 1} / span ${+o.rowspan || 1}`;
    const st = String(o.sticky || '').toLowerCase();
    s.justifySelf = st.includes('w') && st.includes('e') ? 'stretch' : (st.includes('w') ? 'start' : (st.includes('e') ? 'end' : 'center'));
    s.alignSelf = st.includes('n') && st.includes('s') ? 'stretch' : (st.includes('n') ? 'start' : (st.includes('s') ? 'end' : 'center'));
    const [pl, pr] = pad(o.padx), [pt, pb] = pad(o.pady);
    s.margin = `${pt}px ${pr}px ${pb}px ${pl}px`;
    const [ipx] = pad(o.ipadx), [ipy] = pad(o.ipady);
    if (ipx || ipy) s.padding = `${ipy}px ${ipx}px`;
    s.flex = ''; s.minWidth = s.minWidth || '0'; s.minHeight = '0';
    elems.push(x.e);
  }
  sostituisciFigli(el, elems);
}

// ------------------------------------------------------------------------------------------
// eventi verso Python
// ------------------------------------------------------------------------------------------
function evDa(e) {
  return { x: Math.round(e.offsetX || 0), y: Math.round(e.offsetY || 0), x_root: Math.round(e.clientX || 0), y_root: Math.round(e.clientY || 0),
    state: (e.shiftKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 4 : 0) | (e.altKey ? 8 : 0) };
}

// Colonna cliccata in una Treeview, come la dà tkinter (identify_column): '#1' = prima colonna visibile, '#0' = colonna ad albero.
function colonnaDa(e, el) {
  const td = e.target.closest ? e.target.closest('td') : null;
  if (!td) return '';
  return '#' + (el && el.dataset.albero ? td.cellIndex : td.cellIndex + 1);
}

function haBind(id, seqs) {
  const n = NODI.get(id);
  return n && n.b ? seqs.filter((s) => n.b.includes(s)) : [];
}

function collegaEventi(el, node) {
  const id = node.id;
  const k = node.k;
  if (k === 'button' || k === 'checkbutton' || k === 'radiobutton') {
    el.addEventListener('click', (e) => { e.stopPropagation(); ctx.invia({ a: 'command', id }); });
    return;
  }
  if (k === 'entry') {
    el.addEventListener('input', () => { if (el.dataset.var) VAR_PENDENTI[el.dataset.var] = el.value; });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const seqs = haBind(id, ['<Return>']);
        if (seqs.length) { e.preventDefault(); ctx.invia({ a: 'event', id, seqs, ev: evDa(e) }); }
      }
    });
    return;
  }
  if (k === 'combobox') {
    const invia = () => { if (el.dataset.var) delete VAR_PENDENTI[el.dataset.var]; ctx.invia({ a: 'combo', id, value: el.value }); };
    el.addEventListener('change', invia);
    if (el.tagName === 'INPUT') el.addEventListener('input', () => { if (el.dataset.var) VAR_PENDENTI[el.dataset.var] = el.value; });
    return;
  }
  if (k === 'listbox') {
    el.addEventListener('mousedown', (e) => {
      const r = e.target.closest('.tk-lb-riga'); if (!r) return;
      e.preventDefault();
      const i = +r.dataset.i;
      let sel = new Set(el._sel || []);
      const modo = el._mode;
      if (modo === 'multiple') { sel.has(i) ? sel.delete(i) : sel.add(i); }
      else if (modo === 'extended' && (e.ctrlKey || e.metaKey)) { sel.has(i) ? sel.delete(i) : sel.add(i); }
      else sel = new Set([i]);
      el._sel = sel;
      [...el.children].forEach((c, j) => c.classList.toggle('sel', sel.has(j)));
      ctx.invia({ a: 'listbox', id, sel: [...sel] });
    });
    return;
  }
  if (k === 'treeview') {
    el.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-iid]');
      ctx.invia({ a: 'tree', id, row: tr ? tr.dataset.iid : '', button: 1, ev: Object.assign(evDa(e), { col: colonnaDa(e, el) }) });
    });
    el.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr[data-iid]');
      if (tr && haBind(id, ['<Double-1>', '<Double-Button-1>']).length) ctx.invia({ a: 'tree', id, row: tr.dataset.iid, button: 1, double: true, ev: evDa(e) });
    });
    el.addEventListener('contextmenu', (e) => {
      const tr = e.target.closest('tr[data-iid]');
      if (!haBind(id, ['<Button-3>']).length) return;
      e.preventDefault();
      ctx.invia({ a: 'tree', id, row: tr ? tr.dataset.iid : '', button: 3, ev: evDa(e) });
    });
    return;
  }
  if (k === 'canvas') { eventiCanvas(el, id); return; }
  if (k === 'spinbox') {
    el.addEventListener('input', () => { if (el.dataset.var) VAR_PENDENTI[el.dataset.var] = el.value; });
    el.addEventListener('change', () => { ctx.invia({ a: 'command', id }); });
    return;
  }
  // label, frame, ...: binding del mouse
  el.addEventListener('click', (e) => {
    const seqs = haBind(id, ['<ButtonPress-1>', '<Button-1>', '<ButtonRelease-1>']);
    if (!seqs.length) return;
    e.stopPropagation();
    ctx.invia({ a: 'event', id, seqs, ev: evDa(e) });
  });
  el.addEventListener('contextmenu', (e) => {
    const seqs = haBind(id, ['<Button-3>']);
    if (!seqs.length) return;
    e.preventDefault(); e.stopPropagation();
    ctx.invia({ a: 'event', id, seqs, ev: evDa(e) });
  });
  el.addEventListener('dblclick', (e) => {
    const seqs = haBind(id, ['<Double-1>', '<Double-Button-1>']);
    if (!seqs.length) return;
    e.stopPropagation();
    ctx.invia({ a: 'event', id, seqs, ev: evDa(e) });
  });
}

function posCanvas(el, e) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(e.clientX - r.left + el.scrollLeft), y: Math.round(e.clientY - r.top + el.scrollTop), x_root: Math.round(e.clientX), y_root: Math.round(e.clientY),
    state: (e.shiftKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 4 : 0) | (e.altKey ? 8 : 0) };
}

function eventiCanvas(el, id) {
  let premuto = false, inVolo = false, ultimoMoto = null, timerMoto = null;
  const tagsDi = (e) => {
    const t = e.target.closest && e.target.closest('[data-iid]');
    return t ? [...t.dataset.tags.split(' ').filter(Boolean), t.dataset.iid] : [];
  };
  const inviaMoto = (seq, ev) => {
    // movimenti: al massimo uno in viaggio verso Python, si tiene solo l'ultimo
    ultimoMoto = [seq, ev];
    if (inVolo) return;
    inVolo = true;
    const [s, v] = ultimoMoto; ultimoMoto = null;
    ctx.invia({ a: 'event', id, seqs: [s], ev: v }, { silenzioso: true }).finally(() => {
      inVolo = false;
      if (ultimoMoto) inviaMoto(...ultimoMoto);
    });
  };
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const ev = posCanvas(el, e);
    premuto = true;
    for (const tag of tagsDi(e)) {
      if (el._tb && el._tb.has(tag + '|<Button-1>')) { e.stopPropagation(); ctx.invia({ a: 'canvasitem', id, tag, seq: '<Button-1>', ev }); }
    }
    const seqs = haBind(id, ['<ButtonPress-1>', '<Button-1>']);
    if (seqs.length) { e.preventDefault(); e.stopPropagation(); ctx.invia({ a: 'event', id, seqs, ev }); }
  });
  el.addEventListener('mousemove', (e) => {
    if (premuto && (e.buttons & 1)) {
      if (haBind(id, ['<B1-Motion>']).length) { e.preventDefault(); inviaMoto('<B1-Motion>', posCanvas(el, e)); }
      return;
    }
    if (haBind(id, ['<Motion>']).length) {
      const ev = posCanvas(el, e);
      clearTimeout(timerMoto);
      timerMoto = setTimeout(() => inviaMoto('<Motion>', ev), 40);
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (!premuto) return;
    premuto = false;
    if (haBind(id, ['<ButtonRelease-1>']).length) ctx.invia({ a: 'event', id, seqs: ['<ButtonRelease-1>'], ev: posCanvas(el, e) });
  });
  el.addEventListener('contextmenu', (e) => {
    const seqs = haBind(id, ['<Button-3>']);
    if (!seqs.length) return;
    e.preventDefault(); e.stopPropagation();
    ctx.invia({ a: 'event', id, seqs, ev: posCanvas(el, e) });
  });
  el.addEventListener('dblclick', (e) => {
    const seqs = haBind(id, ['<Double-1>', '<Double-Button-1>']);
    if (!seqs.length) return;
    e.stopPropagation();
    ctx.invia({ a: 'event', id, seqs, ev: posCanvas(el, e) });
  });
}

export function variabiliPendenti() {
  const v = { ...VAR_PENDENTI };
  return v;
}

export function svuotaPendenti(inviate) {
  for (const k of Object.keys(inviate || {})) if (VAR_PENDENTI[k] === inviate[k]) delete VAR_PENDENTI[k];
}

const TASTI = { ' ': '<space>', ArrowDown: '<Down>', ArrowUp: '<Up>', ArrowLeft: '<Left>', ArrowRight: '<Right>',
  PageUp: '<Prior>', PageDown: '<Next>', Enter: '<Return>', Escape: '<Escape>', Home: '<Home>', End: '<End>' };

function tastiera(e) {
  const t = e.target;
  const campo = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  if (document.querySelector('.dlg-aperto')) return;
  const seq = TASTI[e.key];
  if (!seq || !finestraAttiva) return;
  if (campo && seq !== '<Escape>' && !(seq === '<Return>' && t.tagName !== 'TEXTAREA')) return;
  if (campo && seq === '<Return>') return;   // gestito dal campo stesso
  const n = NODI.get(finestraAttiva);
  if (!n || !n.b || !n.b.includes(seq)) return;
  e.preventDefault();
  ctx.invia({ a: 'key', id: finestraAttiva, seq, ev: { state: e.ctrlKey ? 4 : 0 } });
}

// ------------------------------------------------------------------------------------------
// menu a comparsa (tasto destro)
// ------------------------------------------------------------------------------------------
let ultimoMouse = { x: 100, y: 100 };
window.addEventListener('mousedown', (e) => { ultimoMouse = { x: e.clientX, y: e.clientY }; }, true);
window.addEventListener('contextmenu', (e) => { ultimoMouse = { x: e.clientX, y: e.clientY }; }, true);

function chiudiMenu() { document.querySelectorAll('.tk-menu').forEach((m) => m.remove()); }

function mostraMenu(o) {
  chiudiMenu();
  const m = document.createElement('div');
  m.className = 'tk-menu';
  for (const v of o.voci) {
    if (v.sep) { const s = document.createElement('div'); s.className = 'tk-menu-sep'; m.append(s); continue; }
    const b = document.createElement('button');
    b.textContent = v.label;
    b.disabled = !!v.disabled;
    b.onclick = () => { chiudiMenu(); ctx.invia({ a: 'menu', id: o.id, i: v.i }); };
    m.append(b);
  }
  document.body.append(m);
  const x = Math.min(ultimoMouse.x, window.innerWidth - m.offsetWidth - 4);
  const y = Math.min(ultimoMouse.y, window.innerHeight - m.offsetHeight - 4);
  m.style.left = x + 'px'; m.style.top = y + 'px';
}

export function elementoWidget(id) { return ELS.get(id); }
export function nodoWidget(id) { return NODI.get(id); }
export function ricominciaDisegno() {
  for (const f of FINESTRE.values()) f.box.remove();
  FINESTRE.clear(); ELS.clear(); NODI.clear();
}
export function annullaTimer() { for (const h of TIMER.values()) clearTimeout(h); TIMER.clear(); }
