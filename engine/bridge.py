"""Ponte tra la pagina web e il programma Volley Pro Suite (volley.py, invariato).

La pagina chiama `azione(json)` per ogni click/tasto/timer; la risposta (JSON) contiene le
finestre da ridisegnare, i messaggi, i comandi video, i PDF da scaricare ecc.
"""
import os, sys, json, base64, traceback, io

import htk

STATO = {'app': None, 'root': '', 'impostazioni': None, 'pronto': False}
V = None


# ---------------------------------------------------------------------------------------------
# Avvio
# ---------------------------------------------------------------------------------------------
import re as _re

def _font_svg(svg):
    """Nei disegni SVG i nomi dei font PDF (Helvetica-Bold...) diventano famiglia + peso CSS."""
    def sost(m):
        nome = m.group(1).strip()
        peso = 'bold' if 'Bold' in nome else 'normal'
        stile = 'italic' if ('Oblique' in nome or 'Italic' in nome) else 'normal'
        fam = 'Courier New, monospace' if nome.startswith('Courier') else ('Times New Roman, serif' if nome.startswith('Times') else 'Helvetica, Arial, sans-serif')
        return f"font-family: {fam}; font-weight: {peso}; font-style: {stile}"
    return _re.sub(r'font-family:\s*([A-Za-z\- ]+)', sost, svg)


class _SvgPM:
    """Sostituto di reportlab.graphics.renderPM: invece di un PNG (che richiederebbe cairo)
    produce lo stesso disegno in SVG, che il browser mostra nitido a qualsiasi zoom."""
    @staticmethod
    def drawToFile(d, fn, fmt='PNG', **kw):
        from reportlab.graphics import renderSVG
        svg = renderSVG.drawToString(d)
        if isinstance(svg, bytes): svg = svg.decode('utf-8')
        dati = _font_svg(svg).encode('utf-8')
        if hasattr(fn, 'write'):
            fn.write(dati)
        else:
            with open(fn, 'wb') as f: f.write(dati)

    @staticmethod
    def drawToString(d, fmt='PNG', **kw):
        from reportlab.graphics import renderSVG
        s = renderSVG.drawToString(d)
        if isinstance(s, bytes): s = s.decode('utf-8')
        return _font_svg(s).encode('utf-8')


def prepara(root=''):
    """Installa il tkinter "senza schermo" e importa il programma. root = prefisso delle
    cartelle (vuoto nel browser; una cartella temporanea nei test sul PC)."""
    global V
    STATO['root'] = root
    htk.OUT_DIR = root + '/vps_out'
    os.environ['LOCALAPPDATA'] = root + '/appdata'
    os.makedirs(root + '/appdata/DivoArido', exist_ok=True)
    os.makedirs(root + '/appdata/VolleyProSuite', exist_ok=True)      # nome usato fino al 21/11/2026: serve finche' pagina e programma possono essere di versioni diverse
    htk.reset()
    htk.installa()
    if 'volley' in sys.modules:
        del sys.modules['volley']
    import volley as _v
    V = _v
    V.renderPM = _SvgPM
    STATO['impostazioni'] = _leggi_impostazioni_testo()
    return json.dumps({'ok': True, 'impostazioni': V._file_impostazioni()})


def avvia(con_avvio=True):
    """Come il blocco __main__ del programma: finestra principale + finestra di avvio."""
    app = V.AppAnalisiDefinitiva()
    STATO['app'] = app
    if con_avvio:
        app.after(200, lambda: V.FinestraAvvio(app))
    STATO['pronto'] = True
    return _risposta()


# ---------------------------------------------------------------------------------------------
# File (cartelle del Drive copiate nel file system del browser)
# ---------------------------------------------------------------------------------------------
def fs_scrivi(path, b64):
    os.makedirs(os.path.dirname(path) or '/', exist_ok=True)
    with open(path, 'wb') as f: f.write(base64.b64decode(b64))
    return 'ok'


def fs_scrivi_testo(path, testo):
    os.makedirs(os.path.dirname(path) or '/', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f: f.write(testo)
    return 'ok'


def fs_segnaposto(lista_json):
    """Crea file vuoti con i nomi dei video del Drive: il programma li vede come se fossero
    sul disco (ricerca automatica per data/sigle, associazioni), la pagina li riproduce dal Drive."""
    for p in json.loads(lista_json):
        os.makedirs(os.path.dirname(p) or '/', exist_ok=True)
        if not os.path.exists(p):
            open(p, 'wb').close()
    return 'ok'


def fs_svuota(path):
    import shutil
    if os.path.isdir(path): shutil.rmtree(path, ignore_errors=True)
    return 'ok'


def fs_elenco(path):
    out = []
    for r, ds, fs in os.walk(path):
        for f in fs: out.append(os.path.join(r, f))
    return json.dumps(out)


def fs_leggi(path):
    with open(path, 'rb') as f: return base64.b64encode(f.read()).decode('ascii')


# ---------------------------------------------------------------------------------------------
# Azioni dell'utente
# ---------------------------------------------------------------------------------------------
def _w(wid):
    w = htk.WIDGETS.get(wid)
    if w is None: raise KeyError(f"widget {wid} non più esistente")
    return w


def _evento(widget, ev):
    ev = ev or {}
    htk.EVENT_CTX.clear()
    htk.EVENT_CTX.update({k: ev[k] for k in ('row', 'col') if k in ev})
    return htk.Event(widget, **{k: v for k, v in ev.items() if k not in ('row', 'col')})


def _fire(w, seq, ev):
    f = w.binds.get(seq)
    if f:
        r = f(_evento(w, ev))
        return r
    return None


_SU_WIDGET = ('command', 'event', 'listbox', 'combo', 'tree', 'menu', 'key', 'notebook', 'canvasitem', 'configure')


def _esegui(a):
    tipo = a.get('a')
    # Un clic/tasto su un elemento di una finestra chiusa o ricostruita nel frattempo (es. doppio clic mentre si chiude)
    # non vale più: si ignora in silenzio invece di mostrare «widget … non più esistente».
    if tipo in _SU_WIDGET and a.get('id') not in htk.WIDGETS:
        return
    if tipo == 'command':
        w = _w(a['id'])
        if getattr(w, 'KIND', '') in ('checkbutton', 'radiobutton'):
            w.invoke()                  # cambia la variabile (come in Tk) e poi chiama il comando
        else:
            c = w.kw.get('command')
            if c: c()
    elif tipo == 'event':
        w = _w(a['id'])
        for seq in a['seqs']:
            if _fire(w, seq, a.get('ev')) == 'break': break
    elif tipo == 'setvar':
        v = htk.VARS.get(a['id'])
        if v is not None: v.set(a['value'])
    elif tipo == 'setvars':
        for vid, val in a['vals'].items():
            v = htk.VARS.get(vid)
            if v is not None: v.set(val)
    elif tipo == 'listbox':
        w = _w(a['id'])
        w.sel = set(int(i) for i in a['sel'])
        w._tocca()
        _fire(w, '<<ListboxSelect>>', a.get('ev'))
    elif tipo == 'combo':
        w = _w(a['id'])
        w.kw['textvariable'].set(a['value'])
        w._tocca()
        _fire(w, '<<ComboboxSelected>>', a.get('ev'))
    elif tipo == 'tree':
        w = _w(a['id'])
        ev = dict(a.get('ev') or {}, row=a.get('row', ''))
        if a.get('button', 1) == 1:
            if a.get('row') and w.kw.get('selectmode') != 'none':
                w.selection_set(a['row'])
            for seq in ('<<TreeviewSelect>>', '<Button-1>', '<ButtonRelease-1>'):
                _fire(w, seq, ev)
            if a.get('double'):
                _fire(w, '<Double-1>', ev); _fire(w, '<Double-Button-1>', ev)
        else:
            _fire(w, '<Button-3>', ev)
    elif tipo == 'menu':
        _w(a['id']).invoca(int(a['i']))
    elif tipo == 'timer':
        t = htk.TIMERS.pop(a['id'], None)
        if t:
            f, args = t
            f(*args)
    elif tipo == 'close':
        w = htk.WIDGETS.get(a['id'])
        if w is not None:
            f = getattr(w, 'protocolli', {}).get('WM_DELETE_WINDOW')
            if f: f()
            else: w.destroy()
    elif tipo == 'key':
        w = _w(a['id'])
        _fire(w, a['seq'], a.get('ev'))
    elif tipo == 'notebook':
        w = _w(a['id'])
        if w.sel != int(a['i']):
            w.sel = int(a['i'])
            w._tocca()          # la scheda scelta va rimandata alla pagina anche se nessun comando la ridisegna (es. Report sedute: «Andamento giocatori»)
            _fire(w, '<<NotebookTabChanged>>', a.get('ev'))
    elif tipo == 'player':
        p = htk.PLAYERS.get(a['id'])
        if p is not None:
            if a.get('state'): p.stato = a['state']
            if a.get('ms') is not None: p.tempo_ms = int(a['ms'])
    elif tipo == 'canvasitem':
        w = _w(a['id'])
        f = w.item_binds.get((a['tag'], a['seq']))
        if f: f(_evento(w, a.get('ev')))
    elif tipo == 'configure':
        w = _w(a['id'])
        nuova = (int(a.get('w', 0)), int(a.get('h', 0)))
        if getattr(w, '_dim', None) != nuova:
            w._dim = nuova
            f = w.binds.get('<Configure>')
            if f: f(_evento(w, {'width': nuova[0], 'height': nuova[1]}))
    elif tipo == 'focus':
        htk.EVENT_CTX['focus'] = None
    elif tipo == 'noop':
        pass
    else:
        raise ValueError(f"azione sconosciuta: {tipo}")


def azione(a_json):
    a = json.loads(a_json) if isinstance(a_json, str) else a_json
    for vid, val in (a.get('vars') or {}).items():      # testi digitati nei campi
        v = htk.VARS.get(vid)
        if v is not None and v._value != val:
            v._value = val
    if a.get('risposta') is not None:                    # risposta a un dialogo
        htk.DIALOG_ANSWERS.append((a['risposta']['kind'], a['risposta']['value']))
    try:
        _esegui(a)
    except htk.DialogNeeded as d:
        htk.OUTBOX.append({'t': 'dialog', 'kind': d.kind, 'opts': d.opts, 'azione': {k: v for k, v in a.items() if k not in ('risposta', 'vars')}})
    except Exception:
        htk.OUTBOX.append({'t': 'error', 'text': traceback.format_exc()})
    finally:
        htk.DIALOG_ANSWERS.clear()
    return _risposta()


def aggiorna():
    return _risposta()


# ---------------------------------------------------------------------------------------------
# Risposta per la pagina
# ---------------------------------------------------------------------------------------------
def _leggi_impostazioni_testo():
    try:
        with open(V._file_impostazioni(), 'r', encoding='utf-8') as f: return f.read()
    except Exception:
        return None


def _file_da_scaricare():
    out = []
    d = htk.OUT_DIR
    if os.path.isdir(d):
        for nome in sorted(os.listdir(d)):
            p = os.path.join(d, nome)
            try:
                with open(p, 'rb') as f: dati = f.read()
                os.remove(p)
                out.append({'name': nome, 'b64': base64.b64encode(dati).decode('ascii')})
            except OSError:
                pass
    return out


def _cartella_dati():
    app = STATO.get('app')
    try: return app.cartella_dvw.get() if app is not None else ''
    except Exception: return ''


def _stato_dati():
    cart = _cartella_dati(); out = {}
    if cart and os.path.isdir(cart):
        for n in os.listdir(cart):
            if n.startswith(('DivoArido_', 'VolleyProSuite_')) and n.endswith('.json') and 'backup' not in n:
                p = os.path.join(cart, n)
                try: st = os.stat(p); out[p] = (st.st_mtime_ns, st.st_size)
                except OSError: pass
    return out


def dati_base():
    """Dopo la copia di una cartella: lo stato attuale dei file di dati non va rimandato indietro."""
    d = _stato_dati(); d['__cart'] = _cartella_dati()
    STATO['dati'] = d
    return 'ok'


def _dati_cambiati():
    ora = _stato_dati(); prima = STATO.get('dati') or {}
    out = []
    for p, sig in ora.items():
        if prima.get(p) != sig and p in prima or (p not in prima and prima.get('__cart') == _cartella_dati()):
            try:
                with open(p, 'r', encoding='utf-8') as f: out.append({'path': p, 'testo': f.read()})
            except OSError: pass
    ora['__cart'] = _cartella_dati()
    STATO['dati'] = ora
    return out


def _risposta():
    finestre = []
    for w in list(htk.WINDOWS):
        if w.alive and w.dirty:
            try:
                finestre.append(w.serial())
            except Exception:
                htk.OUTBOX.append({'t': 'error', 'text': traceback.format_exc()})
    out = {'windows': finestre, 'order': [w.id for w in htk.WINDOWS if w.alive], 'closed': list(htk.CLOSED),
           'out': list(htk.OUTBOX), 'images': htk.immagini_nuove(), 'files': _file_da_scaricare()}
    salva = _dati_cambiati()
    if salva: out['salva'] = salva
    htk.CLOSED.clear(); htk.OUTBOX.clear()
    stili = json.dumps([htk.STYLES, htk.STYLE_MAPS], sort_keys=True, default=str)
    if stili != STATO.get('stili'):
        STATO['stili'] = stili
        out['styles'], out['stylemaps'] = htk.STYLES, htk.STYLE_MAPS
    imp = _leggi_impostazioni_testo()
    if imp is not None and imp != STATO['impostazioni']:
        STATO['impostazioni'] = imp
        out['impostazioni'] = imp
    return json.dumps(out, ensure_ascii=False, default=str)


def tutto():
    """Rimanda tutte le finestre per intero (dopo un ricaricamento della pagina)."""
    def sporca(w):
        w.dirty = True
        if isinstance(w, htk.Treeview): w._ri_inviato = -1
        for c in w.children_list: sporca(c)
    for w in htk.WINDOWS: sporca(w)
    for img in htk.IMAGES.values(): img.inviata = False
    STATO['stili'] = None
    return _risposta()
