"""htk - tkinter "senza schermo" per far girare Volley Pro Suite nel browser.

Sostituisce i moduli tkinter / tkinter.ttk / tkinter.filedialog / tkinter.messagebox e vlc
con oggetti che NON disegnano nulla: registrano finestre, widget, testi, colori, comandi e
binding, così la pagina web può ridisegnare la stessa interfaccia in HTML e inoltrare a
Python i click dell'utente. Il codice del programma (volley.py) gira senza modifiche.
"""
import sys, types, itertools, io

# ---------------------------------------------------------------------------------------------
# Registri condivisi con bridge.py
# ---------------------------------------------------------------------------------------------
WIDGETS = {}          # id -> widget
VARS = {}             # id -> Variable
IMAGES = {}           # id -> PhotoImage
WINDOWS = []          # finestre (Tk / Toplevel) ancora aperte, in ordine di apertura
TIMERS = {}           # id -> (funzione, argomenti)
OUTBOX = []           # eventi per la pagina (messaggi, timer, comandi video, menu, ...)
STYLES = {}           # nome stile ttk -> opzioni
STYLE_MAPS = {}       # nome stile ttk -> mappe di stato
DIALOG_ANSWERS = []   # risposte pre-caricate per i dialoghi file (vedi DialogNeeded)
EVENT_CTX = {}        # contesto dell'evento in corso (es. riga della Treeview cliccata)
CLOSED = []           # finestre chiuse dall'ultimo aggiornamento
OUT_DIR = '/vps_out'  # file salvati dal programma (PDF): la pagina li scarica
_ids = itertools.count(1)


class DialogNeeded(Exception):
    """Un dialogo file (scegli cartella / file) richiede una risposta dalla pagina: l'azione
    viene interrotta e ripetuta quando la pagina ha la risposta."""
    def __init__(self, kind, opts):
        super().__init__(kind)
        self.kind, self.opts = kind, opts


def _nuovo_id(prefisso):
    return f"{prefisso}{next(_ids)}"


def _clean(v):
    """Valori delle opzioni in forma serializzabile (JSON)."""
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    if isinstance(v, Variable):
        return {'var': v.id}
    if isinstance(v, PhotoImage):
        return {'img': v.id}
    if isinstance(v, Widget):
        return {'w': v.id}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if callable(v):
        return True
    return str(v)


# ---------------------------------------------------------------------------------------------
# Variabili
# ---------------------------------------------------------------------------------------------
class Variable:
    _default = ""

    def __init__(self, master=None, value=None, name=None):
        self.id = _nuovo_id('v')
        self._value = self._default if value is None else value
        self._traces = []
        VARS[self.id] = self

    def set(self, value):
        self._value = value
        for w in list(_LEGATI.get(self.id, ())):
            w._tocca()
        for cb in list(self._traces):
            try: cb(self.id, '', 'write')
            except Exception: pass

    def get(self):
        return self._value

    def trace_add(self, mode, callback):
        self._traces.append(callback)
        return str(len(self._traces))

    def __str__(self):
        return self.id


class StringVar(Variable):
    _default = ""

    def get(self):
        v = self._value
        return "" if v is None else str(v)


class IntVar(Variable):
    _default = 0

    def get(self):
        v = self._value
        if isinstance(v, str):
            v = v.strip()
            try: return int(v)
            except ValueError: return int(float(v))
        return int(v)


class DoubleVar(Variable):
    _default = 0.0

    def get(self):
        v = self._value
        if isinstance(v, str): v = v.strip().replace(',', '.')
        return float(v)


class BooleanVar(Variable):
    _default = False

    def get(self):
        v = self._value
        if isinstance(v, str): return v.lower() in ('1', 'true', 'yes', 'si')
        return bool(v)


_LEGATI = {}   # id variabile -> widget che la mostrano (per ridisegnarli quando cambia)


# ---------------------------------------------------------------------------------------------
# Immagini
# ---------------------------------------------------------------------------------------------
class PhotoImage:
    def __init__(self, name=None, data=None, file=None, **kw):
        self.id = _nuovo_id('i')
        if isinstance(data, str): data = data.encode('latin-1', 'ignore')
        if file and not data:
            try:
                with open(file, 'rb') as f: data = f.read()
            except OSError: data = b''
        self.data = data or b''
        self.inviata = False
        self._w, self._h = kw.get('_w', 0), kw.get('_h', 0)
        IMAGES[self.id] = self

    def width(self): return self._w
    def height(self): return self._h
    def __str__(self): return self.id


def _imagetk_module():
    """Sostituto di PIL.ImageTk: l'immagine di Pillow diventa un PNG mandato alla pagina."""
    m = types.ModuleType('PIL.ImageTk')
    class _Foto(PhotoImage):
        def __init__(self, image=None, size=None, **kw):
            import io
            b = io.BytesIO()
            if image is not None:
                im = image if image.mode in ('RGB', 'RGBA', 'L', 'P') else image.convert('RGBA')
                im.save(b, format='PNG')
                PhotoImage.__init__(self, data=b.getvalue(), _w=image.width, _h=image.height)
            else:
                PhotoImage.__init__(self, data=b'')
        def paste(self, im, box=None): self.__init__(im)
    m.PhotoImage = _Foto
    m.BitmapImage = _Foto
    return m


# ---------------------------------------------------------------------------------------------
# Eventi
# ---------------------------------------------------------------------------------------------
class Event:
    def __init__(self, widget=None, **kw):
        self.widget = widget
        self.x = kw.get('x', 0); self.y = kw.get('y', 0)
        self.x_root = kw.get('x_root', 0); self.y_root = kw.get('y_root', 0)
        self.state = kw.get('state', 0)
        self.delta = kw.get('delta', 0)
        self.keysym = kw.get('keysym', '')
        self.char = kw.get('char', '')
        self.num = kw.get('num', 1)
        self.width = kw.get('width', 0); self.height = kw.get('height', 0)


# ---------------------------------------------------------------------------------------------
# Widget di base
# ---------------------------------------------------------------------------------------------
class Widget:
    KIND = 'frame'

    def __init__(self, master=None, cnf=None, **kw):
        self.id = _nuovo_id('w')
        self.master = master
        self.children_list = []      # ordine di creazione
        self.pack_order = []         # ordine di "impacchettamento" (pack)
        self.kw = {}
        if cnf: self.kw.update(cnf)
        self.kw.update(kw)
        self.binds = {}
        self.layout = None           # ('pack', opts) / ('grid', opts) / ('pane', opts) / ('canvas', opts)
        self._grid_ricordato = None
        self.alive = True
        self.dirty = True
        self.propagate = True
        self.grid_cfg = {'cols': {}, 'rows': {}}
        WIDGETS[self.id] = self
        if master is not None and isinstance(master, Widget):
            master.children_list.append(self)
            master._tocca()
        for chiave_var in ('textvariable', 'variable'):          # 'variable' = caselle di spunta e pulsanti di scelta: si ridisegnano quando la variabile cambia
            tv = self.kw.get(chiave_var)
            if isinstance(tv, Variable):
                _LEGATI.setdefault(tv.id, set()).add(self)

    # -- marcatura per il ridisegno --
    def _tocca(self):
        w = self
        while w is not None and isinstance(w, Widget):
            if w.dirty and w is not self:
                break
            w.dirty = True
            w = w.master

    # -- opzioni --
    def configure(self, cnf=None, **kw):
        if cnf is None and not kw:
            return dict(self.kw)
        if isinstance(cnf, str):
            return self.kw.get(cnf)
        if cnf: kw = dict(cnf, **kw)
        self.kw.update(kw)
        tv = kw.get('textvariable')
        if isinstance(tv, Variable):
            _LEGATI.setdefault(tv.id, set()).add(self)
        self._tocca()
    config = configure

    def cget(self, k): return self.kw.get(k)
    def __getitem__(self, k): return self.kw.get(k)
    def __setitem__(self, k, v): self.configure(**{k: v})
    def keys(self): return list(self.kw)

    # -- geometria --
    def pack(self, cnf=None, **opts):
        if cnf: opts = dict(cnf, **opts)
        m = self.master
        before, after = opts.pop('before', None), opts.pop('after', None)
        self.layout = ('pack', opts)
        if isinstance(m, Widget):
            if self in m.pack_order: m.pack_order.remove(self)
            if before is not None and before in m.pack_order:
                m.pack_order.insert(m.pack_order.index(before), self)
            elif after is not None and after in m.pack_order:
                m.pack_order.insert(m.pack_order.index(after) + 1, self)
            else:
                m.pack_order.append(self)
            m._tocca()
        self._tocca()
    pack_configure = pack

    def pack_forget(self):
        m = self.master
        if isinstance(m, Widget) and self in m.pack_order:
            m.pack_order.remove(self)
            m._tocca()
        if self.layout and self.layout[0] == 'pack':
            self.layout = None
        self._tocca()

    def grid(self, cnf=None, **opts):
        if cnf: opts = dict(cnf, **opts)
        if not opts and self._grid_ricordato is not None:
            opts = self._grid_ricordato
        self.layout = ('grid', opts)
        self._grid_ricordato = opts
        if isinstance(self.master, Widget): self.master._tocca()
        self._tocca()
    grid_configure = grid

    def grid_remove(self):
        if self.layout and self.layout[0] == 'grid':
            self._grid_ricordato = self.layout[1]
        self.layout = None
        if isinstance(self.master, Widget): self.master._tocca()

    def grid_forget(self):
        self.layout = None
        self._grid_ricordato = None
        if isinstance(self.master, Widget): self.master._tocca()

    def place(self, cnf=None, **opts):
        self.layout = ('place', opts)
        if isinstance(self.master, Widget): self.master._tocca()

    def place_forget(self):
        self.layout = None
        if isinstance(self.master, Widget): self.master._tocca()

    def grid_rowconfigure(self, index, cnf=None, **kw):
        self.grid_cfg['rows'][int(index)] = kw; self._tocca()
    rowconfigure = grid_rowconfigure

    def grid_columnconfigure(self, index, cnf=None, **kw):
        self.grid_cfg['cols'][int(index)] = kw; self._tocca()
    columnconfigure = grid_columnconfigure

    def pack_propagate(self, flag=None):
        if flag is None: return self.propagate
        self.propagate = bool(flag); self._tocca()

    def grid_propagate(self, flag=None):
        return self.pack_propagate(flag)

    # -- eventi --
    def bind(self, sequence=None, func=None, add=None):
        if sequence is None: return list(self.binds)
        if func is None: return self.binds.get(sequence)
        self.binds[sequence] = func
        self._tocca()
        return f"bind{id(func)}"

    def unbind(self, sequence, funcid=None):
        self.binds.pop(sequence, None); self._tocca()

    def bind_all(self, sequence=None, func=None, add=None): return None
    def unbind_all(self, sequence): return None
    def bind_class(self, *a, **k): return None
    def event_generate(self, sequence, **kw):
        f = self.binds.get(sequence)
        if f: f(Event(self, **kw))

    # -- timer --
    def after(self, ms, func=None, *args):
        if func is None:
            return None
        tid = _nuovo_id('t')
        TIMERS[tid] = (func, args)
        OUTBOX.append({'t': 'after', 'id': tid, 'ms': int(ms)})
        return tid

    def after_idle(self, func, *args):
        return self.after(0, func, *args)

    def after_cancel(self, tid):
        if tid in TIMERS:
            del TIMERS[tid]
            OUTBOX.append({'t': 'cancel', 'id': tid})

    # -- informazioni sulla finestra --
    def winfo_children(self): return [c for c in self.children_list if c.alive]
    def winfo_exists(self): return 1 if self.alive else 0
    def winfo_id(self): return self.id
    def winfo_width(self): return getattr(self, '_dim', (1200, 800))[0]
    def winfo_height(self): return getattr(self, '_dim', (1200, 800))[1]
    def winfo_reqwidth(self): return 600
    def winfo_reqheight(self): return 300
    def winfo_rootx(self): return 0
    def winfo_rooty(self): return 0
    def winfo_x(self): return 0
    def winfo_y(self): return 0
    def winfo_screenwidth(self): return 1920
    def winfo_screenheight(self): return 1080
    def winfo_toplevel(self):
        w = self
        while w is not None and not isinstance(w, Tk) and not isinstance(w, Toplevel):
            w = w.master
        return w
    def winfo_ismapped(self): return 1
    def winfo_viewable(self): return 1

    def focus_get(self): return EVENT_CTX.get('focus')
    def focus_set(self): pass
    focus = focus_set
    def focus_force(self): pass
    def update(self): pass
    def update_idletasks(self): pass
    def wait_visibility(self, w=None): pass
    def wait_window(self, w=None): pass
    def option_add(self, *a, **k): pass
    def lift(self, *a): OUTBOX.append({'t': 'lift', 'id': self.id})
    tkraise = lift
    def lower(self, *a): pass
    def quit(self): pass
    def mainloop(self, n=0): pass
    def clipboard_clear(self): pass
    def clipboard_append(self, s): OUTBOX.append({'t': 'clipboard', 'text': str(s)})
    def nametowidget(self, name): return WIDGETS.get(str(name))
    def register(self, f, *a): return f

    def destroy(self):
        if not self.alive: return
        for c in list(self.children_list):
            c.destroy()
        self.alive = False
        m = self.master
        if isinstance(m, Widget):
            if self in m.pack_order: m.pack_order.remove(self)
            if self in m.children_list: m.children_list.remove(self)
            m._tocca()
        tv = self.kw.get('textvariable')
        if isinstance(tv, Variable) and tv.id in _LEGATI:
            _LEGATI[tv.id].discard(self)
        WIDGETS.pop(self.id, None)
        if self in WINDOWS:
            WINDOWS.remove(self)
            CLOSED.append(self.id)

    def __str__(self):
        return self.id

    def __repr__(self):
        return f"<{type(self).__name__} {self.id}>"

    # -- serializzazione (per la pagina) --
    def extra(self):
        return None

    def serial(self):
        if not self.dirty:
            return {'id': self.id, 'same': 1}
        d = {'id': self.id, 'k': self.KIND}
        kw = {}
        for k, v in self.kw.items():
            if k in ('command', 'yscrollcommand', 'xscrollcommand', 'validatecommand'):
                if k == 'command' and v is not None: kw['command'] = 1
                continue
            kw[k] = _clean(v)
        tv = self.kw.get('textvariable')
        if isinstance(tv, Variable):
            try: d['val'] = tv.get()
            except Exception: d['val'] = tv._value
        img = self.kw.get('image')
        if isinstance(img, PhotoImage) and not img.inviata:
            _IMMAGINI_DA_INVIARE.add(img.id)
        d['kw'] = kw
        if self.layout: d['L'] = [self.layout[0], {k: _clean(v) for k, v in self.layout[1].items()}]
        if self.binds: d['b'] = sorted(self.binds)
        if not self.propagate: d['noprop'] = 1
        if self.grid_cfg['cols'] or self.grid_cfg['rows']:
            d['gc'] = {'cols': {str(k): v for k, v in self.grid_cfg['cols'].items()},
                       'rows': {str(k): v for k, v in self.grid_cfg['rows'].items()}}
        ex = self.extra()
        if ex: d['x'] = ex
        figli = [c for c in self.children_list if c.alive]
        d['po'] = [c.id for c in self.pack_order if c.alive]
        d['ch'] = [c.serial() for c in figli]
        self.dirty = False
        return d


_IMMAGINI_DA_INVIARE = set()


class Misc(Widget):
    pass


class Frame(Widget):
    KIND = 'frame'


class LabelFrame(Widget):
    KIND = 'labelframe'


class Label(Widget):
    KIND = 'label'


class Message(Label):
    pass


class Button(Widget):
    KIND = 'button'

    def invoke(self):
        c = self.kw.get('command')
        if c: return c()

    def flash(self): pass


class Checkbutton(Button):
    """Casella di spunta: come in Tk, il clic cambia la variabile (onvalue/offvalue, di norma 1/0 o True/False) e poi chiama il comando."""
    KIND = 'checkbutton'

    def _acceso(self):
        v = self.kw.get('variable')
        try: return v is not None and v.get() == self.kw.get('onvalue', 1)
        except Exception: return False

    def extra(self): return {'on': self._acceso()}

    def invoke(self):
        v = self.kw.get('variable')
        if v is not None: v.set(self.kw.get('offvalue', 0) if self._acceso() else self.kw.get('onvalue', 1))
        self._tocca()
        c = self.kw.get('command')
        if c: return c()


class Radiobutton(Button):
    """Pulsante di scelta: il clic mette 'value' nella variabile e poi chiama il comando."""
    KIND = 'radiobutton'

    def _acceso(self):
        v = self.kw.get('variable')
        try: return v is not None and str(v.get()) == str(self.kw.get('value', 1))
        except Exception: return False

    def extra(self): return {'on': self._acceso()}

    def invoke(self):
        v = self.kw.get('variable')
        if v is not None: v.set(self.kw.get('value', 1))
        self._tocca()
        c = self.kw.get('command')
        if c: return c()


class Entry(Widget):
    KIND = 'entry'

    def __init__(self, master=None, cnf=None, **kw):
        super().__init__(master, cnf, **kw)
        if not isinstance(self.kw.get('textvariable'), Variable):
            v = StringVar()
            self.kw['textvariable'] = v
            _LEGATI.setdefault(v.id, set()).add(self)

    def get(self): return self.kw['textvariable'].get()

    def delete(self, first, last=None):
        if first in (0, '0') and last in ('end', None):
            self.kw['textvariable'].set('')

    def insert(self, index, s):
        v = self.kw['textvariable']
        v.set(str(v.get()) + str(s))

    def icursor(self, i): pass
    def select_range(self, a, b): pass
    def selection_range(self, a, b): pass


class Spinbox(Entry):
    KIND = 'spinbox'


class Scale(Widget):
    KIND = 'scale'


class Scrollbar(Widget):
    KIND = 'scrollbar'

    def set(self, *a): pass
    def get(self): return (0.0, 1.0)


class Canvas(Widget):
    """Canvas con gli elementi disegnati: la pagina li disegna in SVG; clic/tasti tornano qui."""
    KIND = 'canvas'
    _OPZ = ('fill', 'outline', 'width', 'dash', 'text', 'font', 'anchor', 'justify', 'arrow', 'arrowshape',
            'smooth', 'state', 'capstyle', 'joinstyle', 'start', 'extent', 'style', 'angle')

    def __init__(self, master=None, cnf=None, **kw):
        super().__init__(master, cnf, **kw)
        self.finestre = []
        self.items = {}          # id -> {'t': tipo, 'c': coordinate, 'o': opzioni, 'tags': [...]}
        self.ordine = []
        self.prossimo = 1
        self.item_binds = {}     # (tag o id, sequenza) -> funzione

    # -- creazione --
    def _crea(self, tipo, coords, kw):
        if len(coords) == 1 and isinstance(coords[0], (list, tuple)): coords = coords[0]
        flat = []
        for c in coords:
            if isinstance(c, (list, tuple)): flat.extend(float(x) for x in c)
            else: flat.append(float(c))
        iid = self.prossimo; self.prossimo += 1
        tags = kw.pop('tags', ()) or ()
        if isinstance(tags, str): tags = tags.split()
        it = {'t': tipo, 'c': flat, 'o': {}, 'tags': [str(t) for t in tags]}
        self._opzioni(it, kw)
        self.items[iid] = it; self.ordine.append(iid)
        self._tocca()
        return iid

    def _opzioni(self, it, kw):
        for k, v in kw.items():
            if k == 'tags':
                it['tags'] = [str(t) for t in (v.split() if isinstance(v, str) else v)]
            elif k == 'image':
                if isinstance(v, PhotoImage):
                    it['o']['image'] = v.id; it['o']['iw'] = v.width(); it['o']['ih'] = v.height()
                    if not v.inviata: _IMMAGINI_DA_INVIARE.add(v.id)
            elif k == 'window':
                pass
            else:
                it['o'][k] = _clean(v)

    def create_rectangle(self, *c, **k): return self._crea('rect', c, k)
    def create_oval(self, *c, **k): return self._crea('oval', c, k)
    def create_line(self, *c, **k): return self._crea('line', c, k)
    def create_polygon(self, *c, **k): return self._crea('poly', c, k)
    def create_text(self, *c, **k): return self._crea('text', c, k)
    def create_arc(self, *c, **k): return self._crea('arc', c, k)
    def create_image(self, *c, **k): return self._crea('image', c, k)

    def create_window(self, *pos, **kw):
        w = kw.get('window')
        if isinstance(w, Widget):
            x, y = (pos[0] if len(pos) == 1 else pos)[:2] if pos else (0, 0)
            w.layout = ('canvas', {'anchor': kw.get('anchor', 'center'), 'x': x, 'y': y})
            self.finestre.append(w)
            self._tocca()
        return self._crea('win', pos or (0, 0), {})

    # -- ricerca per tag/id --
    def _trova(self, spec):
        if spec is None: return []
        if isinstance(spec, int) or (isinstance(spec, str) and spec.isdigit()):
            i = int(spec); return [i] if i in self.items else []
        spec = str(spec)
        if spec == 'all': return list(self.ordine)
        return [i for i in self.ordine if spec in self.items[i]['tags']]

    def find_withtag(self, spec): return tuple(self._trova(spec))
    def find_all(self): return tuple(self.ordine)
    def gettags(self, spec):
        ids = self._trova(spec); return tuple(self.items[ids[0]]['tags']) if ids else ()
    def type(self, spec):
        ids = self._trova(spec); return {'rect': 'rectangle', 'poly': 'polygon'}.get(self.items[ids[0]]['t'], self.items[ids[0]]['t']) if ids else None

    def delete(self, *specs):
        for spec in specs:
            for i in self._trova(spec):
                self.items.pop(i, None)
                if i in self.ordine: self.ordine.remove(i)
        self._tocca()

    def coords(self, spec, *c):
        ids = self._trova(spec)
        if not ids: return []
        if not c: return list(self.items[ids[0]]['c'])
        if len(c) == 1 and isinstance(c[0], (list, tuple)): c = c[0]
        self.items[ids[0]]['c'] = [float(x) for x in c]; self._tocca()

    def move(self, spec, dx, dy):
        for i in self._trova(spec):
            cc = self.items[i]['c']
            self.items[i]['c'] = [v + (dx if j % 2 == 0 else dy) for j, v in enumerate(cc)]
        self._tocca()

    def itemconfigure(self, spec, cnf=None, **kw):
        if cnf: kw = dict(cnf, **kw)
        for i in self._trova(spec): self._opzioni(self.items[i], kw)
        self._tocca()
    itemconfig = itemconfigure

    def itemcget(self, spec, opt):
        ids = self._trova(spec); return self.items[ids[0]]['o'].get(opt) if ids else None

    def addtag_withtag(self, newtag, spec):
        for i in self._trova(spec):
            if newtag not in self.items[i]['tags']: self.items[i]['tags'].append(str(newtag))
    def dtag(self, spec, tag=None):
        for i in self._trova(spec):
            t = self.items[i]['tags']
            if tag in t: t.remove(tag)

    def tag_raise(self, spec, above=None):
        for i in self._trova(spec):
            self.ordine.remove(i); self.ordine.append(i)
        self._tocca()
    def tag_lower(self, spec, below=None):
        for i in reversed(self._trova(spec)):
            self.ordine.remove(i); self.ordine.insert(0, i)
        self._tocca()

    def bbox(self, *specs):
        xs, ys = [], []
        for spec in (specs or ('all',)):
            for i in self._trova(spec):
                c = self.items[i]['c']
                xs += c[0::2]; ys += c[1::2]
        if not xs: return None
        return (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))

    def find_overlapping(self, x0, y0, x1, y1):
        out = []
        for i in self.ordine:
            c = self.items[i]['c']
            if not c: continue
            ax0, ax1 = min(c[0::2]), max(c[0::2]); ay0, ay1 = min(c[1::2]), max(c[1::2])
            if ax0 <= x1 and ax1 >= x0 and ay0 <= y1 and ay1 >= y0: out.append(i)
        return tuple(out)
    def find_closest(self, x, y, *a):
        best, dmin = None, 1e18
        for i in self.ordine:
            c = self.items[i]['c']
            if not c: continue
            d = min((c[j] - x) ** 2 + (c[j + 1] - y) ** 2 for j in range(0, len(c) - 1, 2))
            if d < dmin: best, dmin = i, d
        return (best,) if best else ()

    def tag_bind(self, spec, sequence=None, func=None, add=None):
        if func is None: return self.item_binds.get((str(spec), sequence))
        self.item_binds[(str(spec), sequence)] = func; self._tocca()
    def tag_unbind(self, spec, sequence, funcid=None):
        self.item_binds.pop((str(spec), sequence), None); self._tocca()

    def canvasx(self, x, *a): return x
    def canvasy(self, y, *a): return y
    def yview(self, *a): return (0.0, 1.0)
    def xview(self, *a): return (0.0, 1.0)
    def yview_scroll(self, n, what): OUTBOX.append({'t': 'scroll', 'id': self.id, 'dir': 'y', 'n': n, 'what': what})
    def xview_scroll(self, n, what): OUTBOX.append({'t': 'scroll', 'id': self.id, 'dir': 'x', 'n': n, 'what': what})
    def yview_moveto(self, f): pass
    def xview_moveto(self, f): pass
    def scan_mark(self, x, y): pass
    def scan_dragto(self, x, y, gain=10): pass

    def extra(self):
        el = []
        for i in self.ordine:
            it = self.items[i]
            if it['t'] == 'win': continue
            if it['o'].get('state') == 'hidden': continue
            img = it['o'].get('image')
            if img and img in IMAGES and not IMAGES[img].inviata: _IMMAGINI_DA_INVIARE.add(img)
            el.append([i, it['t'], [round(v, 1) for v in it['c']], it['o'], it['tags']])
        tb = sorted({f"{t}|{seq}" for (t, seq) in self.item_binds})
        return {'items': el, 'tb': tb}


class Text(Widget):
    """Area di testo (sola lettura nella versione web): insert/delete/get come in tkinter."""
    KIND = 'text'

    def __init__(self, master=None, cnf=None, **kw):
        super().__init__(master, cnf, **kw)
        self.contenuto = ''

    def insert(self, index, chars, *tags):
        if str(index) in ('end', 'insert') or str(index).startswith('end'): self.contenuto += str(chars)
        else: self.contenuto = str(chars) + self.contenuto if str(index) in ('1.0', '0.0') else self.contenuto + str(chars)
        self._tocca()

    def delete(self, a, b=None):
        if str(a) in ('1.0', '0.0') and (b is None or str(b).startswith('end')): self.contenuto = ''
        self._tocca()

    def get(self, a='1.0', b='end'): return self.contenuto
    def see(self, *a): pass
    def tag_configure(self, *a, **k): pass
    tag_config = tag_configure
    def tag_add(self, *a, **k): pass
    def mark_set(self, *a): pass
    def index(self, i): return '1.0'
    def yview(self, *a): return (0.0, 1.0)

    def extra(self): return {'text': self.contenuto}


class Listbox(Widget):
    KIND = 'listbox'

    def __init__(self, master=None, cnf=None, **kw):
        super().__init__(master, cnf, **kw)
        self.items = []
        self.sel = set()

    def _idx(self, i):
        if i in ('end', 'END'): return len(self.items) - 1
        if i == 'active': return 0
        return int(i)

    def insert(self, index, *elements):
        pos = len(self.items) if index in ('end', 'END') else int(index)
        for k, e in enumerate(elements):
            self.items.insert(pos + k, str(e))
        self._tocca()

    def delete(self, first, last=None):
        a = self._idx(first)
        b = a if last is None else self._idx(last)
        if b < a: return
        del self.items[a:b + 1]
        self.sel = {i for i in self.sel if i < a} | {i - (b - a + 1) for i in self.sel if i > b}
        self._tocca()

    def get(self, first, last=None):
        if last is None: return self.items[self._idx(first)]
        return tuple(self.items[self._idx(first):self._idx(last) + 1])

    def size(self): return len(self.items)

    def curselection(self): return tuple(sorted(i for i in self.sel if i < len(self.items)))

    def selection_set(self, first, last=None):
        a = self._idx(first)
        b = a if last is None else self._idx(last)
        for i in range(a, b + 1):
            if 0 <= i < len(self.items): self.sel.add(i)
        self._tocca()
    select_set = selection_set

    def selection_clear(self, first, last=None):
        a = self._idx(first)
        b = a if last is None else self._idx(last)
        self.sel = {i for i in self.sel if not (a <= i <= b)}
        self._tocca()
    select_clear = selection_clear

    def selection_includes(self, i): return self._idx(i) in self.sel
    def see(self, i): pass
    def activate(self, i): pass
    def nearest(self, y): return 0
    def itemconfig(self, *a, **k): pass

    def extra(self):
        return {'items': self.items, 'sel': sorted(self.sel)}


class PanedWindow(Widget):
    KIND = 'paned'

    def __init__(self, master=None, cnf=None, **kw):
        super().__init__(master, cnf, **kw)
        self.panes_list = []

    def add(self, child, **kw):
        if child in self.panes_list: self.panes_list.remove(child)
        self.panes_list.append(child)
        child.layout = ('pane', kw)
        self._tocca()

    def forget(self, child):
        if child in self.panes_list: self.panes_list.remove(child)
        if child.layout and child.layout[0] == 'pane': child.layout = None
        self._tocca()
    remove = forget

    def panes(self): return [p.id for p in self.panes_list]
    def sash_place(self, index, x, y): pass
    def sash_coord(self, index): return (0, 0)
    def paneconfigure(self, child, **kw):
        if child.layout and child.layout[0] == 'pane': child.layout[1].update(kw)
        self._tocca()

    def extra(self):
        return {'panes': [p.id for p in self.panes_list if p.alive]}


class Menu(Widget):
    KIND = 'menu'

    def __init__(self, master=None, cnf=None, **kw):
        super().__init__(master, cnf, **kw)
        self.voci = []

    def add_command(self, cnf=None, **kw):
        self.voci.append(('command', kw))

    def add_separator(self, **kw):
        self.voci.append(('separator', {}))

    def add_checkbutton(self, **kw): self.voci.append(('command', kw))
    def add_radiobutton(self, **kw): self.voci.append(('command', kw))
    def add_cascade(self, **kw): pass
    def delete(self, a, b=None): self.voci = []

    def tk_popup(self, x, y, entry=""):
        voci = []
        for i, (tipo, kw) in enumerate(self.voci):
            if tipo == 'separator':
                voci.append({'sep': 1})
            else:
                voci.append({'i': i, 'label': kw.get('label', ''), 'disabled': kw.get('state') == 'disabled'})
        OUTBOX.append({'t': 'menu', 'id': self.id, 'x': x, 'y': y, 'voci': voci})
    post = tk_popup

    def grab_release(self): pass
    def unpost(self): pass

    def invoca(self, i):
        tipo, kw = self.voci[i]
        c = kw.get('command')
        if c: c()


class Wm:
    """Metodi di finestra comuni a Tk e Toplevel."""
    def _init_wm(self):
        self.wm = {'title': '', 'geometry': '', 'fullscreen': False, 'topmost': False, 'modal': False,
                   'resizable': True, 'withdrawn': False, 'transient': None}
        self.protocolli = {}
        WINDOWS.append(self)

    def title(self, t=None):
        if t is None: return self.wm['title']
        self.wm['title'] = str(t); self._tocca()
    wm_title = title

    def geometry(self, g=None):
        if g is None: return self.wm['geometry'] or "800x600+0+0"
        self.wm['geometry'] = str(g); self._tocca()
    wm_geometry = geometry

    def protocol(self, name=None, func=None):
        if func is not None: self.protocolli[name] = func

    def attributes(self, *args):
        if len(args) == 1: return self.wm.get(args[0].lstrip('-'))
        for k, v in zip(args[0::2], args[1::2]):
            k = k.lstrip('-')
            if k in ('fullscreen', 'topmost'): self.wm[k] = bool(v)
            else: self.wm[k] = v
        self._tocca()
    wm_attributes = attributes

    def transient(self, master=None): self.wm['transient'] = getattr(master, 'id', None)
    def grab_set(self): self.wm['modal'] = True; self._tocca()
    def grab_release(self): self.wm['modal'] = False; self._tocca()
    def grab_current(self): return self if self.wm['modal'] else None
    def resizable(self, w=None, h=None): self.wm['resizable'] = bool(w) or bool(h)
    def deiconify(self): self.wm['withdrawn'] = False; self._tocca()
    def withdraw(self): self.wm['withdrawn'] = True; self._tocca()
    def iconify(self): pass
    def state(self, s=None): return 'normal'
    def iconbitmap(self, *a, **k): pass
    def iconphoto(self, *a, **k): pass
    def minsize(self, *a): pass
    def maxsize(self, *a): pass
    def overrideredirect(self, *a): pass

    def report_callback_exception(self, exc, val, tb):
        import traceback
        OUTBOX.append({'t': 'error', 'text': ''.join(traceback.format_exception(exc, val, tb))})

    def extra(self):
        return {'wm': dict(self.wm), 'chiudi': 'WM_DELETE_WINDOW' in self.protocolli}


class Tk(Wm, Widget):
    KIND = 'window'

    def __init__(self, screenName=None, baseName=None, className='Tk', useTk=1, sync=0, use=None):
        Widget.__init__(self, None)
        self._init_wm()
        self.radice = True


class Toplevel(Wm, Widget):
    KIND = 'window'

    def __init__(self, master=None, cnf=None, **kw):
        Widget.__init__(self, master, cnf, **kw)
        # una finestra non è "figlia" grafica del master: la si toglie dai suoi figli
        if isinstance(master, Widget) and self in master.children_list:
            master.children_list.remove(self)
        self._init_wm()
        self.radice = False

    def _tocca(self):
        self.dirty = True

    def destroy(self):
        Widget.destroy(self)


class TclError(Exception):
    pass


# ---------------------------------------------------------------------------------------------
# ttk
# ---------------------------------------------------------------------------------------------
class Style:
    def __init__(self, master=None): pass

    def configure(self, style, query_opt=None, **kw):
        STYLES.setdefault(style, {}).update({k: _clean(v) for k, v in kw.items()})

    def map(self, style, query_opt=None, **kw):
        STYLE_MAPS.setdefault(style, {}).update({k: _clean(v) for k, v in kw.items()})

    def theme_use(self, name=None): return 'clam'
    def theme_names(self): return ('clam',)
    def lookup(self, *a, **k): return ''
    def layout(self, *a, **k): return []
    def element_create(self, *a, **k): pass


class Combobox(Entry):
    KIND = 'combobox'

    def current(self, newindex=None):
        vals = list(self.kw.get('values') or [])
        if newindex is None:
            try: return vals.index(self.get())
            except ValueError: return -1
        if 0 <= newindex < len(vals):
            self.kw['textvariable'].set(vals[newindex])
        self._tocca()

    def set(self, value):
        self.kw['textvariable'].set(value)
        self._tocca()


class Notebook(Widget):
    KIND = 'notebook'

    def __init__(self, master=None, cnf=None, **kw):
        super().__init__(master, cnf, **kw)
        self.schede = []   # [(widget, opzioni)]
        self.sel = 0

    def add(self, child, **kw):
        self.schede.append([child, kw])
        child.layout = ('tab', {})
        self._tocca()

    def tab(self, tab_id, option=None, **kw):
        i = tab_id if isinstance(tab_id, int) else next((k for k, (c, _) in enumerate(self.schede) if c is tab_id), 0)
        if kw:
            self.schede[i][1].update(kw); self._tocca()
        elif option:
            return self.schede[i][1].get(option)
        return dict(self.schede[i][1])

    def tabs(self): return [c.id for c, _ in self.schede]

    def select(self, tab_id=None):
        if tab_id is None: return self.schede[self.sel][0].id if self.schede else ''
        self.sel = tab_id if isinstance(tab_id, int) else next((k for k, (c, _) in enumerate(self.schede) if c is tab_id), 0)
        self._tocca()

    def index(self, tab_id): return self.sel if tab_id == 'current' else 0
    def forget(self, tab_id): pass
    def hide(self, tab_id): pass

    def extra(self):
        return {'tabs': [{'id': c.id, 'text': kw.get('text', '')} for c, kw in self.schede if c.alive], 'sel': self.sel}


class Treeview(Widget):
    KIND = 'treeview'

    def __init__(self, master=None, cnf=None, **kw):
        super().__init__(master, cnf, **kw)
        cols = kw.get('columns', ())
        if isinstance(cols, str): cols = cols.split()
        self.colonne = list(cols)
        self.intest = {}
        self.col_opt = {}
        self.items = {}          # iid -> dict
        self.ordine = []
        self.selez = []
        self.tag_opt = {}
        self._auto = itertools.count(1)
        self.vedi = None
        self._ri = 0            # versione delle righe (per non rimandarle se cambia solo la selezione)
        self._ri_inviato = -1

    def _tocca_righe(self):
        self._ri += 1
        self._tocca()

    def heading(self, column, option=None, **kw):
        if kw:
            self.intest.setdefault(str(column), {}).update({k: _clean(v) for k, v in kw.items() if k != 'command'})
            self._tocca()
        return self.intest.get(str(column), {})

    def column(self, column, option=None, **kw):
        if kw:
            self.col_opt.setdefault(str(column), {}).update({k: _clean(v) for k, v in kw.items()})
            self._tocca()
        return self.col_opt.get(str(column), {})

    def tag_configure(self, tagname, option=None, **kw):
        if kw:
            self.tag_opt.setdefault(tagname, {}).update({k: _clean(v) for k, v in kw.items()})
            self._tocca_righe()
        return self.tag_opt.get(tagname, {})

    def tag_bind(self, *a, **k): pass

    def insert(self, parent, index, iid=None, **kw):
        if iid is None:
            iid = f"I{next(self._auto):03X}"
        iid = str(iid)
        vals = kw.get('values', ())
        if isinstance(vals, str): vals = (vals,)
        tags = kw.get('tags', ())
        if isinstance(tags, str): tags = (tags,)
        self.items[iid] = {'values': [_clean(v) if not isinstance(v, (int, float)) else v for v in vals],
                           'text': str(kw.get('text', '')), 'tags': list(tags),
                           'image': kw.get('image'), 'parent': parent}
        if index in ('end', 'END') or index is None:
            self.ordine.append(iid)
        else:
            self.ordine.insert(int(index), iid)
        self._tocca_righe()
        return iid

    def delete(self, *items):
        for it in items:
            it = str(it)
            if it in self.items:
                del self.items[it]
                self.ordine.remove(it)
                if it in self.selez: self.selez.remove(it)
        self._tocca_righe()

    def get_children(self, item=None):
        return tuple(self.ordine)

    def exists(self, item): return str(item) in self.items

    def item(self, item, option=None, **kw):
        it = self.items[str(item)]
        if kw:
            it.update(kw); self._tocca_righe()
        if option: return it.get(option)
        return dict(it)

    def set(self, item, column=None, value=None):
        it = self.items[str(item)]
        if column is None:
            return dict(zip(self.colonne, it['values']))
        i = self.colonne.index(column)
        if value is None: return it['values'][i]
        it['values'][i] = value; self._tocca_righe()

    def selection(self, *a):
        return tuple(self.selez)

    def selection_set(self, *items):
        if len(items) == 1 and isinstance(items[0], (list, tuple)): items = items[0]
        self.selez = [str(i) for i in items if str(i) in self.items]
        self._tocca()

    def selection_add(self, *items):
        if len(items) == 1 and isinstance(items[0], (list, tuple)): items = items[0]
        for i in items:
            if str(i) in self.items and str(i) not in self.selez: self.selez.append(str(i))
        self._tocca()

    def selection_remove(self, *items):
        if len(items) == 1 and isinstance(items[0], (list, tuple)): items = items[0]
        self.selez = [s for s in self.selez if s not in [str(i) for i in items]]
        self._tocca()

    def focus(self, item=None):
        if item is None: return self.selez[0] if self.selez else ''

    def see(self, item):
        self.vedi = str(item); self._tocca()

    def identify_row(self, y): return EVENT_CTX.get('row', '') or ''
    def identify_column(self, x): return EVENT_CTX.get('col', '') or ''
    def identify_region(self, x, y): return 'cell' if EVENT_CTX.get('row') else 'nothing'      # il programma lo usa per i clic sulle righe dell'elenco gare
    def identify(self, *a): return ''
    def index(self, item): return self.ordine.index(str(item))
    def yview(self, *a): return (0.0, 1.0)
    def xview(self, *a): return (0.0, 1.0)
    def yview_moveto(self, f): pass

    def extra(self):
        d = {'cols': self.colonne, 'head': self.intest, 'colopt': self.col_opt, 'tags': self.tag_opt, 'sel': self.selez}
        if self.vedi: d['see'] = self.vedi; self.vedi = None
        if self._ri == self._ri_inviato:
            return d
        self._ri_inviato = self._ri
        righe = []
        for iid in self.ordine:
            it = self.items[iid]
            img = it.get('image')
            img_id = img.id if isinstance(img, PhotoImage) else None
            if img_id and not IMAGES[img_id].inviata: _IMMAGINI_DA_INVIARE.add(img_id)
            righe.append([iid, it['values'], it['tags'], img_id, it['text']])
        d['rows'] = righe
        return d


# ---------------------------------------------------------------------------------------------
# filedialog / messagebox / simpledialog
# ---------------------------------------------------------------------------------------------
def _dialogo(kind, **opts):
    for i, (k, risposta) in enumerate(DIALOG_ANSWERS):
        if k == kind:
            DIALOG_ANSWERS.pop(i)
            return risposta
    if kind == 'asksaveasfilename':
        # salvataggio: nessuna scelta da fare, il file va nella cartella dei download
        nome = opts.get('initialfile') or 'documento'
        est = opts.get('defaultextension') or ''
        if est and not nome.lower().endswith(est.lower()): nome += est
        import os
        os.makedirs(OUT_DIR, exist_ok=True)
        return OUT_DIR + '/' + nome
    raise DialogNeeded(kind, {k: _clean(v) for k, v in opts.items() if k != 'parent'})


def askdirectory(**opts): return _dialogo('askdirectory', **opts)
def askopenfilename(**opts): return _dialogo('askopenfilename', **opts)
def askopenfilenames(**opts): return _dialogo('askopenfilenames', **opts)
def asksaveasfilename(**opts): return _dialogo('asksaveasfilename', **opts)


def _msg(tipo, title=None, message=None, **opts):
    OUTBOX.append({'t': 'msg', 'kind': tipo, 'title': '' if title is None else str(title),
                   'text': '' if message is None else str(message)})
    return 'ok'


def showinfo(title=None, message=None, **opts): return _msg('info', title, message)
def showwarning(title=None, message=None, **opts): return _msg('warning', title, message)
def showerror(title=None, message=None, **opts): return _msg('error', title, message)


def _domanda(title=None, message=None, **opts):
    for i, (k, risposta) in enumerate(DIALOG_ANSWERS):
        if k == 'ask':
            DIALOG_ANSWERS.pop(i)
            return risposta
    raise DialogNeeded('ask', {'title': title, 'message': message})


askyesno = askokcancel = askquestion = askretrycancel = askyesnocancel = _domanda


# ---------------------------------------------------------------------------------------------
# vlc: il player video è un elemento <video> della pagina
# ---------------------------------------------------------------------------------------------
class _State:
    NothingSpecial = 'NothingSpecial'
    Opening = 'Opening'
    Buffering = 'Buffering'
    Playing = 'Playing'
    Paused = 'Paused'
    Stopped = 'Stopped'
    Ended = 'Ended'
    Error = 'Error'


PLAYERS = {}


class _Media:
    def __init__(self, mrl):
        self.mrl = str(mrl)
        self.opzioni = []

    def add_option(self, opt):
        self.opzioni.append(str(opt))

    def inizio(self):
        for o in self.opzioni:
            if o.startswith(':start-time='):
                try: return float(o.split('=', 1)[1])
                except ValueError: pass
        return 0.0

    def fine(self):
        for o in self.opzioni:
            if o.startswith(':stop-time='):
                try: return float(o.split('=', 1)[1])
                except ValueError: pass
        return None

    def release(self): pass


class _Player:
    def __init__(self):
        self.id = _nuovo_id('p')
        self.media = None
        self.stato = _State.NothingSpecial
        self.tempo_ms = 0
        self.da_caricare = False
        PLAYERS[self.id] = self

    def _cmd(self, cmd, **kw):
        OUTBOX.append(dict({'t': 'player', 'id': self.id, 'cmd': cmd}, **kw))

    def set_hwnd(self, wid):
        self._cmd('bind', widget=str(wid))
    set_xwindow = set_hwnd
    set_nsobject = set_hwnd

    def set_media(self, m):
        self.media = m
        self.da_caricare = True
        self.stato = _State.NothingSpecial

    def get_media(self): return self.media

    def play(self):
        if self.media is None: return -1
        if self.da_caricare or self.stato in (_State.Stopped, _State.Ended, _State.NothingSpecial, _State.Error):
            self._cmd('load', path=self.media.mrl, start=self.media.inizio(), stop=self.media.fine())
            self.da_caricare = False
            self.stato = _State.Opening
            self.tempo_ms = int(self.media.inizio() * 1000)
        else:
            self._cmd('play')
            self.stato = _State.Playing
        return 0

    def pause(self):
        if self.stato == _State.Playing:
            self._cmd('pause'); self.stato = _State.Paused
        elif self.stato == _State.Paused:
            self._cmd('play'); self.stato = _State.Playing

    def set_pause(self, flag):
        if flag:
            if self.stato in (_State.Playing, _State.Opening, _State.Buffering):
                self._cmd('pause'); self.stato = _State.Paused
        else:
            if self.stato == _State.Paused:
                self._cmd('play'); self.stato = _State.Playing

    def stop(self):
        self._cmd('stop'); self.stato = _State.Stopped

    def is_playing(self): return 1 if self.stato == _State.Playing else 0
    def get_state(self): return self.stato
    def get_time(self): return int(self.tempo_ms)

    def set_time(self, ms):
        self.tempo_ms = int(ms)
        self._cmd('seek', ms=int(ms))

    def get_length(self): return -1
    def audio_set_volume(self, v): self._cmd('volume', v=v)
    def audio_set_mute(self, m): self._cmd('mute', v=bool(m))
    def video_set_scale(self, s): pass
    def set_rate(self, r): self._cmd('rate', v=r)
    def release(self):
        self._cmd('release')
        PLAYERS.pop(self.id, None)


class _Instance:
    def __init__(self, *args): pass
    def media_player_new(self, uri=None): return _Player()
    def media_new(self, mrl, *opts):
        m = _Media(mrl)
        for o in opts: m.add_option(o)
        return m
    def media_new_path(self, p): return _Media(p)
    def release(self): pass


def _vlc_module():
    m = types.ModuleType('vlc')
    m.Instance = _Instance
    m.State = _State
    m.MediaPlayer = lambda *a: _Player()
    m.libvlc_get_version = lambda: b'html5-video'
    return m


# ---------------------------------------------------------------------------------------------
# installazione dei moduli finti
# ---------------------------------------------------------------------------------------------
COSTANTI = dict(END='end', INSERT='insert', ACTIVE='active', ANCHOR='anchor', FLAT='flat', RAISED='raised',
                SUNKEN='sunken', GROOVE='groove', RIDGE='ridge', SOLID='solid', LEFT='left', RIGHT='right',
                TOP='top', BOTTOM='bottom', BOTH='both', X='x', Y='y', N='n', S='s', E='e', W='w', NE='ne',
                NW='nw', SE='se', SW='sw', NS='ns', EW='ew', NSEW='nsew', CENTER='center', HORIZONTAL='horizontal',
                VERTICAL='vertical', SINGLE='single', BROWSE='browse', MULTIPLE='multiple', EXTENDED='extended',
                NORMAL='normal', DISABLED='disabled', HIDDEN='hidden', WORD='word', CHAR='char', NONE='none',
                YES=True, NO=False, TRUE=True, FALSE=False)


def reset():
    for reg in (WIDGETS, VARS, IMAGES, TIMERS, STYLES, STYLE_MAPS, EVENT_CTX, PLAYERS):
        reg.clear()
    for lst in (WINDOWS, OUTBOX, DIALOG_ANSWERS, CLOSED):
        lst.clear()
    _LEGATI.clear()
    _IMMAGINI_DA_INVIARE.clear()


def installa():
    tk = types.ModuleType('tkinter')
    for nome, val in COSTANTI.items(): setattr(tk, nome, val)
    for cls in (Tk, Toplevel, Frame, LabelFrame, Label, Message, Button, Checkbutton, Radiobutton, Entry, Spinbox,
                Scale, Scrollbar, Canvas, Text, Listbox, PanedWindow, Menu, PhotoImage, Variable, StringVar, IntVar,
                DoubleVar, BooleanVar, Event, TclError, Widget, Misc):
        setattr(tk, cls.__name__, cls)
    tk.TkVersion = 8.6
    tk.TclVersion = 8.6
    tk.__path__ = []

    ttk = types.ModuleType('tkinter.ttk')
    for cls in (Frame, LabelFrame, Label, Button, Checkbutton, Radiobutton, Entry, Scale, Scrollbar, PanedWindow,
                Style, Combobox, Notebook, Treeview, Spinbox):
        setattr(ttk, cls.__name__, cls)
    ttk.Progressbar = Frame
    ttk.Separator = Frame
    ttk.Sizegrip = Frame

    fd = types.ModuleType('tkinter.filedialog')
    fd.askdirectory, fd.askopenfilename, fd.askopenfilenames, fd.asksaveasfilename = askdirectory, askopenfilename, askopenfilenames, asksaveasfilename

    mb = types.ModuleType('tkinter.messagebox')
    mb.showinfo, mb.showwarning, mb.showerror = showinfo, showwarning, showerror
    mb.askyesno = mb.askokcancel = mb.askquestion = mb.askretrycancel = mb.askyesnocancel = _domanda

    sd = types.ModuleType('tkinter.simpledialog')
    sd.askstring = sd.askinteger = sd.askfloat = lambda *a, **k: _domanda(*a[:2])

    font = types.ModuleType('tkinter.font')
    font.Font = lambda *a, **k: types.SimpleNamespace(measure=lambda s: 7 * len(str(s)), metrics=lambda *a: 14, configure=lambda **k: None, actual=lambda *a: {})
    font.nametofont = lambda n: font.Font()

    tk.ttk, tk.filedialog, tk.messagebox, tk.simpledialog, tk.font = ttk, fd, mb, sd, font
    tk.WEB = True
    try:
        import PIL
        itk = _imagetk_module(); PIL.ImageTk = itk; sys.modules['PIL.ImageTk'] = itk
    except ImportError:
        pass
    sys.modules.update({'tkinter': tk, 'tkinter.ttk': ttk, 'tkinter.filedialog': fd,
                        'tkinter.messagebox': mb, 'tkinter.simpledialog': sd, 'tkinter.font': font,
                        'vlc': _vlc_module()})


def immagini_nuove():
    """Immagini (SVG/PNG) ancora non inviate alla pagina: {id: (mime, base64)}."""
    import base64
    out = {}
    for iid in list(_IMMAGINI_DA_INVIARE):
        img = IMAGES.get(iid)
        if img is None or img.inviata: continue
        dati = img.data or b''
        mime = 'image/svg+xml' if dati[:200].lstrip().startswith((b'<?xml', b'<svg')) else 'image/png'
        out[iid] = [mime, base64.b64encode(dati).decode('ascii')]
        img.inviata = True
    _IMMAGINI_DA_INVIARE.clear()
    return out
