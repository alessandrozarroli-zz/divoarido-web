// CONFIGURAZIONE della versione web di DivoArido.
// L'unico valore da compilare è GOOGLE_CLIENT_ID (vedi LEGGIMI.html, passo 2).
window.VPS_CONFIG = {
  // ID client OAuth "Applicazione web" creato su Google Cloud (finisce con .apps.googleusercontent.com)
  GOOGLE_CLIENT_ID: '351564478558-bu2q0h5jetbt5fk51v5lthh89hgpq9jk.apps.googleusercontent.com',

  // Consigliato se la pagina è pubblicata su Internet: link (o ID) del file
  // "DIVOARIDO.py" caricato sul Google Drive. Così il programma lo legge solo chi
  // accede con Google e ha accesso a quel file; per aggiornarlo basta sostituire il file sul Drive
  // (tasto destro > Gestisci versioni > Carica nuova versione, così il link resta lo stesso).
  // Vuoto = usa il file engine/volley.py che sta accanto alla pagina.
  PROGRAMMA_DRIVE: '18thrQY5rO6YIz_YPI9JSnJ9KdH3YEHhg',   // «DivoArido / programma / DIVOARIDO.py» sul Drive

  // Facoltativo: cartelle del Drive proposte al primo avvio a chi non ne ha ancora scelte.
  // Si incolla l'ID (la parte finale del link della cartella: drive.google.com/drive/folders/QUESTO_ID)
  // Sono le cartelle di Dvs_Video (area «Computer» del Drive). Partite (.dvw) e video stanno nella STESSA cartella,
  // una sottocartella per partita: si legge tutto con un solo passaggio. Chi accede deve avere la cartella condivisa
  // (tasto destro > Condividi, permesso Visualizzatore); altrimenti compare un messaggio e sceglie un'altra cartella con Sfoglia.
  // Le PARTITE (.dvw) si leggono dalla cartella «Scout» (copia su Drive di «FIXED GAMES 26-27\Scout», quella del collegamento
  // Fixed-Scout sul PC); i VIDEO da Dvs_Video. Un video senza una partita in Scout non compare da nessuna parte.
  CARTELLA_DVW_PREDEFINITA: '1qTFFktJBODbzXcoVxxqZHYgAiEocLOwU',
  NOME_CARTELLA_DVW: 'Scout',
  // Da cambiare quando cambiano le cartelle predefinite: una volta sola, nel browser di ognuno, si dimenticano le cartelle
  // ricordate (non gli abbinamenti partita↔video, che stanno sul Drive) e si propongono quelle nuove.
  REV_CARTELLE_PREDEFINITE: '2',
  CARTELLA_VIDEO_PREDEFINITA: '1CIuHRvdIjTa1xhNcvOHwRD5KlwaVfNEU',
  NOME_CARTELLA_VIDEO: 'Dvs_Video',

  // Cartella del Drive dove il programma salva i PROPRI dati (flag, traiettorie, abbinamenti partita↔video), separata dalle
  // partite e dai video. Si incolla l'ID della cartella (come sopra). Chi deve poter salvare ha il permesso Editor su
  // questa cartella; per Dvs_Video basta la sola visualizzazione. Vuoto = i dati restano nella cartella delle partite.
  // Copie leggere (720p) delle gare: ID della cartella «DivoArido / Video gare web» sul Drive (vuoto = non usate). Le crea crea_copie_web.py --gare.
  CARTELLA_VIDEO_WEB: '1_muz3-YJOKpBttl5AY9SiQ4Uzgf4-o2f',   // «DivoArido / Video gare web»

  CARTELLA_DATI: '1uctZk79NcDcXxKyvh727Fgd9u4r6OIg7',          // «DivoArido / dati» sul Drive

  // Sezione ALLENAMENTI (interruttore Gare/Allenamenti): i file .dvw delle sedute (solo quelli con @ nel nome) stanno in
  // «DivoArido / Allenamenti» e i video in «DivoArido / Allenamenti / Video» (una sottocartella per seduta). Chi non ha la
  // cartella condivisa non vede l'interruttore.
  CARTELLA_ALLEN_DVW_PREDEFINITA: '1TKioSeOXz2Xap75iyWR6WJV9ck2bwP5d',
  NOME_CARTELLA_ALLEN_DVW: 'Allenamenti',
  CARTELLA_ALLEN_VIDEO_PREDEFINITA: '1nh70WdXAFKGWXk3UG5q9genQddlIFB16',
  NOME_CARTELLA_ALLEN_VIDEO: 'Allenamenti - video',

  // LINK PER OSPITI (fase 7): indirizzo del servizio Google Apps Script (ospiti\Code.gs, «Distribuisci» > «Applicazione web»), finisce con /exec.
  // Vuoto = link per ospiti NON attivi (nessun pulsante «Link ospiti», e i link gia' dati non funzionano).
  OSPITI_URL: 'https://script.google.com/macros/s/AKfycbw0iMYHN_Z64ZeMsEJ4RO2i-hLc1zzfKN0yQL2Q4llDu_kpQ8dNThWxu0NUrQq7Rxnd5Q/exec',

  // PROFILI D'USO (completo / reader / personalizzati, vedi js/profili.js). MARCATORE_COMPLETO = ID della cartella «Funzioni complete»
  // (la vede solo chi ha il profilo completo; vuoto = profili NON attivi, tutti vedono tutto come prima). CARTELLA_PROFILI = ID della
  // cartella del proprietario in cui la pagina «Gestione profili» crea le cartelle-marcatore dei profili personalizzati.
  MARCATORE_COMPLETO: '',
  CARTELLA_PROFILI: '',

  // false = le sedute di allenamento (cartelle o file con «allenam» nel nome) non entrano nell'elenco delle gare:
  // nel web non c'è ancora la sezione Allenamenti. Mettere true per includerle.
  INCLUDI_ALLENAMENTI: false,

  // Non modificare (versioni dei componenti)
  PYODIDE_URL: 'https://cdn.jsdelivr.net/pyodide/v0.28.2/full/',
  REPORTLAB_WHEEL: 'reportlab-5.0.1-py3-none-any.whl',
  VERSIONE: '20261125-1041',
};
