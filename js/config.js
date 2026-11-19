// CONFIGURAZIONE della versione web di DivoArido.
// L'unico valore da compilare è GOOGLE_CLIENT_ID (vedi LEGGIMI.html, passo 2).
window.VPS_CONFIG = {
  // ID client OAuth "Applicazione web" creato su Google Cloud (finisce con .apps.googleusercontent.com)
  GOOGLE_CLIENT_ID: '351564478558-bu2q0h5jetbt5fk51v5lthh89hgpq9jk.apps.googleusercontent.com',

  // Consigliato se la pagina è pubblicata su Internet: link (o ID) del file
  // "VOLLEY PRO SUITE VIDEO.py" caricato sul Google Drive. Così il programma lo legge solo chi
  // accede con Google e ha accesso a quel file; per aggiornarlo basta sostituire il file sul Drive
  // (tasto destro > Gestisci versioni > Carica nuova versione, così il link resta lo stesso).
  // Vuoto = usa il file engine/volley.py che sta accanto alla pagina.
  PROGRAMMA_DRIVE: '18thrQY5rO6YIz_YPI9JSnJ9KdH3YEHhg',   // «DivoArido / programma / VOLLEY PRO SUITE VIDEO.py» sul Drive

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
  CARTELLA_DATI: '1uctZk79NcDcXxKyvh727Fgd9u4r6OIg7',          // «DivoArido / dati» sul Drive

  // false = le sedute di allenamento (cartelle o file con «allenam» nel nome) non entrano nell'elenco delle gare:
  // nel web non c'è ancora la sezione Allenamenti. Mettere true per includerle.
  INCLUDI_ALLENAMENTI: false,

  // Non modificare (versioni dei componenti)
  PYODIDE_URL: 'https://cdn.jsdelivr.net/pyodide/v0.28.2/full/',
  REPORTLAB_WHEEL: 'reportlab-5.0.1-py3-none-any.whl',
  VERSIONE: '1.0.23-20261119-1554',
};
