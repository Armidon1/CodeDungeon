// Da dove il gioco prende file, tour e comandi dell'agente.
// - BridgeSource: il ponte locale (server MCP o `npm run play`) via WebSocket.
// - DemoSource (demo-source.ts): il progetto d'esempio incorporato, senza agente.

import type { Diagram, DiagramSummary, GameContext, ServerMessage, Tour, TourSummary } from "../shared/types";

export type AgentCommand = Extract<ServerMessage, { type: "open_file" | "highlight" | "dialog" | "play_tour" | "diagram" }>;

export type ConnectionState = "demo" | "connecting" | "connected" | "offline";

export interface GameSource {
  readonly kind: "bridge" | "demo";
  projectName: string;
  files: string[];
  /** true se dall'altra parte c'è un agente che può rispondere alle domande. */
  agent: boolean;
  readFile(path: string): Promise<string>;
  listTours(): Promise<TourSummary[]>;
  loadTour(id: string): Promise<Tour>;
  listDiagrams(): Promise<DiagramSummary[]>;
  loadDiagram(id: string): Promise<Diagram>;
  ask(text: string, context: GameContext): boolean;
  sendState(context: GameContext): void;
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
  private ws: WebSocket | undefined;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private commandCbs: ((cmd: AgentCommand) => void)[] = [];
  private statusCbs: ((s: ConnectionState) => void)[] = [];
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
        this.setStatus("connected");
        this.readyResolve();
      } else if (msg.type === "response") {
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        this.pending.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error));
      } else {
        for (const cb of this.commandCbs) cb(msg);
      }
    };
    ws.onclose = () => {
      this.setStatus("offline");
      for (const p of this.pending.values()) p.reject(new Error("Connessione al ponte chiusa."));
      this.pending.clear();
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private request<T>(body: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Il ponte non è collegato."));
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
  ask(text: string, context: GameContext): boolean {
    if (!this.agent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "question", text, context }));
    return true;
  }
  sendState(context: GameContext): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "state", context }));
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
