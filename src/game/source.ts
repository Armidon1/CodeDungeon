// Da dove il gioco prende file, tour e comandi dell'agente.
// - BridgeSource: il ponte locale (server MCP o `npm run play`) via WebSocket.
// - DemoSource (demo-source.ts): il progetto d'esempio incorporato, senza agente.

import { t } from "./i18n";
import { repathDirectory } from "../shared/project-path";
import type { Conversation, ConversationSummary, Diagram, DiagramSummary, EntryKind, GameContext, Gap, MovedDirectory, MovedFile, QuestionImage, ServerMessage, StoredPrefs, Tour, TourSummary, TrashEntry } from "../shared/types";

export type AgentCommand = Extract<ServerMessage, { type: "open_file" | "highlight" | "marks" | "gaps" | "dialog" | "play_tour" | "diagram" | "conversation" }>;

export type ConnectionState = "demo" | "connecting" | "connected" | "offline";

export interface GameSource {
  readonly kind: "bridge" | "demo";
  projectName: string;
  /** Porta del ponte collegato; undefined nella demo o prima di collegarsi. */
  port?: number;
  files: string[];
  dirs: string[];
  /** true se dall'altra parte c'è un agente che può rispondere alle domande. */
  agent: boolean;
  /** Impostazioni salvate dal ponte (arrivano con hello); undefined nella demo. */
  prefs: StoredPrefs | undefined;
  /** Indirizzo WebSocket per aprire un terminale; undefined nella demo o con i terminali spenti. */
  terminalUrl(cols: number, rows: number): string | undefined;
  readFile(path: string): Promise<string>;
  /** Modalità tutor: salva (o crea) un file del progetto; risolve con l'elenco aggiornato dei file. */
  writeFile(path: string, content: string): Promise<string[]>;
  /** Modalità tutor: sposta un file nella cartella toDir ("" = radice); risolve col percorso nuovo. */
  moveFile(path: string, toDir: string): Promise<string>;
  moveDirectory(path: string, toDir: string): Promise<MovedDirectory>;
  /** Modalità tutor: rinomina un file nella sua cartella e risolve col nuovo percorso. */
  renameFile(path: string, name: string): Promise<string>;
  renameDirectory(path: string, name: string): Promise<MovedDirectory>;
  trashFile(path: string): Promise<void>;
  listTrash(): Promise<TrashEntry[]>;
  restoreFile(id: string): Promise<string>;
  createEntry(dir: string, name: string, kind: EntryKind): Promise<string>;
  listTours(): Promise<TourSummary[]>;
  loadTour(id: string): Promise<Tour>;
  listDiagrams(): Promise<DiagramSummary[]>;
  loadDiagram(id: string): Promise<Diagram>;
  /** Conversazioni salvate in .tour/conversazioni/, dalla più recente. */
  listConversations(): Promise<ConversationSummary[]>;
  loadConversation(id: string): Promise<Conversation>;
  listGaps(): Promise<Gap[]>;
  resolveGap(id: string, resolved: boolean): Promise<Gap[]>;
  /** conversation: id della conversazione che la domanda continua. */
  ask(text: string, context: GameContext, conversation?: string): boolean;
  askWithAttachments(text: string, context: GameContext, conversation: string | undefined, images: QuestionImage[], attachment?: string): Promise<boolean>;
  sendState(context: GameContext): void;
  savePrefs(prefs: StoredPrefs): void;
  /** Impostazioni cambiate da un'altra finestra del gioco. */
  onPrefs(cb: (prefs: StoredPrefs) => void): void;
  /** I file del progetto sono cambiati fuori dal gioco. */
  onFiles(cb: (files: string[]) => void): void;
  onDirectoryMoved(cb: (moved: MovedDirectory) => void): void;
  onCommand(cb: (cmd: AgentCommand) => void): void;
  onStatus(cb: (state: ConnectionState) => void): void;
  /** Risolve quando arrivano i primi dati (file del progetto). */
  ready(): Promise<void>;
}

// ---------- Ponte WebSocket ----------

/** true nell'app desktop (Tauri), che non è servita dal ponte. */
export function isDesktopApp(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export class BridgeSource implements GameSource {
  readonly kind = "bridge" as const;
  projectName = "";
  port: number | undefined;
  files: string[] = [];
  dirs: string[] = [];
  agent = false;
  prefs: StoredPrefs | undefined;
  private terminal = false;
  private wsUrl: string | undefined;
  private ws: WebSocket | undefined;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private commandCbs: ((cmd: AgentCommand) => void)[] = [];
  private statusCbs: ((s: ConnectionState) => void)[] = [];
  private prefsCbs: ((p: StoredPrefs) => void)[] = [];
  private filesCbs: ((files: string[]) => void)[] = [];
  private directoryMovedCbs: ((moved: MovedDirectory) => void)[] = [];
  private readyResolve!: () => void;
  private readyPromise = new Promise<void>((r) => (this.readyResolve = r));
  private retry = 0;
  private seq = 0;

  /** url: indirizzo fisso, oppure funzione che lo cerca a ogni tentativo (undefined = niente ponte). */
  constructor(private url: string | (() => Promise<string | undefined>)) {
    void this.connect();
  }

  terminalUrl(cols: number, rows: number): string | undefined {
    if (!this.terminal || !this.wsUrl) return undefined;
    const u = new URL(this.wsUrl);
    u.pathname = "/term";
    u.search = `?cols=${cols}&rows=${rows}`;
    return u.href;
  }

  private setStatus(s: ConnectionState): void {
    for (const cb of this.statusCbs) cb(s);
  }

  private retryLater(): void {
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    this.setStatus("connecting");
    const url = typeof this.url === "string" ? this.url : await this.url();
    if (!url) {
      this.setStatus("offline");
      this.retryLater();
      return;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    this.wsUrl = url;
    this.port = Number(new URL(url).port) || undefined;
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
        this.dirs = msg.dirs ?? [];
        this.agent = msg.agent;
        this.prefs = msg.prefs;
        this.terminal = msg.terminal === true;
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
      } else if (msg.type === "files") {
        this.files = msg.files;
        this.dirs = msg.dirs ?? [];
        for (const cb of this.filesCbs) cb(msg.files);
      } else if (msg.type === "directory_moved") {
        this.applyDirectoryMove(msg);
        for (const cb of this.directoryMovedCbs) cb(msg);
      } else {
        for (const cb of this.commandCbs) cb(msg);
      }
    };
    ws.onclose = () => {
      this.setStatus("offline");
      for (const p of this.pending.values()) p.reject(new Error(t().msg.bridgeClosed));
      this.pending.clear();
      this.retryLater();
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
  async writeFile(path: string, content: string): Promise<string[]> {
    this.files = await this.request<string[]>({ op: "write_file", path, content });
    return this.files;
  }
  async moveFile(path: string, toDir: string): Promise<string> {
    const moved = await this.request<MovedFile>({ op: "move_file", path, to: toDir });
    this.files = moved.files;
    return moved.path;
  }
  async moveDirectory(path: string, toDir: string): Promise<MovedDirectory> {
    const moved = await this.request<MovedDirectory>({ op: "move_dir", path, to: toDir });
    this.applyDirectoryMove(moved);
    return moved;
  }
  async renameDirectory(path: string, name: string): Promise<MovedDirectory> {
    const moved = await this.request<MovedDirectory>({ op: "rename_dir", path, name });
    this.applyDirectoryMove(moved);
    return moved;
  }
  private applyDirectoryMove({ from, to }: MovedDirectory): void {
    const repath = (path: string) => repathDirectory(path, from, to);
    this.files = [...new Set(this.files.map(repath))];
    this.dirs = [...new Set(this.dirs.map(repath))];
  }
  async renameFile(path: string, name: string): Promise<string> {
    const to = await this.request<string>({ op: "rename_file", path, name });
    this.files = this.files.map((file) => file === path ? to : file);
    return to;
  }
  async trashFile(path: string): Promise<void> {
    await this.request<void>({ op: "trash_file", path });
    this.files = this.files.filter((file) => file !== path);
  }
  listTrash(): Promise<TrashEntry[]> {
    return this.request<TrashEntry[]>({ op: "list_trash" });
  }
  async restoreFile(id: string): Promise<string> {
    const path = await this.request<string>({ op: "restore_file", id });
    if (!this.files.includes(path)) this.files.push(path);
    return path;
  }
  async createEntry(dir: string, name: string, kind: EntryKind): Promise<string> {
    const path = await this.request<string>({ op: "create_entry", dir, name, kind });
    const list = kind === "dir" ? this.dirs : this.files;
    if (!list.includes(path)) list.push(path);
    return path;
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
  listGaps(): Promise<Gap[]> {
    return this.request<Gap[]>({ op: "list_gaps" });
  }
  resolveGap(id: string, resolved: boolean): Promise<Gap[]> {
    return this.request<Gap[]>({ op: "resolve_gap", id, resolved });
  }
  ask(text: string, context: GameContext, conversation?: string): boolean {
    if (!this.agent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "question", text, context, conversation }));
    return true;
  }
  async askWithAttachments(text: string, context: GameContext, conversation: string | undefined, images: QuestionImage[], attachment?: string): Promise<boolean> {
    if (!this.agent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (attachment) {
      await this.request<string>({ op: "ask_with_text", text, context, conversation, attachment, images: images.length ? images : undefined });
    } else {
      await this.request<string>({ op: "ask_with_images", text, context, conversation, images });
    }
    return true;
  }
  sendState(context: GameContext): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "state", context }));
  }
  savePrefs(prefs: StoredPrefs): void {
    this.prefs = prefs;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "save_prefs", prefs }));
  }
  onFiles(cb: (files: string[]) => void): void {
    this.filesCbs.push(cb);
  }
  onDirectoryMoved(cb: (moved: MovedDirectory) => void): void {
    this.directoryMovedCbs.push(cb);
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
