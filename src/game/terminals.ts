// Pannello dei terminali sotto l'editor, come in Visual Studio Code: più terminali, una scheda ciascuno.
// Ogni terminale è un WebSocket su /term del ponte, che avvia una shell nella cartella del progetto
// (src/server/terminal.ts). xterm.js si carica solo quando si apre il primo terminale.
// Colori dai token della palette di styles.css; con il movimento ridotto il cursore non lampeggia.

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TermClientMessage, TermServerMessage } from "../shared/types";
import { t } from "./i18n";
import { reducedMotion } from "./reader";

interface Term {
  id: number;
  name: string;
  view: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | undefined;
  exited: boolean;
  /** Shell senza terminale vero (ripiego del ponte): la riga si scrive qui e parte con Invio. */
  pipe: boolean;
  line: string;
}

export interface TerminalHooks {
  /** Indirizzo WebSocket per un terminale nuovo; undefined se il ponte non li offre. */
  url(cols: number, rows: number): string | undefined;
  /** Il pannello si è aperto o chiuso, o ha cambiato misura: le righe dell'editor si rimisurano. */
  changed(): void;
  canAttach(): boolean;
  attach(text: string, terminal: string): void;
}

type XtermLib = { Terminal: typeof Terminal; FitAddon: typeof FitAddon };
let lib: Promise<XtermLib> | undefined;
// nella demo (un file unico, senza ponte) xterm.js non entra: __DEMO__ è una costante e il ramo sparisce
const loadLib = () =>
  (lib ??= __DEMO__ ? Promise.reject(new Error("demo")) : Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]).then(([x, f]) => ({
    Terminal: x.Terminal,
    FitAddon: f.FitAddon,
  })));

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function theme() {
  return {
    background: css("--code-bg"),
    foreground: css("--ink"),
    cursor: css("--lantern"),
    cursorAccent: css("--code-bg"),
    selectionBackground: css("--line"),
    black: css("--night"),
    red: css("--ember"),
    green: css("--moss"),
    yellow: css("--lantern"),
    blue: css("--sky"),
    magenta: css("--plum"),
    cyan: css("--tk-call"),
    white: css("--ink-dim"),
    brightBlack: css("--ink-faint"),
    brightRed: css("--tk-const"),
    brightGreen: css("--moss"),
    brightYellow: css("--lantern"),
    brightBlue: css("--tk-call"),
    brightMagenta: css("--plum"),
    brightCyan: css("--sky"),
    brightWhite: css("--ink"),
  };
}

const ZOOM_KEY = "code-dungeon:terminal-zoom";
const ZOOM_MIN = 70;
const ZOOM_MAX = 200;

function loadZoom(): number {
  try {
    const percent = Number(localStorage.getItem(ZOOM_KEY));
    if (Number.isInteger(percent) && percent >= ZOOM_MIN && percent <= ZOOM_MAX) return percent;
  } catch { /* Lo zoom può restare in memoria. */ }
  return 100;
}

export class TerminalPanel {
  private terms: Term[] = [];
  private active: Term | undefined;
  private seq = 0;
  private zoom = loadZoom();
  private zoomOut = document.getElementById("term-zoom-out") as HTMLButtonElement;
  private zoomIn = document.getElementById("term-zoom-in") as HTMLButtonElement;
  private dock = document.getElementById("term-dock")!;
  private dockWasOpen = false;
  private opening: Promise<void> | undefined;
  private workspace = document.getElementById("terminal-workspace")!;
  private agent = document.getElementById("agent-workspace")!;
  private agentTab = document.getElementById("agent-tab")!;
  private terminalTab = document.getElementById("terminals-tab")!;
  private share = document.getElementById("term-share") as HTMLButtonElement;
  private panel = document.getElementById("term-panel")!;
  private split = document.getElementById("split-term")!;
  private tabs = document.getElementById("term-tabs")!;
  private body = document.getElementById("term-body")!;
  private observer = new ResizeObserver(() => this.fitActive());

  constructor(private hooks: TerminalHooks) {
    this.zoomOut.addEventListener("click", () => this.changeZoom(-10));
    this.zoomIn.addEventListener("click", () => this.changeZoom(10));
    document.getElementById("term-new")!.addEventListener("click", () => void this.create());
    document.getElementById("term-hide")!.addEventListener("click", () => this.show(false));
    this.agentTab.addEventListener("click", () => this.setWorkspace(false));
    this.terminalTab.addEventListener("click", () => this.setWorkspace(true));
    document.getElementById("workspace-tabs")!.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const open = e.key === "End" || (e.key !== "Home" && !this.inWorkspace);
      this.setWorkspace(open);
      (open ? this.terminalTab : this.agentTab).focus();
    });
    this.tabs.addEventListener("keydown", (e) => {
      if (!this.active || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const index = this.terms.indexOf(this.active);
      const step = e.key === "ArrowUp" ? -1 : 1;
      this.activate(this.terms[(index + step + this.terms.length) % this.terms.length]);
      this.tabs.querySelector<HTMLElement>(".is-active")?.focus();
    });
    this.share.addEventListener("mousedown", (e) => e.preventDefault());
    this.share.addEventListener("click", () => {
      if (!this.active) return;
      const text = this.outputOf(this.active.term);
      this.setWorkspace(false);
      this.hooks.attach(text, this.active.name);
    });
    this.refreshShare();
    this.observer.observe(this.body);
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Il ponte offre i terminali (non nella demo, non con --terminal off). */
  get available(): boolean {
    return this.hooks.url(80, 24) !== undefined;
  }

  get inWorkspace(): boolean {
    return !this.workspace.hidden;
  }

  setWorkspace(open: boolean): void {
    if (open === this.inWorkspace || (open && !this.available)) return;
    if (open) this.dockWasOpen = this.isOpen;
    this.agent.hidden = open;
    this.workspace.hidden = !open;
    this.agentTab.setAttribute("aria-selected", String(!open));
    this.terminalTab.setAttribute("aria-selected", String(open));
    this.agentTab.tabIndex = open ? -1 : 0;
    this.terminalTab.tabIndex = open ? 0 : -1;
    if (open) this.workspace.append(this.panel);
    else this.split.after(this.panel);
    this.show(open || (this.dockWasOpen && this.terms.length > 0));
    if (!open) this.agentTab.focus();
  }

  /** Legge il buffer visualizzato soltanto quando l’utente prepara un allegato. */
  private outputOf(term: Terminal): string {
    if (term.hasSelection()) return term.getSelection();
    const buffer = term.buffer.active;
    const pieces: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const wrapped = buffer.getLine(i + 1)?.isWrapped;
      pieces.push(buffer.getLine(i)!.translateToString(!wrapped));
      if (!wrapped) pieces.push("\n");
    }
    return pieces.join("").replace(/\n+$/, "");
  }

  refreshShare(): void {
    this.share.disabled = !this.active || !this.hooks.canAttach();
    this.share.textContent = this.active?.term.hasSelection() ? t().ui.attachTerminalSelection : t().ui.attachTerminalHistory;
  }

  /** Apre o chiude il pannello; aprendolo senza terminali se ne avvia uno. */
  show(open: boolean): void {
    if (!open && this.inWorkspace) {
      this.setWorkspace(false);
      return;
    }
    if (open && !this.available && !this.terms.length) return;
    this.panel.hidden = !open;
    this.dock.hidden = !open || this.inWorkspace;
    this.hooks.changed();
    if (!open) return;
    if (!this.terms.length) {
      this.opening ??= this.create().finally(() => { this.opening = undefined; });
    } else {
      this.fitActive();
      this.active?.term.focus();
    }
  }

  toggle(): void {
    this.show(!this.isOpen);
  }

  private get fontSize(): number {
    return Math.round(16 * (Number(css("--fs")) || 1) * this.zoom / 100);
  }

  private changeZoom(delta: number): void {
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom + delta));
    try { localStorage.setItem(ZOOM_KEY, String(this.zoom)); } catch { /* Solo per questa finestra. */ }
    this.refresh();
    this.active?.term.focus();
  }

  /** Colori e dimensione del testo cambiati (aiuti alla lettura, A− / A+). */
  refresh(): void {
    this.zoomOut.disabled = this.zoom <= ZOOM_MIN;
    this.zoomIn.disabled = this.zoom >= ZOOM_MAX;
    this.refreshShare();
    for (const x of this.terms) {
      x.term.options.theme = theme();
      x.term.options.fontFamily = css("--font-code");
      x.term.options.fontSize = this.fontSize;
      x.term.options.cursorBlink = !reducedMotion();
    }
    this.fitActive();
  }

  async create(): Promise<void> {
    const { Terminal, FitAddon } = await loadLib();
    const id = ++this.seq;
    const view = document.createElement("div");
    view.className = "term-view";
    view.dataset.term = String(id);
    this.body.append(view);
    const term = new Terminal({
      fontFamily: css("--font-code"),
      fontSize: this.fontSize,
      theme: theme(),
      cursorBlink: !reducedMotion(),
      scrollback: 5000,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(view);
    const x: Term = { id, name: `${t().ui.terminal} ${id}`, view, term, fit, ws: undefined, exited: false, pipe: false, line: "" };
    term.onSelectionChange(() => {
      if (this.active === x) this.refreshShare();
    });
    this.terms.push(x);
    this.activate(x);
    // Ctrl+` resta del gioco (apre e chiude il pannello), non va alla shell
    term.attachCustomKeyEventHandler((e) => !(e.ctrlKey && e.code === "Backquote"));
    const url = this.hooks.url(term.cols, term.rows);
    if (!url) {
      term.writeln(t().msg.termUnavailable);
      x.exited = true;
      this.renderTabs();
      return;
    }
    const ws = new WebSocket(url);
    x.ws = ws;
    const send = (m: TermClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      let m: TermServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as TermServerMessage;
      } catch {
        return;
      }
      if (m.t === "o") term.write(m.d);
      else if (m.t === "ready") {
        x.name = `${m.shell} ${id}`;
        x.pipe = m.pipe;
        send({ t: "r", cols: term.cols, rows: term.rows });
        if (m.pipe) term.writeln(`\x1b[2m${t().msg.termPipe}\x1b[0m`);
        this.renderTabs();
      } else if (m.t === "x") {
        if (m.error) term.writeln(`\r\n${m.error}`);
        this.ended(x);
      }
    };
    ws.onclose = () => this.ended(x);
    term.onData((d) => {
      if (x.exited) return;
      if (!x.pipe) return send({ t: "i", d });
      // senza terminale vero: eco e modifica della riga qui, la shell riceve la riga intera
      for (const ch of d) {
        if (ch === "\r") {
          term.write("\r\n");
          send({ t: "i", d: `${x.line}\r` });
          x.line = "";
        } else if (ch === "\x7f") {
          if (x.line) {
            x.line = x.line.slice(0, -1);
            term.write("\b \b");
          }
        } else if (ch === "\x03") {
          term.write("^C\r\n");
          x.line = "";
        } else if (ch >= " ") {
          x.line += ch;
          term.write(ch);
        }
      }
    });
    term.onResize(({ cols, rows }) => send({ t: "r", cols, rows }));
    this.renderTabs();
  }

  private ended(x: Term): void {
    if (x.exited) return;
    x.exited = true;
    x.term.writeln(`\r\n\x1b[2m${t().msg.termEnded}\x1b[0m`);
    this.renderTabs();
  }

  close(x: Term): void {
    x.exited = true;
    x.ws?.close();
    x.term.dispose();
    x.view.remove();
    const i = this.terms.indexOf(x);
    this.terms.splice(i, 1);
    if (this.active === x) {
      this.active = undefined;
      const next = this.terms[Math.min(i, this.terms.length - 1)];
      if (next) this.activate(next);
    }
    this.renderTabs();
    // chiuso l'ultimo terminale, il pannello si chiude come in VS Code
    if (!this.terms.length) this.show(false);
  }

  private activate(x: Term): void {
    this.active = x;
    for (const o of this.terms) o.view.hidden = o !== x;
    this.renderTabs();
    this.fitActive();
    if (this.isOpen && this.body.clientHeight) {
      if (this.tabs.scrollHeight > this.tabs.clientHeight) this.tabs.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
      x.term.focus();
    }
  }

  private fitActive(): void {
    const x = this.active;
    if (!x || this.panel.hidden || !this.body.clientHeight) return;
    try {
      x.fit.fit();
    } catch {
      // pannello non ancora misurato: ci riprova il prossimo ridimensionamento
    }
  }

  private renderTabs(): void {
    this.refreshShare();
    this.tabs.replaceChildren(
      ...this.terms.map((x) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "term-tab";
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(x === this.active));
        b.classList.toggle("is-active", x === this.active);
        b.classList.toggle("is-exited", x.exited);
        b.dataset.term = String(x.id);
        b.tabIndex = x === this.active ? 0 : -1;
        b.title = x.name;
        const name = document.createElement("span");
        name.textContent = x.name;
        const close = document.createElement("span");
        close.className = "tab-close";
        close.textContent = "×";
        close.title = t().ui.closeTerminal;
        close.setAttribute("aria-hidden", "true");
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close(x);
        });
        b.append(name, close);
        b.addEventListener("click", () => this.activate(x));
        b.addEventListener("auxclick", (e) => {
          if (e.button === 1) this.close(x);
        });
        return b;
      }),
    );
  }
}
