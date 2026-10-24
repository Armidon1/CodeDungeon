// Tipi condivisi tra il server MCP (Node) e il gioco (browser).

export const LEVELS = ["facile", "medio", "difficile", "arduo"] as const;
export type Level = (typeof LEVELS)[number];

export const EXPRESSIONS = ["neutro", "felice", "pensieroso", "preoccupato", "sorpreso"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export type GenerationMode = "istantanea" | "su_richiesta";

/** Testo di un passo, una versione per livello. Almeno un livello deve esserci. */
export type LevelText = Partial<Record<Level, string>>;

/** Collegamento al passo successivo. Con più collegamenti il gioco mostra una scelta. */
export interface StepLink {
  goto: string;
  /** Etichetta mostrata come scelta, es. "type == LOGIN". */
  when?: string;
}

export interface TourStep {
  id: string;
  /** Percorso relativo alla radice del progetto. */
  file: string;
  /** Intervallo di righe incluso, a partire da 1. */
  lines: [number, number];
  expression?: Expression;
  /** Titolo breve del passo, mostrato nella barra di stato. */
  title?: string;
  text: LevelText;
  /** Se assente, si passa al passo successivo nell'elenco. Se vuoto, il tour finisce. */
  next?: StepLink[];
  /** Schema da mostrare nella lavagna durante il passo. */
  diagram?: StepDiagram;
}

export interface StepDiagram {
  id: string;
  /** Quanti pezzi mostrare (vedi Diagram). Se assente, lo schema completo. */
  upto?: number;
}

// ---------- Lavagna degli schemi ----------

export const DIAGRAM_KINDS = ["flusso", "sequenza"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export const DIAGRAM_SHAPES = ["stanza", "bivio", "archivio", "attore"] as const;
export type DiagramShape = (typeof DIAGRAM_SHAPES)[number];

export interface DiagramNode {
  id: string;
  label: string;
  shape?: DiagramShape;
  /** Codice a cui rimanda il nodo: un clic lo apre nell'editor. */
  code?: { file: string; lines: [number, number] };
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  style?: "pieno" | "tratteggiato";
}

/**
 * Schema della lavagna, salvato in .tour/schemi/<id>.json.
 * Disegno progressivo: in un flusso i pezzi sono i nodi (nell'ordine dell'elenco, gli archi compaiono
 * quando entrambi gli estremi sono visibili); in una sequenza i pezzi sono i messaggi (archi).
 */
export interface Diagram {
  version: 1;
  id: string;
  title: string;
  kind: DiagramKind;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DiagramSummary {
  id: string;
  title: string;
  kind: DiagramKind;
}

/** Numero di pezzi dello schema per il disegno progressivo. */
export function diagramPieces(d: Diagram): number {
  return d.kind === "sequenza" ? d.edges.length : d.nodes.length;
}

// ---------- Accessibilità: cosa aiuta chi legge ----------

/** Aiuti scelti nel questionario. Alcuni cambiano il gioco (etichette in src/game/i18n.ts), altri il modo in cui scrive l'agente. */
export const AIDS = ["frasi_brevi", "poco_testo", "piu_schemi", "esempi", "termini", "font_leggibile", "meno_movimento"] as const;
export type Aid = (typeof AIDS)[number];

/** Cosa chiede ogni aiuto all'agente. Gli aiuti senza voce li applica solo il gioco. */
export const AID_AGENT: Partial<Record<Aid, string>> = {
  frasi_brevi: "frasi brevi, una idea per frase",
  poco_testo: "fumetti corti (2-3 frasi): meglio più passi o più show_dialog che un blocco lungo",
  piu_schemi: "usa spesso la lavagna (draw_diagram), anche per concetti piccoli",
  esempi: "un esempio concreto o una metafora per ogni concetto",
  termini: "spiega ogni termine tecnico la prima volta che lo usi",
};

export const READER_NOTE_MAX = 300;

/** Le risposte al questionario. Restano sul computer dell'utente; l'agente le riceve per adattare le spiegazioni. */
export interface ReaderProfile {
  aids: Aid[];
  /** Altro, in parole dell'utente. */
  note?: string;
}

/** Accetta solo aiuti noti e una nota corta: i dati arrivano dal browser o dal database. */
export function cleanReader(value: unknown): ReaderProfile {
  const v = (value ?? {}) as { aids?: unknown; note?: unknown };
  const aids = Array.isArray(v.aids) ? AIDS.filter((a) => (v.aids as unknown[]).includes(a)) : [];
  const note = typeof v.note === "string" ? v.note.trim().slice(0, READER_NOTE_MAX) : "";
  return note ? { aids, note } : { aids };
}

/** Preferenze salvate dal ponte in SQLite: impostazioni del gioco (formato del gioco) e questionario. */
export interface StoredPrefs {
  settings?: Record<string, unknown>;
  reader?: ReaderProfile;
}

export interface Tour {
  version: 1;
  id: string;
  title: string;
  description?: string;
  /** Livelli per cui il copione contiene testo (istantanea = tutti). */
  generation?: GenerationMode;
  steps: TourStep[];
}

export interface TourSummary {
  id: string;
  title: string;
  description?: string;
  steps: number;
}

export interface GameContext {
  level: Level;
  file?: string;
  lines?: [number, number];
  tourId?: string;
  stepId?: string;
  /** true mentre l'utente legge una risposta dal vivo (show_dialog) invece del passo del tour. */
  live?: boolean;
  /** Nome della guida scelto dall'utente nel gioco. */
  guide?: string;
  /** Lingua dell'interfaccia scelta dall'utente ("en" o "it"): scrivi tour e risposte in questa lingua. */
  lang?: string;
  /** Testo che l'utente ha selezionato (nel codice o nel fumetto) e su cui fa la domanda; file e lines sono i suoi. */
  selection?: string;
}

/** Lunghezza massima del testo selezionato che accompagna una domanda. */
export const SELECTION_MAX = 2000;

export interface UserQuestion {
  id: string;
  text: string;
  askedAt: string;
  context: GameContext;
  /** Conversazione a cui appartiene la domanda (id in .tour/conversazioni/). */
  conversation?: string;
  /** Domande e risposte precedenti della stessa conversazione: la domanda è un seguito di queste. */
  previous?: { question: string; answers: string[] }[];
}

// ---------- Conversazioni (cronologia delle domande) ----------

export interface ConversationAnswer {
  text: string;
  expression?: Expression;
  at: string;
}

/** Una domanda e ciò che l'agente ha mostrato per rispondere. */
export interface ConversationTurn {
  question: { id: string; text: string; askedAt: string; context: GameContext };
  answers: ConversationAnswer[];
  /** Ultimo codice mostrato nella risposta. */
  code?: { file: string; lines?: [number, number] };
  /** Ultimo schema mostrato nella risposta. */
  diagram?: StepDiagram;
}

/** Conversazione salvata in .tour/conversazioni/<id>.json: l'id è quello della prima domanda. */
export interface Conversation {
  version: 1;
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
}

// ---------- Protocollo WebSocket tra ponte e gioco ----------

/** GET /session: chi c'è su una porta del ponte. Serve al gioco per scegliere tra più sessioni aperte. */
export interface SessionInfo {
  project: string;
  agent: boolean;
  port: number;
}

/** Dal ponte (server) al gioco. */
export type ServerMessage =
  | { type: "hello"; project: string; files: string[]; agent: boolean; prefs: StoredPrefs }
  /** Preferenze cambiate da un'altra finestra del gioco. */
  | { type: "prefs"; prefs: StoredPrefs }
  | { type: "open_file"; path: string; content: string }
  | { type: "highlight"; path: string; content: string; start: number; end: number }
  | { type: "dialog"; text: string; expression?: Expression; speaker?: string }
  | { type: "play_tour"; tour: Tour; fromStep?: string }
  | { type: "diagram"; diagram: Diagram; upto?: number }
  /** Una conversazione è stata salvata (nuova domanda o risposta). */
  | { type: "conversation"; summary: ConversationSummary }
  | { type: "response"; reqId: string; ok: true; data: unknown }
  | { type: "response"; reqId: string; ok: false; error: string };

/** Dal gioco al ponte. */
export type ClientMessage =
  | { type: "request"; reqId: string; op: "read_file"; path: string }
  | { type: "request"; reqId: string; op: "list_tours" }
  | { type: "request"; reqId: string; op: "load_tour"; id: string }
  | { type: "request"; reqId: string; op: "list_diagrams" }
  | { type: "request"; reqId: string; op: "load_diagram"; id: string }
  | { type: "request"; reqId: string; op: "list_conversations" }
  | { type: "request"; reqId: string; op: "load_conversation"; id: string }
  /** conversation: id della conversazione che la domanda continua; assente per una nuova. */
  | { type: "question"; text: string; context: GameContext; conversation?: string }
  | { type: "state"; context: GameContext }
  | { type: "save_prefs"; prefs: StoredPrefs };
