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

const fontSize = () => Math.round(16 * (Number(css("--fs")) || 1));

export class TerminalPanel {
  private terms: Term[] = [];
  private active: Term | undefined;
  private seq = 0;
  private panel = document.getElementById("term-panel")!;
  private split = document.getElementById("split-term")!;
  private tabs = document.getElementById("term-tabs")!;
  private body = document.getElementById("term-body")!;
  private observer = new ResizeObserver(() => this.fitActive());

  constructor(private hooks: TerminalHooks) {
    document.getElementById("term-new")!.addEventListener("click", () => void this.create());
    document.getElementById("term-hide")!.addEventListener("click", () => this.show(false));
    this.observer.observe(this.body);
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Il ponte offre i terminali (non nella demo, non con --terminal off). */
  get available(): boolean {
    return this.hooks.url(80, 24) !== undefined;
  }

  /** Apre o chiude il pannello; aprendolo senza terminali se ne avvia uno. */
  show(open: boolean): void {
    if (open && !this.available) return;
    this.panel.hidden = !open;
    this.split.hidden = !open;
    document.querySelector(".main")?.classList.toggle("has-term", open);
    this.hooks.changed();
    if (!open) return;
    if (!this.terms.length) void this.create();
    else {
      this.fitActive();
      this.active?.term.focus();
    }
  }

  toggle(): void {
    this.show(!this.isOpen);
  }

  /** Colori e dimensione del testo cambiati (aiuti alla lettura, A− / A+). */
  refresh(): void {
    for (const x of this.terms) {
      x.term.options.theme = theme();
      x.term.options.fontFamily = css("--font-code");
      x.term.options.fontSize = fontSize();
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
      fontSize: fontSize(),
      theme: theme(),
      cursorBlink: !reducedMotion(),
      scrollback: 5000,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(view);
    const x: Term = { id, name: `${t().ui.terminal} ${id}`, view, term, fit, ws: undefined, exited: false, pipe: false, line: "" };
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
    x.term.focus();
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
