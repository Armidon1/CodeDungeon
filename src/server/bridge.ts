// Ponte tra il server MCP e il gioco: un server HTTP + WebSocket solo su 127.0.0.1.
// - serve il gioco compilato (dist/game) se esiste;
// - inoltra al gioco i comandi dell'agente;
// - raccoglie le domande dell'utente e lo stato del gioco per l'agente.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, GameContext, ServerMessage, UserQuestion } from "../shared/types.js";
import type { Project } from "./project.js";
import { log } from "./log.js";

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
    if (u.protocol === "tauri:") return true;
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
  private port: number;
  listening = false;

  constructor(private opts: BridgeOptions) {
    this.port = opts.port;
    this.http = createServer((req, res) => {
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

  /** Invia un messaggio a tutte le finestre del gioco. Ritorna quante lo hanno ricevuto. */
  send(msg: ServerMessage): number {
    this.remember(msg);
    const data = JSON.stringify(msg);
    for (const ws of this.clients) ws.send(data);
    return this.clients.size;
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
    const hello: ServerMessage = { type: "hello", project: this.opts.project.name, files, agent: this.opts.agent };
    ws.send(JSON.stringify(hello));
    for (const m of this.replay()) ws.send(JSON.stringify(m));
  }

  private async onMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    if (msg.type === "state") {
      this.lastContext = msg.context;
      return;
    }
    if (msg.type === "question") {
      const text = String(msg.text ?? "").slice(0, 2000).trim();
      if (!text) return;
      const q: UserQuestion = { id: randomUUID().slice(0, 8), text, askedAt: new Date().toISOString(), context: msg.context };
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
        else throw new Error("Operazione sconosciuta");
        reply({ type: "response", reqId: msg.reqId, ok: true, data });
      } catch (e) {
        reply({ type: "response", reqId: msg.reqId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
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
