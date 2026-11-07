// Modalità chat: lo storico dei fumetti al posto del codice, con il codice in schede da aprire.
// Lo storico si riempie anche fuori dalla modalità chat e resta nel browser (localStorage, per progetto).

import type { Expression } from "../shared/types";
import { highlightLines, langOf } from "./highlight";
import { t } from "./i18n";
import { drawStill, guideLook } from "./portrait";

export interface ChatCode {
  file: string;
  lines?: [number, number];
}

export interface ChatEntry {
  who: "guide" | "user";
  text?: string;
  /** Nome di chi parla: la guida o il personaggio scelto dall'agente. */
  speaker?: string;
  title?: string;
  expression?: Expression;
  /** Testo selezionato che accompagnava la domanda. */
  quote?: string;
  code?: ChatCode;
  diagram?: { id: string; title: string };
}

interface ChatHooks {
  readFile(path: string): Promise<string>;
  /** "Apri nel codice": esce dalla chat e mostra il file. */
  openCode(code: ChatCode): void;
  openDiagram(id: string): void;
}

/** Righe mostrate al massimo in una scheda di codice. */
const SNIPPET_MAX = 12;
/** Messaggi tenuti nello storico: i più vecchi escono. */
const LOG_MAX = 200;
const STORE_PREFIX = "code-dungeon:chat:";

export class ChatLog {
  private entries: ChatEntry[] = [];
  /** Chiave in localStorage; undefined finché non si sa il progetto. */
  private storeKey: string | undefined;

  constructor(
    private el: HTMLElement,
    private hooks: ChatHooks,
  ) {
    this.renderEmpty();
  }

  /** Riprende lo storico salvato per questo progetto; i messaggi arrivati prima restano in fondo. */
  restore(project: string): void {
    this.storeKey = STORE_PREFIX + project;
    let saved: ChatEntry[] = [];
    try {
      const raw = JSON.parse(localStorage.getItem(this.storeKey) ?? "[]");
      if (Array.isArray(raw)) saved = raw.filter(isEntry);
    } catch {
      // storico illeggibile o storage bloccato: si riparte vuoti
    }
    const fresh = this.entries;
    this.entries = [];
    this.el.innerHTML = "";
    for (const entry of saved) this.render(entry);
    this.entries = saved;
    if (saved.length > 0) this.renderSeparator();
    for (const entry of fresh) this.add(entry);
    if (this.entries.length === 0) this.renderEmpty();
    this.trim();
    this.save();
    this.scrollToEnd();
  }

  add(entry: ChatEntry): void {
    this.entries.push(entry);
    this.render(entry);
    this.trim();
    this.save();
    this.scrollToEnd();
  }

  private render(entry: ChatEntry): void {
    this.el.querySelector(".chat-empty")?.remove();
    const item = document.createElement("li");
    item.className = `chat-msg is-${entry.who}`;
    if (entry.who === "guide") {
      const face = document.createElement("canvas");
      face.className = "chat-face";
      face.setAttribute("aria-hidden", "true");
      drawStill(face, guideLook(), entry.expression);
      item.append(face);
    }
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    const head = document.createElement("p");
    head.className = "chat-who";
    head.textContent = [entry.who === "user" ? t().msg.you : entry.speaker, entry.title].filter(Boolean).join(" · ");
    bubble.append(head);
    if (entry.quote) {
      const q = document.createElement("p");
      q.className = "chat-quote";
      q.textContent = entry.quote;
      bubble.append(q);
    }
    if (entry.text) {
      const p = document.createElement("p");
      p.className = "chat-text";
      p.textContent = entry.text;
      bubble.append(p);
    }
    if (entry.code) bubble.append(this.codeCard(entry.code));
    if (entry.diagram) {
      const { id, title } = entry.diagram;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip-btn chat-diagram";
      btn.textContent = t().msg.showDiagram(title);
      btn.addEventListener("click", () => this.hooks.openDiagram(id));
      bubble.append(btn);
    }
    item.append(bubble);
    this.el.append(item);
  }

  /** Tiene gli ultimi LOG_MAX messaggi, nella pagina e nello storico salvato. */
  private trim(): void {
    if (this.entries.length > LOG_MAX) this.entries = this.entries.slice(-LOG_MAX);
    const msgs = this.el.querySelectorAll(".chat-msg");
    for (let i = 0; i < msgs.length - LOG_MAX; i++) msgs[i].remove();
    const first = this.el.firstElementChild;
    if (first?.classList.contains("chat-sep") && this.el.querySelector(".chat-msg")) first.remove();
  }

  private save(): void {
    if (!this.storeKey) return;
    try {
      if (this.entries.length === 0) localStorage.removeItem(this.storeKey);
      else localStorage.setItem(this.storeKey, JSON.stringify(this.entries));
    } catch {
      // storage pieno o bloccato: lo storico resta solo in questa pagina
    }
  }

  /** Svuota lo storico, anche quello salvato. */
  clear(): void {
    this.entries = [];
    this.el.innerHTML = "";
    this.renderEmpty();
    this.save();
  }

  scrollToEnd(): void {
    this.el.scrollTop = this.el.scrollHeight;
  }

  /** Scheda con file, righe e un estratto del codice; il codice arriva quando il file è letto. */
  codeCard(code: ChatCode): HTMLElement {
    const card = document.createElement("figure");
    card.className = "chat-code";
    const cap = document.createElement("figcaption");
    const name = document.createElement("span");
    name.className = "chat-code-name";
    name.textContent = code.lines ? `${code.file} · ${t().msg.lineRange(code.lines[0], code.lines[1])}` : code.file;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "chip-btn";
    open.textContent = t().ui.openInCode;
    open.addEventListener("click", () => this.hooks.openCode(code));
    cap.append(name, open);
    card.append(cap);
    if (code.lines) void this.fillSnippet(card, code.file, code.lines);
    return card;
  }

  private async fillSnippet(card: HTMLElement, file: string, [a, b]: [number, number]): Promise<void> {
    let text: string;
    try {
      text = await this.hooks.readFile(file);
    } catch {
      return;
    }
    const all = highlightLines(text, langOf(file));
    const end = Math.min(b, a + SNIPPET_MAX - 1, all.length);
    const pre = document.createElement("pre");
    pre.className = "chat-snippet";
    pre.innerHTML = all
      .slice(a - 1, end)
      .map((html, i) => `<span class="ln">${a + i}</span><code>${html || " "}</code>`)
      .join("\n");
    if (end < b) {
      const more = document.createElement("span");
      more.className = "chat-more";
      more.textContent = t().msg.moreLines(b - end);
      pre.append("\n", more);
    }
    card.append(pre);
    if (card.closest(".chat-log") === this.el) this.scrollToEnd();
  }

  /** Riga tra i messaggi salvati e quelli di questa visita, con il tasto per svuotare. */
  private renderSeparator(): void {
    const sep = document.createElement("li");
    sep.className = "chat-sep";
    const label = document.createElement("span");
    label.dataset.i18n = "ui.chatSaved";
    label.textContent = t().ui.chatSaved;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-btn";
    btn.id = "chat-clear";
    btn.dataset.i18n = "ui.chatClear";
    btn.textContent = t().ui.chatClear;
    btn.addEventListener("click", () => this.clear());
    sep.append(label, btn);
    this.el.append(sep);
  }

  private renderEmpty(): void {
    const empty = document.createElement("li");
    empty.className = "chat-empty";
    empty.dataset.i18n = "ui.chatEmpty";
    empty.textContent = t().ui.chatEmpty;
    this.el.append(empty);
  }
}

function isEntry(x: unknown): x is ChatEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Partial<ChatEntry>;
  const str = (v: unknown) => v === undefined || typeof v === "string";
  return (
    (e.who === "guide" || e.who === "user") &&
    str(e.text) &&
    str(e.speaker) &&
    str(e.title) &&
    str(e.quote) &&
    (e.code === undefined || typeof e.code?.file === "string") &&
    (e.diagram === undefined || (typeof e.diagram?.id === "string" && typeof e.diagram.title === "string"))
  );
}
