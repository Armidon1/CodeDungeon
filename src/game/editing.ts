// Editor modificabile della modalità tutor: una <textarea> trasparente sopra le righe evidenziate.
// Le righe (.line) restano quelle dell'editor in sola lettura e si ridisegnano mentre si scrive;
// la textarea ha stessa font e stesse misure e scorre con l'editor (è alta quanto il testo, niente scorrimento proprio).

import { t } from "./i18n";

export interface EditLayerOptions {
  /** Il testo è cambiato (a ogni battuta). */
  onInput: (text: string) => void;
}

export class EditLayer {
  readonly area: HTMLTextAreaElement;
  private indentUnit = "    ";

  constructor(private editor: HTMLElement, private opts: EditLayerOptions) {
    const ta = document.createElement("textarea");
    ta.className = "code-input";
    ta.id = "code-input";
    ta.spellcheck = false;
    ta.wrap = "off";
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("data-i18n-aria-label", "ui.codeInput");
    ta.setAttribute("aria-label", t().ui.codeInput);
    ta.addEventListener("input", () => {
      this.fit();
      this.opts.onInput(ta.value);
    });
    ta.addEventListener("keydown", (e) => this.onKey(e));
    // la textarea non scorre da sola: è l'editor a scorrere
    ta.addEventListener("scroll", () => {
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    });
    this.area = ta;
  }

  get attached(): boolean {
    return this.area.isConnected;
  }

  get value(): string {
    return this.area.value;
  }

  /** Mette la textarea sull'editor con questo testo. Se è già lì e il testo è lo stesso, non tocca il cursore. */
  attach(text: string): void {
    this.editor.classList.add("is-editable");
    this.area.setAttribute("aria-label", t().ui.codeInput);
    if (!this.attached) this.editor.append(this.area);
    if (this.area.value !== text) this.area.value = text;
    this.indentUnit = /^\t/m.test(text) ? "\t" : "    ";
    this.fit();
  }

  detach(): void {
    this.editor.classList.remove("is-editable");
    this.editor.style.removeProperty("line-height");
    this.area.remove();
  }

  /** Allinea la textarea alle righe: altezza di riga intera (così non si sfasa sui file lunghi), posizione e misure. */
  fit(): void {
    if (!this.attached) return;
    const ed = this.editor;
    ed.style.removeProperty("line-height");
    const first = ed.querySelector<HTMLElement>(".line");
    if (!first) return;
    const lh = Math.round(parseFloat(getComputedStyle(first).lineHeight) || first.offsetHeight);
    ed.style.lineHeight = `${lh}px`;
    const ta = this.area;
    const lines = ta.value.split("\n").length;
    ta.style.top = `${first.offsetTop}px`;
    ta.style.height = `${lines * lh}px`;
    ta.style.width = "0px";
    ta.style.width = `${Math.max(ed.scrollWidth, ed.clientWidth)}px`;
  }

  private insert(text: string): void {
    // execCommand tiene la cronologia di Ctrl+Z; setRangeText se il browser non lo supporta
    if (!document.execCommand("insertText", false, text)) {
      const ta = this.area;
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input"));
    }
  }

  private onKey(e: KeyboardEvent): void {
    const ta = this.area;
    if (e.key === "Escape") {
      // Esc lascia l'editor (i tasti del gioco tornano attivi), non apre il menu
      e.stopPropagation();
      ta.blur();
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.indent(e.shiftKey);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
      const lead = /^[ \t]*/.exec(ta.value.slice(start, ta.selectionStart))![0];
      this.insert(`\n${lead}`);
    }
  }

  /** Tab: indenta (o rientra con Maiusc). Con più righe selezionate agisce su tutte. */
  private indent(out: boolean): void {
    const ta = this.area;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const multi = value.slice(a, b).includes("\n");
    if (!out && !multi) {
      this.insert(this.indentUnit);
      return;
    }
    const start = value.lastIndexOf("\n", a - 1) + 1;
    const end = b > a && value[b - 1] === "\n" ? b - 1 : b;
    const block = value.slice(start, end);
    const unit = this.indentUnit;
    const changed = block
      .split("\n")
      .map((l) => (out ? l.replace(unit === "\t" ? /^\t/ : /^ {1,4}|^\t/, "") : unit + l))
      .join("\n");
    if (changed === block) return;
    ta.setSelectionRange(start, end);
    this.insert(changed);
    ta.setSelectionRange(start, start + changed.length);
  }
}
