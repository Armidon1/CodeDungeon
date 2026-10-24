// Modalità chat: lo storico dei fumetti al posto del codice, con il codice in schede da aprire.
// Lo storico vive solo nella pagina: si riempie anche fuori dalla modalità chat.

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

export class ChatLog {
  constructor(
    private el: HTMLElement,
    private hooks: ChatHooks,
  ) {
    this.renderEmpty();
  }

  add(entry: ChatEntry): void {
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
    while (this.el.children.length > LOG_MAX) this.el.firstElementChild!.remove();
    this.scrollToEnd();
  }

  clear(): void {
    this.el.innerHTML = "";
    this.renderEmpty();
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

  private renderEmpty(): void {
    const empty = document.createElement("li");
    empty.className = "chat-empty";
    empty.dataset.i18n = "ui.chatEmpty";
    empty.textContent = t().ui.chatEmpty;
    this.el.append(empty);
  }
}
