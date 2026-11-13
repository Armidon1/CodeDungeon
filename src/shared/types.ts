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

// ---------- Modalità: capire il flusso o scrivere con la guida ----------

/** flusso: l'agente guida con i tour, l'editor è in sola lettura. tutor: l'utente scrive, la guida aiuta solo se chiesto. */
export const MODES = ["flusso", "tutor"] as const;
export type Mode = (typeof MODES)[number];

export const cleanMode = (v: unknown): Mode => (v === "tutor" ? "tutor" : "flusso");

/** Preferenze salvate dal ponte in SQLite: impostazioni del gioco (formato del gioco), questionario e modalità. */
export interface StoredPrefs {
  settings?: Record<string, unknown>;
  reader?: ReaderProfile;
  /** Predefinita "flusso". */
  mode?: Mode;
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
  /** Modalità scelta nel gioco; assente = "flusso". */
  mode?: Mode;
  /** Solo in tutor, nelle domande: il contenuto attuale dell'editor, anche non salvato (al massimo BUFFER_MAX caratteri). */
  buffer?: TutorBuffer;
  /** Solo in tutor: righe del buffer cambiate dall'ultima domanda su questo file (o dal file su disco), intervalli inclusi da 1. */
  changed?: [number, number][];
  /** Solo in tutor: output del terminale incollato dall'utente ("Spiegami l'errore"), al massimo OUTPUT_MAX caratteri. */
  output?: string;
}

export interface TutorBuffer {
  file: string;
  content: string;
  /** true se nell'editor ci sono modifiche non salvate su disco. */
  dirty: boolean;
  /** true se content è stato tagliato a BUFFER_MAX. */
  truncated?: boolean;
}

/** Lunghezza massima del testo selezionato che accompagna una domanda. */
export const SELECTION_MAX = 2000;
/** Lunghezza massima del buffer dell'editor che accompagna una domanda in tutor. */
export const BUFFER_MAX = 20_000;
/** Lunghezza massima dell'output del terminale che accompagna una domanda in tutor. */
export const OUTPUT_MAX = 4000;
/** Numero massimo di intervalli di righe cambiate. */
export const CHANGED_MAX = 50;

/** Pulisce i campi del tutor arrivati dal gioco: tipi, limiti, niente campi estranei. */
export function cleanTutorContext(ctx: GameContext): GameContext {
  const out: GameContext = { ...ctx };
  const b = ctx.buffer as Partial<TutorBuffer> | undefined;
  delete out.buffer;
  delete out.changed;
  delete out.output;
  if (ctx.mode !== "tutor") return out;
  if (b && typeof b.file === "string" && typeof b.content === "string") {
    const truncated = b.truncated === true || b.content.length > BUFFER_MAX;
    out.buffer = { file: b.file.slice(0, 512), content: b.content.slice(0, BUFFER_MAX), dirty: b.dirty === true, ...(truncated ? { truncated } : {}) };
  }
  if (Array.isArray(ctx.changed)) {
    const ranges = ctx.changed
      .filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n >= 1) && r[0] <= r[1])
      .slice(0, CHANGED_MAX)
      .map(([a, z]) => [a, z] as [number, number]);
    if (ranges.length) out.changed = ranges;
  }
  if (typeof ctx.output === "string" && ctx.output.trim()) out.output = ctx.output.slice(0, OUTPUT_MAX);
  return out;
}

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

// ---------- Segni sulle righe (mark_lines) ----------

export const MARK_KINDS = ["error", "warning", "hint"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];
export const MARKS_MAX = 20;
export const MARK_MESSAGE_MAX = 300;

/** Un'ondina sotto le righe line..endLine (da 1) con un commento a margine. Non cambia il testo. */
export interface LineMark {
  line: number;
  endLine?: number;
  kind: MarkKind;
  message: string;
}

/** Una domanda e ciò che l'agente ha mostrato per rispondere. */
export interface ConversationTurn {
  question: { id: string; text: string; askedAt: string; context: GameContext };
  answers: ConversationAnswer[];
  /** Ultimo codice mostrato nella risposta. */
  code?: { file: string; lines?: [number, number] };
  /** Ultimo schema mostrato nella risposta. */
  diagram?: StepDiagram;
  /** Ultimi segni messi sulle righe nella risposta. */
  marks?: { file: string; marks: LineMark[] };
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
  /** Schemi disegnati nelle risposte (id, senza doppioni, in ordine). */
  diagrams: string[];
}

// ---------- Lacune (.tour/lacune.json): concetti su cui l'utente è inciampato ----------

export const GAP_CONCEPT_MAX = 120;
export const GAP_EXAMPLE_MAX = 400;
export const GAPS_MAX = 200;

export interface Gap {
  id: string;
  /** Il concetto, in breve: "range esclude l'estremo finale". */
  concept: string;
  /** Dove è successo l'ultima volta (riga, errore, frammento). */
  example: string;
  firstSeen: string;
  lastSeen: string;
  /** Quante volte l'agente l'ha annotato. */
  count: number;
  resolved: boolean;
}

export interface GapLog {
  version: 1;
  items: Gap[];
}

/** Chiave per riconoscere lo stesso concetto scritto in modo un po' diverso. */
export function gapKey(concept: string): string {
  return concept.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Da ripassare prima, poi le più frequenti e le più recenti. */
export function sortGaps(items: Gap[]): Gap[] {
  return [...items].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
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
  /** Segni sulle righe di un file (vuoto: li toglie). content: il file su disco a cui si riferiscono i numeri di riga. */
  | { type: "marks"; path: string; content: string; marks: LineMark[] }
  | { type: "dialog"; text: string; expression?: Expression; speaker?: string }
  | { type: "play_tour"; tour: Tour; fromStep?: string }
  | { type: "diagram"; diagram: Diagram; upto?: number }
  /** Il registro delle lacune è cambiato. */
  | { type: "gaps"; gaps: Gap[] }
  /** Una conversazione è stata salvata (nuova domanda o risposta). */
  | { type: "conversation"; summary: ConversationSummary }
  | { type: "response"; reqId: string; ok: true; data: unknown }
  | { type: "response"; reqId: string; ok: false; error: string };

/** Dal gioco al ponte. */
export type ClientMessage =
  | { type: "request"; reqId: string; op: "read_file"; path: string }
  /** Modalità tutor: salva il file dell'utente (crea anche un file nuovo). Risponde con l'elenco aggiornato dei file. */
  | { type: "request"; reqId: string; op: "write_file"; path: string; content: string }
  | { type: "request"; reqId: string; op: "list_tours" }
  | { type: "request"; reqId: string; op: "load_tour"; id: string }
  | { type: "request"; reqId: string; op: "list_diagrams" }
  | { type: "request"; reqId: string; op: "load_diagram"; id: string }
  | { type: "request"; reqId: string; op: "list_conversations" }
  | { type: "request"; reqId: string; op: "load_conversation"; id: string }
  | { type: "request"; reqId: string; op: "list_gaps" }
  /** Segna una lacuna come risolta (o la riapre). Risponde con l'elenco aggiornato. */
  | { type: "request"; reqId: string; op: "resolve_gap"; id: string; resolved: boolean }
  /** conversation: id della conversazione che la domanda continua; assente per una nuova. */
  | { type: "question"; text: string; context: GameContext; conversation?: string }
  | { type: "state"; context: GameContext }
  | { type: "save_prefs"; prefs: StoredPrefs };
