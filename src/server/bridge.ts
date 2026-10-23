// Ponte tra il server MCP e il gioco: un server HTTP + WebSocket solo su 127.0.0.1.
// - serve il gioco compilato (dist/game) se esiste;
// - inoltra al gioco i comandi dell'agente;
// - raccoglie le domande dell'utente e lo stato del gioco per l'agente.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, Conversation, ConversationTurn, GameContext, ReaderProfile, ServerMessage, SessionInfo, UserQuestion } from "../shared/types.js";
import { conversationSummary, type Project } from "./project.js";
import type { Store } from "./store.js";
import { log } from "./log.js";

/** Quante domande precedenti della conversazione arrivano all'agente insieme a un seguito. */
const PREVIOUS_TURNS = 6;

/** Quante porte provare a partire da quella preferita (più sessioni aperte insieme). */
const PORT_TRIES = 20;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Origini da cui accettiamo connessioni WebSocket: solo pagine locali (evita il cross-site WebSocket hijacking). */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // client non-browser (test, Tauri in alcuni casi)
  try {
    const u = new URL(origin);
    // app desktop: tauri://localhost (Linux, macOS), http://tauri.localhost (Windows)
    if (u.protocol === "tauri:" || u.hostname === "tauri.localhost") return true;
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export interface BridgeOptions {
  project: Project;
  /** Porta preferita: se è occupata si prova la successiva (vedi PORT_TRIES). */
  port: number;
  staticDir?: string;
  agent: boolean;
  /** Preferenze del giocatore (SQLite). */
  store: Store;
}

export class Bridge {
  private http: Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  /** Domande senza risposta. Restano qui finché l'agente risponde (show_dialog con question_id) o le legge con get_user_questions. */
  private questions: UserQuestion[] = [];
  /**
   * Domande già consegnate a wait_for_question o spinte nella sessione: non si riconsegnano all'ascolto,
   * ma get_user_questions le restituisce ancora (l'agente può aver chiuso il turno senza rispondere).
   */
  private delivered = new Set<string>();
  /** Agente in attesa con wait_for_question: riceve la prossima domanda appena arriva. */
  private waiter: ((q: UserQuestion[]) => void) | undefined;
  /** Chiamata per ogni domanda che nessun agente sta aspettando (es. per spingerla al client MCP). */
  onQuestion: ((q: UserQuestion) => void) | undefined;
  private lastContext: GameContext | undefined;
  /**
   * Scena corrente, rimandata a chi si collega dopo (gioco aperto in ritardo o ricaricato):
   * l'ultimo tour, l'ultimo file aperto o evidenziato, l'ultimo fumetto e l'ultimo schema, nell'ordine in cui sono arrivati.
   * Un nuovo tour azzera il resto.
   */
  private scene: ServerMessage[] = [];
  /** Conversazioni toccate in questa sessione, per id. Sul disco in .tour/conversazioni/. */
  private conversations = new Map<string, Conversation>();
  /** Id della domanda → id della sua conversazione. */
  private questionConversation = new Map<string, string>();
  /**
   * Domanda a cui si sta rispondendo: fumetti, codice e schemi inviati finché ne arriva un'altra
   * (o un tour) finiscono nella sua conversazione. Parte dall'ultima domanda arrivata;
   * show_dialog con question_id la sposta su quella indicata.
   */
  private answering: { conversation: Conversation; turn: ConversationTurn } | undefined;
  /** Scritture delle conversazioni, una dopo l'altra. */
  private saving = Promise.resolve();
  private port: number;
  listening = false;

  constructor(private opts: BridgeOptions) {
    this.port = opts.port;
    this.http = createServer((req, res) => {
      if ((req.url ?? "").split("?")[0] === "/session") {
        this.serveSession(req, res);
        return;
      }
      this.serveStatic(req).then(
        (r) => {
          res.writeHead(r.status, { "content-type": r.type, "x-content-type-options": "nosniff" });
          res.end(r.body);
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.http.on("upgrade", (req, socket, head) => {
      if (req.url !== "/ws" || !isAllowedOrigin(req.headers.origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  /** Indirizzo del gioco servito da questo ponte. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Ascolta sulla porta preferita o sulla prima libera dopo di lei. */
  async start(): Promise<void> {
    for (let port = this.opts.port; ; port++) {
      try {
        await this.listen(port);
        this.port = port;
        this.listening = true;
        return;
      } catch (e) {
        const busy = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
        if (!busy || port >= this.opts.port + PORT_TRIES - 1) throw e;
      }
    }
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      this.http.once("error", onError);
      this.http.listen(port, "127.0.0.1", () => {
        this.http.off("error", onError);
        resolve();
      });
    });
  }

  get connected(): number {
    return this.clients.size;
  }

  get context(): GameContext | undefined {
    return this.lastContext;
  }

  /** Le risposte al questionario sull'accessibilità. */
  get reader(): ReaderProfile {
    return this.opts.store.load().reader ?? { aids: [] };
  }

  /** Lingua dell'interfaccia scelta nel menu del gioco: i testi dell'agente vanno scritti in questa. */
  get lang(): "en" | "it" {
    return this.opts.store.load().settings?.lang === "it" ? "it" : "en";
  }

  /** Invia un messaggio a tutte le finestre del gioco. Ritorna quante lo hanno ricevuto. */
  send(msg: ServerMessage): number {
    this.remember(msg);
    this.record(msg);
    return this.broadcast(msg);
  }

  private broadcast(msg: ServerMessage): number {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) ws.send(data);
    return this.clients.size;
  }

  /** Aggiunge alla conversazione aperta ciò che l'agente mostra per rispondere. */
  private record(msg: ServerMessage): void {
    if (msg.type === "play_tour") this.answering = undefined;
    const a = this.answering;
    if (!a) return;
    if (msg.type === "dialog") a.turn.answers.push({ text: msg.text, expression: msg.expression, at: new Date().toISOString() });
    else if (msg.type === "highlight") a.turn.code = { file: msg.path, lines: [msg.start, msg.end] };
    else if (msg.type === "open_file") a.turn.code = { file: msg.path };
    else if (msg.type === "diagram") a.turn.diagram = msg.upto === undefined ? { id: msg.diagram.id } : { id: msg.diagram.id, upto: msg.upto };
    else return;
    this.saveConversation(a.conversation);
  }

  private saveConversation(c: Conversation): void {
    c.updatedAt = new Date().toISOString();
    const copy = structuredClone(c);
    this.saving = this.saving
      .then(() => this.opts.project.saveConversation(copy))
      .then(
        () => void this.broadcast({ type: "conversation", summary: conversationSummary(copy) }),
        (e: unknown) => log(`conversazione non salvata: ${String(e)}`),
      );
  }

  /** La conversazione con questo id: quella in memoria se è già stata toccata, altrimenti dal disco. */
  async conversation(id: string): Promise<Conversation> {
    const known = this.conversations.get(id);
    if (known) return known;
    const c = await this.opts.project.loadConversation(id);
    this.conversations.set(id, c);
    return c;
  }

  /** Aggiunge la domanda alla conversazione che continua (o a una nuova) e la segna come quella a cui si risponde. */
  private async addTurn(q: UserQuestion, continues: string | undefined): Promise<void> {
    let c: Conversation | undefined;
    if (continues) c = await this.conversation(continues).catch(() => undefined);
    if (c?.turns.length) {
      q.previous = c.turns.slice(-PREVIOUS_TURNS).map((t) => ({ question: t.question.text, answers: t.answers.map((a) => a.text) }));
    } else {
      const now = new Date().toISOString();
      c = { version: 1, id: q.id, title: q.text.slice(0, 80), startedAt: now, updatedAt: now, turns: [] };
      this.conversations.set(c.id, c);
    }
    const turn: ConversationTurn = { question: { id: q.id, text: q.text, askedAt: q.askedAt, context: q.context }, answers: [] };
    c.turns.push(turn);
    q.conversation = c.id;
    this.questionConversation.set(q.id, c.id);
    this.answering = { conversation: c, turn };
    this.saveConversation(c);
  }

  private remember(msg: ServerMessage): void {
    if (msg.type === "play_tour") {
      this.scene = [msg];
    } else if (msg.type === "open_file" || msg.type === "highlight") {
      this.scene = [...this.scene.filter((m) => m.type !== "open_file" && m.type !== "highlight"), msg];
    } else if (msg.type === "dialog" || msg.type === "diagram") {
      this.scene = [...this.scene.filter((m) => m.type !== msg.type), msg];
    }
  }

  /**
   * La scena da rimandare: il tour riparte dal passo in cui l'utente era arrivato.
   * Se era già tornato al tour, la risposta dal vivo (fumetto, codice e schema) non viene ripetuta.
   */
  private replay(): ServerMessage[] {
    const ctx = this.lastContext;
    const inTour = this.scene.some((m) => m.type === "play_tour");
    const scene = inTour && ctx && !ctx.live ? this.scene.filter((m) => m.type === "play_tour") : this.scene;
    return scene.map((m) =>
      m.type === "play_tour" && ctx?.tourId === m.tour.id && ctx.stepId && m.tour.steps.some((s) => s.id === ctx.stepId)
        ? { ...m, fromStep: ctx.stepId }
        : m,
    );
  }

  /** Domande in attesa; le consuma. */
  takeQuestions(): UserQuestion[] {
    const q = this.questions;
    this.questions = [];
    this.delivered.clear();
    return q;
  }

  /** Toglie dalla coda una domanda a cui l'agente ha risposto. */
  answer(id: string): boolean {
    const c = this.conversations.get(this.questionConversation.get(id) ?? "");
    const turn = c?.turns.find((t) => t.question.id === id);
    if (c && turn) this.answering = { conversation: c, turn };
    const before = this.questions.length;
    this.questions = this.questions.filter((q) => q.id !== id);
    this.delivered.delete(id);
    return this.questions.length < before;
  }

  /** Domande non ancora consegnate; da qui in poi contano come consegnate. */
  private deliver(): UserQuestion[] {
    const fresh = this.questions.filter((q) => !this.delivered.has(q.id));
    for (const q of fresh) this.delivered.add(q.id);
    return fresh;
  }

  /** Aspetta la prossima domanda (o quelle in coda non ancora consegnate) fino a `ms` millisecondi. */
  waitQuestions(ms: number, signal?: AbortSignal): Promise<UserQuestion[]> {
    const fresh = this.deliver();
    if (fresh.length) return Promise.resolve(fresh);
    // un solo agente in ascolto: una nuova attesa chiude la precedente
    this.waiter?.([]);
    return new Promise((resolve) => {
      const done = (q: UserQuestion[]) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        if (this.waiter === done) this.waiter = undefined;
        resolve(q);
      };
      const stop = () => done([]);
      const timer = setTimeout(stop, ms);
      signal?.addEventListener("abort", stop);
      this.waiter = done;
    });
  }

  private async onConnection(ws: WebSocket): Promise<void> {
    this.clients.add(ws);
    log(`gioco collegato (${this.clients.size} finestre)`);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      this.onMessage(ws, msg).catch((e) => log(`errore messaggio: ${String(e)}`));
    });
    const files = await this.opts.project.listFiles().catch(() => []);
    const hello: ServerMessage = { type: "hello", project: this.opts.project.name, files, agent: this.opts.agent, prefs: this.opts.store.load() };
    ws.send(JSON.stringify(hello));
    for (const m of this.replay()) ws.send(JSON.stringify(m));
  }

  private async onMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    if (msg.type === "save_prefs") {
      const prefs = this.opts.store.save(msg.prefs ?? {});
      // le altre finestre del gioco si allineano
      const data = JSON.stringify({ type: "prefs", prefs } satisfies ServerMessage);
      for (const other of this.clients) if (other !== ws) other.send(data);
      return;
    }
    if (msg.type === "state") {
      this.lastContext = msg.context;
      return;
    }
    if (msg.type === "question") {
      const text = String(msg.text ?? "").slice(0, 2000).trim();
      if (!text) return;
      const q: UserQuestion = { id: randomUUID().slice(0, 8), text, askedAt: new Date().toISOString(), context: msg.context };
      await this.addTurn(q, typeof msg.conversation === "string" ? msg.conversation : undefined);
      this.questions.push(q);
      this.lastContext = msg.context;
      log(`domanda dall'utente: ${text}`);
      if (this.waiter) this.waiter(this.deliver());
      else {
        this.delivered.add(q.id);
        this.onQuestion?.(q);
      }
      return;
    }
    if (msg.type === "request") {
      const reply = (r: ServerMessage) => ws.send(JSON.stringify(r));
      try {
        const p = this.opts.project;
        let data: unknown;
        if (msg.op === "read_file") data = await p.readFile(msg.path);
        else if (msg.op === "list_tours") data = await p.listTours();
        else if (msg.op === "load_tour") data = await p.loadTour(msg.id);
        else if (msg.op === "list_diagrams") data = await p.listDiagrams();
        else if (msg.op === "load_diagram") data = await p.loadDiagram(msg.id);
        else if (msg.op === "list_conversations") data = await p.listConversations();
        else if (msg.op === "load_conversation") data = await this.conversation(msg.id);
        else throw new Error("Operazione sconosciuta");
        reply({ type: "response", reqId: msg.reqId, ok: true, data });
      } catch (e) {
        reply({ type: "response", reqId: msg.reqId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** Nome del progetto e porta, letti dal gioco aperto altrove (altra porta, app desktop): CORS solo per origini locali. */
  private serveSession(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const info: SessionInfo = { project: this.opts.project.name, agent: this.opts.agent, port: this.port };
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
    });
    res.end(JSON.stringify(info));
  }

  private async serveStatic(req: IncomingMessage): Promise<{ status: number; type: string; body: string | Buffer }> {
    const dir = this.opts.staticDir;
    const notBuilt = {
      status: 200,
      type: "text/plain; charset=utf-8",
      body: "Code Dungeon: il gioco non è ancora compilato. Esegui `npm run build:game`, oppure `npm run dev` e apri http://localhost:5173",
    };
    if (!dir) return notBuilt;
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) return { status: 403, type: "text/plain", body: "" };
    try {
      const body = await fs.readFile(abs);
      return { status: 200, type: MIME[path.extname(abs)] ?? "application/octet-stream", body };
    } catch {
      if (rel === "index.html") return notBuilt;
      return { status: 404, type: "text/plain", body: "" };
    }
  }
}
