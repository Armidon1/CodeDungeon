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
}

export interface UserQuestion {
  id: string;
  text: string;
  askedAt: string;
  context: GameContext;
}

// ---------- Protocollo WebSocket tra ponte e gioco ----------

/** Dal ponte (server) al gioco. */
export type ServerMessage =
  | { type: "hello"; project: string; files: string[]; agent: boolean }
  | { type: "open_file"; path: string; content: string }
  | { type: "highlight"; path: string; content: string; start: number; end: number }
  | { type: "dialog"; text: string; expression?: Expression; speaker?: string }
  | { type: "play_tour"; tour: Tour; fromStep?: string }
  | { type: "response"; reqId: string; ok: true; data: unknown }
  | { type: "response"; reqId: string; ok: false; error: string };

/** Dal gioco al ponte. */
export type ClientMessage =
  | { type: "request"; reqId: string; op: "read_file"; path: string }
  | { type: "request"; reqId: string; op: "list_tours" }
  | { type: "request"; reqId: string; op: "load_tour"; id: string }
  | { type: "question"; text: string; context: GameContext }
  | { type: "state"; context: GameContext };
