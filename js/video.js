// Player video: sostituisce VLC. Il programma chiede "carica questo file dal secondo X";
// qui il file è un video del Drive, letto a pezzi (streaming) tramite il service worker.

export class Video {
  constructor(ctx) {
    this.ctx = ctx;               // {elementoWidget(id), risolvi(path) -> {url, nome} | null, invia(azione)}
    this.players = new Map();     // id player -> {widget, video, path, stop}
  }

  comando(o) {
    let p = this.players.get(o.id);
    if (o.cmd === 'bind') {
      if (!p) { p = { id: o.id }; this.players.set(o.id, p); }
      p.widget = o.widget;
      this.aggancia(p);
      return;
    }
    if (!p) { p = { id: o.id }; this.players.set(o.id, p); }
    this.aggancia(p);
    const v = p.video;
    switch (o.cmd) {
      case 'load': this.carica(p, o.path, o.start || 0, o.stop); break;
      case 'play': v && v.play().catch(() => this.stato(p, 'Paused')); break;
      case 'pause': v && v.pause(); break;
      case 'stop':
        if (v) { v.pause(); }
        this.stato(p, 'Stopped');
        break;
      case 'seek': if (v) { v.currentTime = (o.ms || 0) / 1000; } break;
      case 'volume': if (v) v.volume = Math.max(0, Math.min(1, (o.v || 0) / 100)); break;
      case 'mute': if (v) v.muted = !!o.v; break;
      case 'rate': if (v) { v.playbackRate = o.v || 1; v.defaultPlaybackRate = o.v || 1; } break;   // il default fa restare la velocita' anche quando cambia il file (Slow)
      case 'score': this.punteggio(p, o.data); break;
      case 'release': if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.parentElement?.remove(); } this.players.delete(o.id); break;
    }
  }

  aggancia(p) {
    const host = p.widget && this.ctx.elementoWidget(p.widget);
    if (!host) return;
    if (p.box && p.box.parentElement === host) return;
    if (!p.box) {
      const box = document.createElement('div');
      box.className = 'tk-extra video-box';
      const v = document.createElement('video');
      v.playsInline = true;
      v.controls = true;
      v.preload = 'auto';
      const msg = document.createElement('div');
      msg.className = 'video-msg';
      box.append(v, msg);
      p.box = box; p.video = v; p.msg = msg;
      v.addEventListener('playing', () => { this.messaggio(p, ''); this.stato(p, 'Playing'); });
      v.addEventListener('pause', () => { if (p.statoAtteso !== 'Stopped') this.stato(p, 'Paused'); });
      v.addEventListener('ended', () => this.stato(p, 'Ended'));
      v.addEventListener('waiting', () => this.messaggio(p, 'Caricamento…', true));
      v.addEventListener('canplay', () => this.messaggio(p, ''));
      v.addEventListener('error', () => {
        const err = v.error;
        if (!v.getAttribute('src')) return;
        // OSPITE: se il lettore dei video (service worker) non riesce, si prova UNA volta a leggere il video direttamente da Google
        if (/__drive__\//.test(v.getAttribute('src') || '') && p.path && p.provatoDiretto !== p.path && this.ctx.diretto) {
          const d = this.ctx.diretto(p.path);
          if (d) { p.provatoDiretto = p.path; p.preferisciDiretto = true; this.riprova(p, d.url); return; }
        }
        let t = 'Impossibile riprodurre il video';
        if (err && err.code === 4) t = 'Formato video non supportato dal browser (serve MP4 H.264 o WebM).';
        else if (err && err.code === 2) t = 'Errore di rete durante la lettura del video dal Drive.';
        this.messaggio(p, t);
        this.stato(p, 'Error');
        const srcErr = v.getAttribute('src') || '';
        if (/googleapis\.com\/.*alt=media/.test(srcErr)) {
          const base = t + ' Motivo: Google non ha consegnato il video';
          this.messaggio(p, base + '. Controllo in corso…');
          this.sondaDiretta(srcErr).then((s) => {
            if (!p.video || p.video.getAttribute('src') !== srcErr) return;
            const ce = p.video.error;
            this.messaggio(p, `${base}. Risposta di Google: ${s.stato || 'nessuna'}${s.det ? ' (' + s.det + ')' : ''}. Errore del video: ${ce ? ce.code + (ce.message ? ' ' + ce.message : '') : '-'}.`);
          });
        } else this.diagnosi(p, srcErr, t);
      });
      // Telefono/tablet: il quadratino di schermo intero dei comandi del video e' quello del browser (mostra solo il video, senza elenco clip
      // ne' comandi): lo si sostituisce con lo schermo intero del programma (scena unica con la linguetta delle clip). 24/11/2026.
      const nativoFuori = () => { try { if (document.fullscreenElement === v) return document.exitFullscreen(); } catch (e) {} try { v.webkitExitFullscreen?.(); } catch (e) {} return Promise.resolve(); };
      const apriScena = () => {
        if (!document.documentElement.classList.contains('tocco')) return;
        const fin = p.box.closest('.tk-finestra:not(.tk-radice)');
        if (!fin || fin.classList.contains('tk-fullscreen')) return;           // gia' a schermo intero del programma: basta uscire da quello del video
        const b = [...fin.querySelectorAll('button')].find((x) => /Schermo intero/.test(x.textContent));
        if (b) b.click();
      };
      v.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement !== v || !document.documentElement.classList.contains('tocco')) return;
        Promise.resolve(nativoFuori()).catch(() => {}).then(apriScena);
      });
      v.addEventListener('webkitbeginfullscreen', () => {
        if (!document.documentElement.classList.contains('tocco')) return;
        Promise.resolve(nativoFuori()).catch(() => {}).then(apriScena);
      });
      v.addEventListener('timeupdate', () => {
        if (p.stop != null && v.currentTime >= p.stop) { p.stop = null; v.pause(); }
        if (p.score) this.disegnaPunteggio(p);
      });
      v.addEventListener('loadedmetadata', () => { if (p.score) this.disegnaPunteggio(p, true); });
      new ResizeObserver(() => { if (p.score) this.disegnaPunteggio(p, true); }).observe(box);
    }
    host.classList.add('tk-video-host');
    host.append(p.box);
  }

  // Chiede a Google, con lo stesso indirizzo del video, perche' non lo consegna (limite di scarico, chiave API, file non piu' condiviso...)
  // e interrompe subito la lettura: in caso di successo si leggono solo le intestazioni.
  async sondaDiretta(src) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(src, { signal: ac.signal });
      let det = '';
      if (!r.ok) {
        try { const j = JSON.parse(await r.text()); const e = j.error || {}; det = ((e.errors && e.errors[0] && e.errors[0].reason) ? e.errors[0].reason + ': ' : '') + (e.message || ''); } catch (x) {}
      } else det = ((r.headers.get('content-type') || '') + ' ' + (r.headers.get('content-length') || '')).trim();
      try { ac.abort(); } catch (x) {}
      return { stato: r.status, det };
    } catch (e) { return { stato: 0, det: ((e && e.name) || 'errore') + (e && e.message ? ': ' + e.message : '') }; }
    finally { clearTimeout(t); }
  }

  // CONTROLLO DI AVVIO (25/11/2026): se dopo qualche secondo il video non sta andando (schermo nero senza errori) lo si dice a schermo con i dati
  // tecnici (fonte, stato della rete, immagine, risposta del server): da una foto dello schermo si capisce dove si blocca.
  vigila(p) {
    clearTimeout(p.vigilaId);
    const richiesta = p.richiesta;
    p.vigilaId = setTimeout(async () => {
      const v = p.video;
      if (!v || richiesta !== p.richiesta || !v.getAttribute('src') || p.statoAtteso === 'Stopped' || v.error) return;     // (con un errore il messaggio con il motivo c'e' gia')
      if (v.readyState >= 3 && v.videoWidth > 0 && !v.paused) return;            // sta andando
      if (v.readyState >= 2 && v.paused && v.videoWidth > 0) return;             // fermo ma con l'immagine (pausa o «Premi ▶»)
      const src = v.getAttribute('src');
      let sonda = '';
      if (/googleapis\.com/.test(src)) { const s = await this.sondaDiretta(src); sonda = (s.stato || 'nessuna') + (s.det ? ' (' + s.det + ')' : ''); }
      else {
        try {
          const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
          const r = await fetch(src, { headers: { Range: 'bytes=0-0' }, signal: ac.signal }); clearTimeout(t);
          sonda = r.status + (r.headers.get('content-type') ? ' ' + r.headers.get('content-type') : '');
        } catch (e) { sonda = ((e && e.name) || 'errore') + (e && e.message ? ': ' + e.message : ''); }
      }
      if (richiesta !== p.richiesta) return;
      const fonte = /__drive__\//.test(src) ? 'lettore dei video' : (/googleapis\.com/.test(src) ? 'Google diretto' : 'altro');
      const dur = isFinite(v.duration) ? Math.round(v.duration) : '?';
      const testo = `Il video non parte. Fonte: ${fonte}. Rete: ${v.networkState}, pronto: ${v.readyState}, immagine: ${v.videoWidth}x${v.videoHeight}, tempo: ${v.currentTime.toFixed(1)}/${dur}, risposta del server: ${sonda}`;
      console.warn(testo);
      this.messaggio(p, testo);
    }, 5000);
  }

  // Rilegge il video con un altro indirizzo (lettura diretta da Google) e riparte dal punto richiesto
  riprova(p, url) {
    const v = p.video, start = p.ultimoStart || 0;
    this.messaggio(p, 'Caricamento del video…', true);
    v.src = url;
    v.addEventListener('loadedmetadata', () => { try { v.currentTime = start; } catch (e) {} const pr = v.play(); if (pr) pr.catch(() => {}); }, { once: true });
  }

  // Quando un video non parte dice il PERCHÉ (altrimenti il programma passa alla clip dopo e sembra «tutto nero»):
  // si rilegge il primo byte dallo stesso indirizzo e si interpreta la risposta del componente di lettura (service worker).
  async diagnosi(p, src, base) {
    if (!src || !/__drive__\//.test(src)) return;
    let causa;
    // il lettore ricorda l'ultimo rifiuto di Google: se e' recente e' lui il vero motivo
    try {
      const u = await (await fetch(src.replace(/__drive__\/.*$/, '__drive__/_errore'))).json();
      if (u && Date.now() - u.quando < 180000) {
        if (/quota/i.test(u.motivo || '')) causa = 'Google ha raggiunto il limite di scarico di questo video (succede con i file molto grandi condivisi con un link). Riprova fra qualche ora oppure usa una copia più leggera del video.';
        else if (u.status === 0) causa = 'la connessione con Google non è riuscita (' + (u.motivo || 'rete') + '). Controlla la connessione e riprova.';
        else if (u.status === 404) causa = 'il video non è più condiviso: il link potrebbe essere scaduto o annullato.';
        else causa = `Google ha rifiutato la lettura del video (${u.status}${u.motivo ? ': ' + u.motivo : ''}).`;
        console.warn('Video non riproducibile:', src, causa);
        if (p.video && p.video.getAttribute('src') === src) this.messaggio(p, (base ? base + ' ' : '') + 'Motivo: ' + causa);
        return;
      }
    } catch (e) {}
    try {
      const r = await fetch(src, { headers: { Range: 'bytes=0-0' } });
      const t = r.ok ? '' : await r.text().catch(() => '');
      if (r.ok) causa = 'il file si legge da Drive ma il browser non riesce a riprodurlo (formato o file danneggiato).';
      else if (r.status === 404 && /Video non accessibile/.test(t)) causa = 'Drive non lascia leggere il file: accesso Google scaduto (premi «Rinnova accesso Google» in alto) oppure il file non è condiviso con questo account.';
      else if (r.status === 404) causa = 'il lettore dei video non è attivo su questa pagina (succede dopo Ctrl+F5, che lo esclude): ricarica con un normale F5, oppure chiudi la scheda e riaprila.';
      else if (r.status === 401 || r.status === 403) causa = `Drive rifiuta l'accesso (${r.status}): premi «Rinnova accesso Google» in alto e riprova.`;
      else causa = `Drive risponde con errore ${r.status}.`;
    } catch (e) { causa = 'impossibile contattare il lettore dei video (' + ((e && e.message) || e) + ').'; }
    console.warn('Video non riproducibile:', src, causa);
    if (p.video && p.video.getAttribute('src') === src) this.messaggio(p, (base ? base + ' ' : '') + 'Motivo: ' + causa);
  }

  // Punteggio in sovrimpressione (stile TV), in alto a sinistra sull'immagine del video
  punteggio(p, data) {
    p.score = data || null;
    if (!p.score) { if (p.scoreEl) p.scoreEl.remove(); p.scoreEl = null; return; }
    this.disegnaPunteggio(p, true);
  }

  disegnaPunteggio(p, forza) {
    const d = p.score, v = p.video;
    if (!d || !p.box) return;
    const dopo = d.t_punto != null && v && v.currentTime >= d.t_punto;
    const firma = JSON.stringify([d, dopo]);
    let el = p.scoreEl;
    if (!el) { el = document.createElement('div'); el.className = 'score-tv'; p.box.append(el); p.scoreEl = el; forza = true; }
    if (forza || el.dataset.firma !== firma) {
      el.dataset.firma = firma;
      const [pc, po] = dopo ? d.post : d.pre;
      const pallini = (n) => [0, 1, 2].map((k) => `<i class="${k < n ? 'si' : 'no'}"></i>`).join('');
      const logo = (u) => u ? `<img class="lg" src="${u}" alt="">` : '<span class="lg"></span>';
      const riga = (sig, col, n, pt, u) => `<div class="r"><b style="background:${col}"></b>${logo(u)}<span class="sg">${sig}</span><span class="pl">${pallini(n)}</span><span class="pt">${pt}</span></div>`;
      el.classList.toggle('trasp', d.stile === 'trasparente');
      el.innerHTML = `<div class="sq">${riga(d.casa, d.col_casa, d.vc, pc, d.logo_casa)}${riga(d.ospite, d.col_ospite, d.vo, po, d.logo_ospite)}</div><div class="st"><small>SET</small>${d.set}</div>`;
    }
    // posizione: angolo in alto a sinistra dell'immagine (il video è "contain" dentro il riquadro)
    const bw = p.box.clientWidth, bh = p.box.clientHeight, vw = v && v.videoWidth, vh = v && v.videoHeight;
    let ox = 0, oy = 0;
    if (vw && vh && bw && bh) { const sc = Math.min(bw / vw, bh / vh); ox = (bw - vw * sc) / 2; oy = (bh - vh * sc) / 2; }
    el.style.left = (ox + 8) + 'px'; el.style.top = (oy + 8) + 'px';
  }

  messaggio(p, t, piccolo) {
    if (!p.msg) return;
    p.msg.textContent = t || '';
    p.msg.classList.toggle('vis', !!t);
    p.msg.classList.toggle('piccolo', !!piccolo);
  }

  carica(p, path, start, stop) {
    const v = p.video;
    if (!v) return;
    // risolvi() può rispondere subito o con una promessa (video letto dal disco del PC)
    const attuale = p.richiesta = (p.richiesta || 0) + 1;
    let ris0;
    try { ris0 = this.ctx.risolvi(path); }
    catch (e) { ris0 = Promise.reject(e); }
    Promise.resolve(ris0).then((ris) => {
      if (attuale !== p.richiesta) return;       // nel frattempo è stata scelta un'altra clip
      this.carica2(p, path, start, stop, ris);
    }).catch((e) => {
      if (attuale !== p.richiesta) return;
      this.messaggio(p, (e && e.message) || 'Video non disponibile');
      this.stato(p, 'Error');
    });
  }

  carica2(p, path, start, stop, ris) {
    const v = p.video;
    if (!ris) {
      this.messaggio(p, 'Video non disponibile: ' + path.split('/').pop());
      this.stato(p, 'Error');
      return;
    }
    // se per questo ospite il lettore dei video e' gia' fallito, si legge subito direttamente da Google
    if (p.preferisciDiretto && this.ctx.diretto) { const d = this.ctx.diretto(path); if (d) ris = d; }
    p.ultimoStart = start;
    p.stop = stop != null ? stop : null;
    p.statoAtteso = null;
    this.mostra(p);
    const vai = () => {
      try { v.currentTime = start; } catch (e) {}
      const pr = v.play();
      if (pr) pr.catch((e) => {
        if (e && e.name === 'NotAllowedError') this.messaggio(p, 'Premi ▶ per avviare il video');
      });
    };
    if (p.path === path && v.readyState >= 1) {
      vai();
    } else {
      p.path = path;
      this.messaggio(p, 'Caricamento del video…', true);
      v.src = ris.url;
      v.addEventListener('loadedmetadata', vai, { once: true });
    }
    this.vigila(p);
  }

  // Telefono/tablet: elenco e video sono uno sopra l'altro; quando parte una clip si fa scorrere la finestra fino al video
  // (col tasto ↕ della barra si torna all'elenco). Non fa nulla se il video si vede gia'.
  mostra(p) {
    if (!window.matchMedia || !window.matchMedia('(max-width: 820px)').matches || !p.box) return;
    if (!p.box.closest('.tk-finestra:not(.tk-radice)')) return;
    try { p.box.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch (e) {}
  }

  stato(p, s) {
    if (p.ultimoStato === s && s !== 'Playing') return;
    p.ultimoStato = s;
    if (s === 'Stopped') p.statoAtteso = 'Stopped';
    const ms = p.video ? Math.round(p.video.currentTime * 1000) : 0;
    this.ctx.invia({ a: 'player', id: p.id, state: s, ms }, { silenzioso: true });
  }

  pulisci() {
    for (const [id, p] of this.players) {
      if (p.box && !p.box.isConnected) {
        const host = p.widget && this.ctx.elementoWidget(p.widget);
        if (host && host.isConnected) { host.append(p.box); continue; }
        try { p.video.pause(); p.video.removeAttribute('src'); p.video.load(); } catch (e) {}
        this.players.delete(id);
      }
    }
  }

  riaggancia() { for (const p of this.players.values()) this.aggancia(p); }
}
