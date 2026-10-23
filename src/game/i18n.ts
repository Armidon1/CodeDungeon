// Lingua dell'interfaccia: inglese (predefinita) o italiano.
// I testi fissi della pagina hanno `data-i18n="percorso.della.voce"` (e `data-i18n-placeholder`, `-title`, `-aria-label`):
// setLang li riscrive tutti. I testi che cambiano a runtime usano `t()` e vanno ridisegnati dopo un cambio di lingua.
// I testi dei tour e le risposte dell'agente restano nella lingua in cui sono scritti.

import type { Aid, DiagramKind, Expression, GenerationMode, Level } from "../shared/types";

export const LANGS = ["en", "it"] as const;
export type Lang = (typeof LANGS)[number];

/** Ogni lingua presentata nella lingua stessa: si riconosce anche senza capire l'altra. */
export const LANG_INFO: Record<Lang, { label: string; hint: string }> = {
  en: { label: "English", hint: "Menus in English. The agent writes in English too." },
  it: { label: "Italiano", hint: "Menu in italiano. Anche l'agente scrive in italiano." },
};

type Info = { label: string; hint: string };

const en = {
  ui: {
    audio: "♪ Audio",
    audioTitle: "Audio (M key)",
    menu: "Menu",
    openMenu: "Open the menu",
    explorer: "Explorer",
    explorerLabel: "File explorer",
    savedTours: "Saved tours",
    diagrams: "Diagrams",
    questions: "Questions",
    openTabs: "Open tabs",
    codeEditor: "Code editor",
    noFile: "No file open.",
    noFileHint: "Pick a tour, or ask the agent to open a file.",
    board: "Board",
    boardHint: "Rooms with a gem open their code.",
    fold: "Minimize",
    unfold: "Open",
    toTab: "Tab",
    closeBoard: "Close the board",
    dialog: "Dialog with the guide",
    levelSwitch: "Explanation level",
    back: "◀ Back",
    next: "Next ▶",
    skip: "Skip ▶▶",
    askLabel: "Question for the guide",
    ask: "Ask",
    closeTab: "Close the tab",
  },
  menu: {
    language: "Language",
    level: "Explanation level",
    generation: "Text generation",
    guide: "The guide",
    guideName: "Name",
    uploadImage: "Upload your image",
    editImage: "Edit your image",
    yourImage: "Your image",
    imageIntro: "A photo or a drawing becomes pixel art. It stays in this browser: it is never sent anywhere.",
    pickImage: "Choose an image",
    changeImage: "Change image",
    compression: "Compression",
    detail: "Detail",
    retune: "To change the compression, choose the image again.",
    expressions: "Expressions",
    expressionsIntro: "The automatic ones add a speech bubble and shift the colors a little. You can upload your own for each one.",
    cancel: "Cancel",
    useGuide: "Use this guide",
    sound: "Music and sounds",
    music: "Music",
    effects: "Effects",
    voice: "Guide's voice while talking",
    soundNote: "Music and sounds are made by the game, with no audio files. The M key mutes and unmutes.",
    reader: "What helps you understand",
    readerIntro: "Optional. Pick what you need: the game changes right away, the agent adapts its explanations.",
    readerNote: "Anything else about how you read (optional)",
    readerNotePlaceholder: "E.g. “I read better with bullet lists”",
    readerPrivacy: "Your answers stay on this computer. The agent gets them only to adapt its explanations. No certificates or diagnoses needed.",
    readerClear: "Clear answers",
    enter: "Enter the dungeon ▶",
    resume: "Resume exploring ▶",
    keys: "Keyboard: Enter or → next · ← back · 1–4 level · Esc closes the board or opens the menu · M audio",
  },
  levels: {
    facile: { label: "Easy", hint: "For non-programmers. Metaphors, no jargon." },
    medio: { label: "Medium", hint: "Basic technical terms, structure and flow." },
    difficile: { label: "Hard", hint: "Implementation details and design choices." },
    arduo: { label: "Expert", hint: "Low level: protocols, flags, memory, security flaws." },
  } satisfies Record<Level, Info>,
  generation: {
    istantanea: { label: "Instant", hint: "Every level ready at once: instant switching, more tokens." },
    su_richiesta: { label: "On demand", hint: "Only the chosen level: fewer tokens, a few seconds' wait when you switch." },
  } satisfies Record<GenerationMode, Info>,
  aids: {
    frasi_brevi: { label: "Short sentences", hint: "One idea per sentence." },
    poco_testo: { label: "Little text at a time", hint: "The speech bubble splits into short pages." },
    piu_schemi: { label: "More diagrams", hint: "The guide draws on the board more often." },
    esempi: { label: "Concrete examples", hint: "An example or a metaphor for every concept." },
    termini: { label: "Explain the terms", hint: "Every technical word explained the first time." },
    font_leggibile: { label: "Highly legible font", hint: "Atkinson Hyperlegible instead of pixel letters." },
    testo_grande: { label: "Larger text", hint: "Bigger speech bubble, code and menu." },
    meno_movimento: { label: "Fewer animations", hint: "No letter-by-letter typing, fades or walking." },
  } satisfies Record<Aid, Info>,
  tracks: {
    taverna: { label: "Tavern", hint: "Warm and calm, for unhurried reading." },
    grotta: { label: "Crystal cave", hint: "Mysterious, with the dungeon's echo." },
    biblioteca: { label: "Library", hint: "Slow and soft, almost in the background." },
    forziere: { label: "Treasure chest", hint: "Cheerful and fast, ready for adventure." },
    off: { label: "None", hint: "Silence: the effects stay on." },
  },
  guides: {
    lumen: "Lantern, default",
    aria: "Feminine",
    patrizio: "Masculine",
    nilo: "Neutral",
    custom: "Photo or drawing",
  },
  presets: { 48: "Light", 32: "Medium", 20: "Strong" } as Record<number, string>,
  expressions: {
    neutro: "Neutral",
    felice: "Happy",
    pensieroso: "Thoughtful",
    preoccupato: "Worried",
    sorpreso: "Surprised",
  } satisfies Record<Expression, string>,
  kinds: { flusso: "Flow", sequenza: "Sequence" } satisfies Record<DiagramKind, string>,
  msg: {
    defaultGuide: "Guide",
    tagline: (name: string) => `${name} walks you through the code, one program step at a time.`,
    askPlaceholder: (name: string) => `Ask ${name} something about this code…`,
    helloAgent: (name: string) =>
      `Hi, I'm ${name}! This project has no tour yet. Ask your agent to create one with the Code Dungeon tools, or write me a question below.`,
    helloNoAgent: (name: string) => `Hi, I'm ${name}! I can't find any saved tours in this project. Start Code Dungeon from your agent (see the README) to create one.`,
    sourceDemo: (project: string) => `Demo · sample project “${project}”, a TCP server in Python`,
    sourceProject: (project: string, agent: boolean) => `Project “${project}”${agent ? " · agent connected" : " · no agent"}`,
    sourceWaiting: "Waiting for the bridge on 127.0.0.1:7337… start `npm run play` or the MCP server.",
    noTours: "No tours saved in .tour/",
    noDiagrams: "No diagrams in .tour/schemi/",
    steps: (n: number) => (n === 1 ? "1 step" : `${n} steps`),
    noConversations: "No questions yet: ask one below.",
    questions: (n: number) => (n === 1 ? "1 question" : `${n} questions`),
    you: "You",
    followUp: "Ask a follow-up to this answer…",
    cantLoadConversation: (err: string) => `I can't load the conversation: ${err}`,
    tabDiagram: (title: string) => `Diagram: ${title}`,
    cantOpenFile: (path: string, err: string) => `I can't open ${path}: ${err}`,
    cantOpenDiagram: (err: string) => `I can't open the diagram: ${err}`,
    cantLoadDiagram: (id: string, err: string) => `I can't load the diagram “${id}”: ${err}`,
    cantLoadTour: (err: string) => `I can't load the tour: ${err}`,
    page: (i: number, n: number) => `Page ${i} of ${n}.`,
    noText: "(This step has no text yet.)",
    missingLevel: (want: string, shown: string) => `This step has no “${want}” version yet: here is “${shown}”.`,
    askedAgent: "I asked the agent to write it: let me think...",
    missingStep: (id: string) => `The step “${id}” doesn't exist in this tour.`,
    theTour: "the tour",
    end: "End",
    tourEnd: (title: string) => `We finished “${title}”! You can play it again, switch level to reread it with fresh eyes, or ask me a question.`,
    restart: "Restart the tour",
    stay: "Stay here",
    answer: "Answer",
    asked: "I passed your question to the agent. Let me think...",
    waitHint: "No answer yet. If the agent isn't listening, write in its terminal: “answer the questions in the game”.",
    demoNoAgent:
      "There's no agent connected in this demo, so I can't answer free questions. Start Code Dungeon with Claude Code, Codex or Gemini CLI (instructions in the README) and I'll answer live.",
    playNoAgent:
      "You're in playback mode (npm run play), with no agent to answer. Start Code Dungeon as an MCP server from your agent and your question will reach it.",
    bridgeDown: "The bridge isn't connected: I can't get your question to the agent.",
    moreMessages: (n: number) => (n === 1 ? "There's another message: press Next." : `There are ${n} more messages: press Next.`),
    statusDemo: "● Demo",
    statusConnecting: "○ Connecting…",
    statusAgent: "● Agent connected",
    statusBridge: "● Bridge connected",
    statusOffline: "○ Bridge unreachable",
    statusLevel: (label: string) => `Level: ${label}`,
    stepCounter: (k: number, n: number) => `Step ${k}/${n}`,
    muted: "Audio off: turn on",
    unmuted: "Audio on: turn off",
    plainText: "Plain text",
    // guida personalizzata
    expressionLoaded: (label: string) => `“${label}” expression loaded.`,
    pickMainFirst: "Choose the main image first.",
    mainImage: "Main image",
    uploaded: "Uploaded",
    automatic: "Automatic",
    upload: "Upload",
    presetHint: (size: number, colors: number) => `${size} px · ${colors} colors`,
    detailOut: (size: number, colors: number) => `${size} × ${size} px · ${colors} colors`,
    cantStoreImage: "The browser won't let me save the image: it lasts until you close the page.",
    notImage: "The file isn't an image.",
    tooBig: "The image is larger than 20 MB.",
    unreadable: "I can't read this image.",
    badStored: "Saved image not valid.",
    // lavagna
    openCode: (file: string, a: number, b: number) => `Open ${file}, lines ${a}-${b}`,
    openCodeAria: (label: string, file: string, a: number, b: number) => `${label}: open ${file}, lines ${a}-${b}`,
    boardSummary: (title: string, kind: string, nodes: string) => `Diagram “${title}” (${kind}): ${nodes}.`,
    // collegamento
    bridgeClosed: "Connection to the bridge closed.",
    bridgeNotConnected: "The bridge isn't connected.",
    notFound: (what: string) => `Not found: ${what}`,
  },
};

type Dict = typeof en;

const it: Dict = {
  ui: {
    audio: "♪ Audio",
    audioTitle: "Audio (tasto M)",
    menu: "Menu",
    openMenu: "Apri il menu",
    explorer: "Esplora",
    explorerLabel: "Esplora file",
    savedTours: "Tour salvati",
    diagrams: "Schemi",
    questions: "Domande",
    openTabs: "Schede aperte",
    codeEditor: "Editor del codice",
    noFile: "Nessun file aperto.",
    noFileHint: "Scegli un tour, oppure chiedi all'agente di aprire un file.",
    board: "Lavagna",
    boardHint: "Le stanze con la gemma aprono il loro codice.",
    fold: "Riduci",
    unfold: "Apri",
    toTab: "Scheda",
    closeBoard: "Chiudi la lavagna",
    dialog: "Dialogo con la guida",
    levelSwitch: "Livello della spiegazione",
    back: "◀ Indietro",
    next: "Avanti ▶",
    skip: "Salta ▶▶",
    askLabel: "Domanda per la guida",
    ask: "Chiedi",
    closeTab: "Chiudi la scheda",
  },
  menu: {
    language: "Lingua",
    level: "Livello di spiegazione",
    generation: "Generazione dei testi",
    guide: "La guida",
    guideName: "Nome",
    uploadImage: "Carica la tua immagine",
    editImage: "Modifica la tua immagine",
    yourImage: "La tua immagine",
    imageIntro: "Una foto o un disegno diventa pixel art. Resta in questo browser: non viene inviata a nessuno.",
    pickImage: "Scegli un'immagine",
    changeImage: "Cambia immagine",
    compression: "Compressione",
    detail: "Dettaglio",
    retune: "Per cambiare la compressione scegli di nuovo l'immagine.",
    expressions: "Espressioni",
    expressionsIntro: "Quelle automatiche aggiungono un fumetto e cambiano un po' i colori. Puoi caricarne una tua per ciascuna.",
    cancel: "Annulla",
    useGuide: "Usa questa guida",
    sound: "Musica e suoni",
    music: "Musica",
    effects: "Effetti",
    voice: "Voce della guida mentre parla",
    soundNote: "Musiche e suoni sono creati dal gioco, senza file audio. Il tasto M toglie e rimette l'audio.",
    reader: "Cosa ti aiuta a capire",
    readerIntro: "Facoltativo. Scegli quello che ti serve: il gioco cambia subito, l'agente adatta le spiegazioni.",
    readerNote: "Altro da sapere su come leggi (facoltativo)",
    readerNotePlaceholder: "Es. «leggo meglio con elenchi puntati»",
    readerPrivacy: "Le risposte restano su questo computer. L'agente le riceve solo per adattare le spiegazioni. Non servono certificati né diagnosi.",
    readerClear: "Cancella le risposte",
    enter: "Entra nel dungeon ▶",
    resume: "Riprendi l'esplorazione ▶",
    keys: "Tastiera: Invio o → avanti · ← indietro · 1–4 livello · Esc chiude la lavagna o apre il menu · M audio",
  },
  levels: {
    facile: { label: "Facile", hint: "Per chi non programma. Metafore, niente gergo." },
    medio: { label: "Medio", hint: "Termini tecnici di base, struttura e flusso." },
    difficile: { label: "Difficile", hint: "Dettagli implementativi e scelte di design." },
    arduo: { label: "Arduo", hint: "Basso livello: protocolli, flag, memoria, falle di sicurezza." },
  },
  generation: {
    istantanea: { label: "Istantanea", hint: "Tutti i livelli pronti subito: cambio immediato, più token." },
    su_richiesta: { label: "Su richiesta", hint: "Solo il livello scelto: meno token, qualche secondo d'attesa quando cambi." },
  },
  aids: {
    frasi_brevi: { label: "Frasi brevi", hint: "Una idea per frase." },
    poco_testo: { label: "Poco testo per volta", hint: "Il fumetto si divide in pagine corte." },
    piu_schemi: { label: "Più schemi", hint: "La guida disegna più spesso sulla lavagna." },
    esempi: { label: "Esempi concreti", hint: "Un esempio o una metafora per ogni concetto." },
    termini: { label: "Spiega i termini", hint: "Ogni parola tecnica spiegata la prima volta." },
    font_leggibile: { label: "Font ad alta leggibilità", hint: "Atkinson Hyperlegible al posto dei caratteri pixel." },
    testo_grande: { label: "Testo più grande", hint: "Fumetto, codice e menu più grandi." },
    meno_movimento: { label: "Meno animazioni", hint: "Niente scrittura lettera per lettera, dissolvenze e camminate." },
  },
  tracks: {
    taverna: { label: "Taverna", hint: "Calda e tranquilla, per leggere con calma." },
    grotta: { label: "Grotta di cristallo", hint: "Misteriosa, con l'eco del dungeon." },
    biblioteca: { label: "Biblioteca", hint: "Lenta e morbida, quasi in sottofondo." },
    forziere: { label: "Forziere", hint: "Allegra e veloce, da avventura." },
    off: { label: "Nessuna", hint: "Silenzio: restano gli effetti." },
  },
  guides: {
    lumen: "Lanterna, predefinita",
    aria: "Femminile",
    patrizio: "Maschile",
    nilo: "Neutro",
    custom: "Foto o disegno",
  },
  presets: { 48: "Leggera", 32: "Media", 20: "Forte" },
  expressions: {
    neutro: "Neutro",
    felice: "Felice",
    pensieroso: "Pensieroso",
    preoccupato: "Preoccupato",
    sorpreso: "Sorpreso",
  },
  kinds: { flusso: "Flusso", sequenza: "Sequenza" },
  msg: {
    defaultGuide: "Guida",
    tagline: (name) => `${name} ti accompagna dentro il codice, un passo del programma alla volta.`,
    askPlaceholder: (name) => `Chiedi a ${name} qualcosa su questo codice…`,
    helloAgent: (name) =>
      `Ciao, sono ${name}! Questo progetto non ha ancora un tour. Chiedi al tuo agente di crearne uno con gli strumenti di Code Dungeon, oppure scrivimi qui sotto una domanda.`,
    helloNoAgent: (name) => `Ciao, sono ${name}! Non trovo tour salvati in questo progetto. Avvia Code Dungeon dal tuo agente (vedi il README) per crearne uno.`,
    sourceDemo: (project) => `Demo · progetto d'esempio «${project}», un server TCP in Python`,
    sourceProject: (project, agent) => `Progetto «${project}»${agent ? " · agente collegato" : " · senza agente"}`,
    sourceWaiting: "In attesa del ponte su 127.0.0.1:7337… avvia `npm run play` o il server MCP.",
    noTours: "Nessun tour salvato in .tour/",
    noDiagrams: "Nessuno schema in .tour/schemi/",
    steps: (n) => (n === 1 ? "1 passo" : `${n} passi`),
    noConversations: "Ancora nessuna domanda: scrivine una qui sotto.",
    questions: (n) => (n === 1 ? "1 domanda" : `${n} domande`),
    you: "Tu",
    followUp: "Continua la conversazione su questa risposta…",
    cantLoadConversation: (err) => `Non riesco a caricare la conversazione: ${err}`,
    tabDiagram: (title) => `Schema: ${title}`,
    cantOpenFile: (path, err) => `Non riesco ad aprire ${path}: ${err}`,
    cantOpenDiagram: (err) => `Non riesco ad aprire lo schema: ${err}`,
    cantLoadDiagram: (id, err) => `Non riesco a caricare lo schema «${id}»: ${err}`,
    cantLoadTour: (err) => `Non riesco a caricare il tour: ${err}`,
    page: (i, n) => `Pagina ${i} di ${n}.`,
    noText: "(Questo passo non ha ancora testo.)",
    missingLevel: (want, shown) => `Questo passo non ha ancora la versione «${want}»: ti mostro «${shown}».`,
    askedAgent: "Ho chiesto all'agente di scriverla: fammi pensare...",
    missingStep: (id) => `Il passo «${id}» non esiste in questo tour.`,
    theTour: "il tour",
    end: "Fine",
    tourEnd: (title) => `Abbiamo finito «${title}»! Puoi rigiocarlo, cambiare livello per rileggerlo con occhi diversi, o farmi una domanda.`,
    restart: "Ricomincia il tour",
    stay: "Resto qui",
    answer: "Risposta",
    asked: "Ho passato la tua domanda all'agente. Fammi pensare...",
    waitHint: "Ancora nessuna risposta. Se l'agente non è in ascolto, scrivigli nel terminale: «rispondi alle domande nel gioco».",
    demoNoAgent:
      "In questa demo non c'è un agente collegato, quindi non posso rispondere a domande libere. Avvia Code Dungeon con Claude Code, Codex o Gemini CLI (istruzioni nel README) e risponderò dal vivo.",
    playNoAgent:
      "Sei in modalità riproduzione (npm run play), senza un agente che possa rispondere. Avvia Code Dungeon come server MCP dal tuo agente e la tua domanda arriverà a lui.",
    bridgeDown: "Il ponte non è collegato: non riesco a far arrivare la domanda all'agente.",
    moreMessages: (n) => (n === 1 ? "C'è un altro messaggio: premi Avanti." : `Ci sono altri ${n} messaggi: premi Avanti.`),
    statusDemo: "● Demo",
    statusConnecting: "○ Collegamento…",
    statusAgent: "● Agente collegato",
    statusBridge: "● Ponte collegato",
    statusOffline: "○ Ponte non raggiungibile",
    statusLevel: (label) => `Livello: ${label}`,
    stepCounter: (k, n) => `Passo ${k}/${n}`,
    muted: "Audio spento: riattiva",
    unmuted: "Audio attivo: spegni",
    plainText: "Testo",
    expressionLoaded: (label) => `Espressione «${label.toLowerCase()}» caricata.`,
    pickMainFirst: "Prima scegli l'immagine principale.",
    mainImage: "Immagine principale",
    uploaded: "Caricata",
    automatic: "Automatica",
    upload: "Carica",
    presetHint: (size, colors) => `${size} px · ${colors} colori`,
    detailOut: (size, colors) => `${size} × ${size} px · ${colors} colori`,
    cantStoreImage: "Il browser non mi lascia salvare l'immagine: vale fino alla chiusura della pagina.",
    notImage: "Il file non è un'immagine.",
    tooBig: "L'immagine supera 20 MB.",
    unreadable: "Non riesco a leggere questa immagine.",
    badStored: "Immagine salvata non valida.",
    openCode: (file, a, b) => `Apri ${file}, righe ${a}-${b}`,
    openCodeAria: (label, file, a, b) => `${label}: apri ${file}, righe ${a}-${b}`,
    boardSummary: (title, kind, nodes) => `Schema «${title}» (${kind}): ${nodes}.`,
    bridgeClosed: "Connessione al ponte chiusa.",
    bridgeNotConnected: "Il ponte non è collegato.",
    notFound: (what) => `Non trovato: ${what}`,
  },
};

const DICTS: Record<Lang, Dict> = { en, it };

let current: Lang = "en";

/** I testi nella lingua scelta. */
export const t = (): Dict => DICTS[current];

export const lang = (): Lang => current;

/** Nome predefinito per la guida con un'immagine propria, in qualsiasi lingua (per riconoscerlo e tradurlo). */
export const DEFAULT_GUIDE_NAMES = LANGS.map((l) => DICTS[l].msg.defaultGuide);

/** Cambia lingua e riscrive i testi fissi della pagina. */
export function setLang(l: Lang): void {
  current = l;
  document.documentElement.lang = l;
  translate(document);
}

/** Riscrive i testi segnati con data-i18n dentro root (anche HTML aggiunto dopo). */
export function translate(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = lookup(el.dataset.i18n!);
  for (const attr of ["placeholder", "title", "aria-label"]) {
    for (const el of root.querySelectorAll<HTMLElement>(`[data-i18n-${attr}]`)) el.setAttribute(attr, lookup(el.getAttribute(`data-i18n-${attr}`)!));
  }
}

/** "levels.facile.label" → il testo; un percorso sbagliato si vede subito invece di lasciare il vuoto. */
function lookup(path: string): string {
  let v: unknown = DICTS[current];
  for (const key of path.split(".")) v = (v as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v : path;
}
