// Da dove il gioco prende file, tour e comandi dell'agente.
// - BridgeSource: il ponte locale (server MCP o `npm run play`) via WebSocket.
// - DemoSource (demo-source.ts): il progetto d'esempio incorporato, senza agente.

import { t } from "./i18n";
import type { Conversation, ConversationSummary, Diagram, DiagramSummary, GameContext, ServerMessage, StoredPrefs, Tour, TourSummary } from "../shared/types";

export type AgentCommand = Extract<ServerMessage, { type: "open_file" | "highlight" | "dialog" | "play_tour" | "diagram" | "conversation" }>;

export type ConnectionState = "demo" | "connecting" | "connected" | "offline";

export interface GameSource {
  readonly kind: "bridge" | "demo";
  projectName: string;
  files: string[];
  /** true se dall'altra parte c'è un agente che può rispondere alle domande. */
  agent: boolean;
  /** Impostazioni salvate dal ponte (arrivano con hello); undefined nella demo. */
  prefs: StoredPrefs | undefined;
  readFile(path: string): Promise<string>;
  listTours(): Promise<TourSummary[]>;
  loadTour(id: string): Promise<Tour>;
  listDiagrams(): Promise<DiagramSummary[]>;
  loadDiagram(id: string): Promise<Diagram>;
  /** Conversazioni salvate in .tour/conversazioni/, dalla più recente. */
  listConversations(): Promise<ConversationSummary[]>;
  loadConversation(id: string): Promise<Conversation>;
  /** conversation: id della conversazione che la domanda continua. */
  ask(text: string, context: GameContext, conversation?: string): boolean;
  sendState(context: GameContext): void;
  savePrefs(prefs: StoredPrefs): void;
  /** Impostazioni cambiate da un'altra finestra del gioco. */
  onPrefs(cb: (prefs: StoredPrefs) => void): void;
  onCommand(cb: (cmd: AgentCommand) => void): void;
  onStatus(cb: (state: ConnectionState) => void): void;
  /** Risolve quando arrivano i primi dati (file del progetto). */
  ready(): Promise<void>;
}

// ---------- Ponte WebSocket ----------

export class BridgeSource implements GameSource {
  readonly kind = "bridge" as const;
  projectName = "";
  files: string[] = [];
  agent = false;
  prefs: StoredPrefs | undefined;
  private ws: WebSocket | undefined;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private commandCbs: ((cmd: AgentCommand) => void)[] = [];
  private statusCbs: ((s: ConnectionState) => void)[] = [];
  private prefsCbs: ((p: StoredPrefs) => void)[] = [];
  private readyResolve!: () => void;
  private readyPromise = new Promise<void>((r) => (this.readyResolve = r));
  private retry = 0;
  private seq = 0;

  constructor(private url: string) {
    this.connect();
  }

  private setStatus(s: ConnectionState): void {
    for (const cb of this.statusCbs) cb(s);
  }

  private connect(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "hello") {
        this.projectName = msg.project;
        this.files = msg.files;
        this.agent = msg.agent;
        this.prefs = msg.prefs;
        this.setStatus("connected");
        this.readyResolve();
      } else if (msg.type === "response") {
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        this.pending.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error));
      } else if (msg.type === "prefs") {
        this.prefs = msg.prefs;
        for (const cb of this.prefsCbs) cb(msg.prefs);
      } else {
        for (const cb of this.commandCbs) cb(msg);
      }
    };
    ws.onclose = () => {
      this.setStatus("offline");
      for (const p of this.pending.values()) p.reject(new Error(t().msg.bridgeClosed));
      this.pending.clear();
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private request<T>(body: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(t().msg.bridgeNotConnected));
        return;
      }
      const reqId = `r${++this.seq}`;
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ type: "request", reqId, ...body }));
    });
  }

  readFile(path: string): Promise<string> {
    return this.request<string>({ op: "read_file", path });
  }
  listTours(): Promise<TourSummary[]> {
    return this.request<TourSummary[]>({ op: "list_tours" });
  }
  loadTour(id: string): Promise<Tour> {
    return this.request<Tour>({ op: "load_tour", id });
  }
  listDiagrams(): Promise<DiagramSummary[]> {
    return this.request<DiagramSummary[]>({ op: "list_diagrams" });
  }
  loadDiagram(id: string): Promise<Diagram> {
    return this.request<Diagram>({ op: "load_diagram", id });
  }
  listConversations(): Promise<ConversationSummary[]> {
    return this.request<ConversationSummary[]>({ op: "list_conversations" });
  }
  loadConversation(id: string): Promise<Conversation> {
    return this.request<Conversation>({ op: "load_conversation", id });
  }
  ask(text: string, context: GameContext, conversation?: string): boolean {
    if (!this.agent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "question", text, context, conversation }));
    return true;
  }
  sendState(context: GameContext): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "state", context }));
  }
  savePrefs(prefs: StoredPrefs): void {
    this.prefs = prefs;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "save_prefs", prefs }));
  }
  onPrefs(cb: (prefs: StoredPrefs) => void): void {
    this.prefsCbs.push(cb);
  }
  onCommand(cb: (cmd: AgentCommand) => void): void {
    this.commandCbs.push(cb);
  }
  onStatus(cb: (s: ConnectionState) => void): void {
    this.statusCbs.push(cb);
  }
  ready(): Promise<void> {
    return this.readyPromise;
  }
}
