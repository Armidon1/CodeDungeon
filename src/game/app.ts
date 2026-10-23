// Il gioco: editor pixelato, esplora file con la guida che cammina, fumetti e riproduzione dei tour.

import { LEVELS, type Expression, type GameContext, type Level, type StepLink, type Tour, type TourStep } from "../shared/types";
import { highlightLines, langLabel, langOf } from "./highlight";
import { Portrait, drawMiniLumen } from "./portrait";
import { GENERATION_INFO, LEVEL_INFO, loadSettings, saveSettings, type Settings } from "./settings";
import type { AgentCommand, ConnectionState, GameSource } from "./source";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GUIDE = "Lumen";

interface DialogLine {
  text: string;
  expression: Expression;
  speaker?: string;
  choices?: StepLink[];
  /** Scelte con un'azione propria (es. "Ricomincia il tour"). */
  actions?: Choice[];
  note?: string;
}

interface Choice {
  label: string;
  run: () => void;
}

export class App {
  private settings: Settings = loadSettings();
  private portrait = new Portrait($<HTMLCanvasElement>("portrait"));
  private titlePortrait = new Portrait($<HTMLCanvasElement>("title-portrait"));

  private currentFile: string | undefined;
  private currentLines: string[] = [];
  private highlight: [number, number] | undefined;
  private fileCache = new Map<string, string>();
  private navigating = Promise.resolve();

  private tour: Tour | undefined;
  private stepIndex = -1;
  private history: number[] = [];

  private typing: { full: string; timer: number } | undefined;
  private awaitingChoice = false;
  private afterLine: (() => void) | undefined;
  /** Sul fumetto c'è una risposta dal vivo dell'agente, non il testo di un passo. */
  private liveAnswer = false;
  private connection: ConnectionState = "connecting";
  private loaded = false;

  constructor(private source: GameSource) {
    this.buildTitleScreen();
    this.buildLevelSwitch();
    this.bindControls();
    source.onStatus((s) => {
      this.connection = s;
      this.renderStatus();
      this.renderTitleSource();
      // il ponte è ripartito (es. nuova sessione dell'agente): file e tour possono essere cambiati
      if (s === "connected" && this.loaded) void this.onReady();
    });
    source.onCommand((cmd) => void this.onAgentCommand(cmd));
    this.titlePortrait.set({ expression: "felice" });
    this.renderStatus();
    this.renderTitleSource();
    void source.ready().then(() => this.onReady());
  }

  // ---------- Avvio ----------

  private async onReady(): Promise<void> {
    this.loaded = true;
    $("project-name").textContent = this.source.projectName;
    this.renderFileList();
    await this.renderTourList();
    this.renderTitleSource();
  }

  private openTitle(): void {
    $("title-screen").hidden = false;
    $("app").inert = true;
    this.syncTitleOptions();
    ($("title-screen").querySelector<HTMLInputElement>("input:checked") ?? $("start-btn")).focus();
  }

  private closeTitle(): void {
    $("title-screen").hidden = true;
    $("app").inert = false;
  }

  private async start(): Promise<void> {
    this.closeTitle();
    if (this.tour) {
      this.showStep(this.stepIndex >= 0 ? this.stepIndex : 0, false);
      return;
    }
    const tours = await this.source.listTours().catch(() => []);
    if (tours.length > 0) {
      await this.playTour(tours[0].id);
    } else if (this.source.agent) {
      this.say({
        text: "Ciao, sono Lumen! Questo progetto non ha ancora un tour. Chiedi al tuo agente di crearne uno con gli strumenti di Code Dungeon, oppure scrivimi qui sotto una domanda.",
        expression: "felice",
      });
    } else {
      this.say({
        text: "Ciao, sono Lumen! Non trovo tour salvati in questo progetto. Avvia Code Dungeon dal tuo agente (vedi il README) per crearne uno.",
        expression: "pensieroso",
      });
    }
  }

  // ---------- Schermata iniziale ----------

  private buildTitleScreen(): void {
    const levels = $("level-options");
    for (const lv of LEVELS) {
      const id = `opt-level-${lv}`;
      levels.insertAdjacentHTML(
        "beforeend",
        `<label class="option" for="${id}">
          <input type="radio" name="level" id="${id}" value="${lv}">
          <span class="option-name">${LEVEL_INFO[lv].label}</span>
          <span class="option-hint">${LEVEL_INFO[lv].hint}</span>
        </label>`,
      );
    }
    const gens = $("gen-options");
    for (const g of ["istantanea", "su_richiesta"] as const) {
      const id = `opt-gen-${g}`;
      gens.insertAdjacentHTML(
        "beforeend",
        `<label class="option" for="${id}">
          <input type="radio" name="generation" id="${id}" value="${g}">
          <span class="option-name">${GENERATION_INFO[g].label}</span>
          <span class="option-hint">${GENERATION_INFO[g].hint}</span>
        </label>`,
      );
    }
    $("title-screen").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name === "level") this.setLevel(input.value as Level);
      if (input.name === "generation") {
        this.settings.generation = input.value as Settings["generation"];
        saveSettings(this.settings);
        this.renderStatus();
      }
    });
    $("start-btn").addEventListener("click", () => void this.start());
    this.syncTitleOptions();
  }

  private syncTitleOptions(): void {
    const lv = document.getElementById(`opt-level-${this.settings.level}`) as HTMLInputElement | null;
    const gen = document.getElementById(`opt-gen-${this.settings.generation}`) as HTMLInputElement | null;
    if (lv) lv.checked = true;
    if (gen) gen.checked = true;
    $("start-btn").textContent = this.tour ? "Riprendi l'esplorazione ▶" : "Entra nel dungeon ▶";
  }

  private renderTitleSource(): void {
    const el = $("title-source");
    if (this.source.kind === "demo") {
      el.textContent = `Demo · progetto d'esempio «${this.source.projectName}», un server TCP in Python`;
    } else if (this.connection === "connected") {
      el.textContent = `Progetto «${this.source.projectName}»${this.source.agent ? " · agente collegato" : " · senza agente"}`;
    } else {
      el.textContent = "In attesa del ponte su 127.0.0.1:7337… avvia `npm run play` o il server MCP.";
    }
  }

  // ---------- Esplora file ----------

  private renderFileList(): void {
    const list = $("file-list");
    list.innerHTML = "";
    let lastDir = "";
    for (const file of this.source.files) {
      const parts = file.split("/");
      const dir = parts.slice(0, -1).join("/");
      if (dir && dir !== lastDir) {
        const li = document.createElement("li");
        li.className = "dir";
        li.style.setProperty("--depth", String(parts.length - 2));
        li.textContent = `▾ ${parts.at(-2)}`;
        list.append(li);
      }
      lastDir = dir;
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "file";
      btn.dataset.path = file;
      btn.style.setProperty("--depth", String(parts.length - 1));
      btn.innerHTML = `<span class="file-icon ext-${langOf(file)}" aria-hidden="true"></span><span class="file-name"></span>`;
      btn.querySelector(".file-name")!.textContent = parts.at(-1)!;
      btn.addEventListener("click", () => void this.goToFile(file));
      li.append(btn);
      list.append(li);
    }
    drawMiniLumen($<HTMLCanvasElement>("walker"), 0);
  }

  private async renderTourList(): Promise<void> {
    const list = $("tour-list");
    list.innerHTML = "";
    const tours = await this.source.listTours().catch(() => []);
    if (tours.length === 0) {
      list.innerHTML = `<li class="muted small">Nessun tour salvato in .tour/</li>`;
      return;
    }
    for (const t of tours) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tour-item";
      btn.innerHTML = `<span class="tour-title"></span><span class="tour-meta"></span>`;
      btn.querySelector(".tour-title")!.textContent = t.title;
      btn.querySelector(".tour-meta")!.textContent = t.steps === 1 ? "1 passo" : `${t.steps} passi`;
      btn.addEventListener("click", () => void this.playTour(t.id));
      li.append(btn);
      list.append(li);
    }
  }

  private markActiveFile(): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>("#file-list .file")) {
      const on = b.dataset.path === this.currentFile;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }

  /** Fa camminare la mini guida fino alla voce del file. */
  private async walkTo(path: string): Promise<void> {
    const target = document.querySelector<HTMLElement>(`#file-list .file[data-path="${CSS.escape(path)}"]`);
    const walker = $<HTMLCanvasElement>("walker");
    const explorer = $("explorer");
    if (!target) return;
    const horizontal = getComputedStyle(explorer).getPropertyValue("--strip").trim() === "1";
    const size = walker.clientHeight || 24;
    const x = horizontal ? target.offsetLeft + 5 : 6;
    const y = target.offsetTop + (target.offsetHeight - size) / 2;
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    walker.classList.add("is-visible");
    if (reducedMotion()) {
      walker.style.transform = `translate(${x}px, ${y}px)`;
      return;
    }
    let frame = 0;
    const tick = setInterval(() => drawMiniLumen(walker, ++frame), 90);
    walker.style.transform = `translate(${x}px, ${y}px)`;
    await sleep(460);
    clearInterval(tick);
    drawMiniLumen(walker, 0);
  }

  // ---------- Editor ----------

  private async readFile(path: string): Promise<string> {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) return cached;
    const text = await this.source.readFile(path);
    this.fileCache.set(path, text);
    return text;
  }

  /** Apre un file (con camminata e dissolvenza a pixel) ed evidenzia le righe. Le chiamate si mettono in coda. */
  goToFile(path: string, lines?: [number, number], content?: string): Promise<void> {
    this.navigating = this.navigating.then(() => this.doGoToFile(path, lines, content)).catch((e) => {
      this.say({ text: `Non riesco ad aprire ${path}: ${e instanceof Error ? e.message : String(e)}`, expression: "preoccupato" });
    });
    return this.navigating;
  }

  private async doGoToFile(path: string, lines?: [number, number], content?: string): Promise<void> {
    if (content !== undefined) this.fileCache.set(path, content);
    const text = await this.readFile(path);
    const changing = path !== this.currentFile;
    if (changing) {
      const walk = this.walkTo(path);
      if (this.currentFile !== undefined) await this.wipe("cover");
      this.currentFile = path;
      this.highlight = lines;
      this.renderEditor(text);
      this.markActiveFile();
      await Promise.all([walk, this.wipe("reveal")]);
    } else {
      this.highlight = lines;
      this.applyHighlight();
    }
    this.scrollToHighlight();
    this.reportState();
  }

  private renderEditor(text: string): void {
    const lang = langOf(this.currentFile ?? "");
    this.currentLines = highlightLines(text, lang);
    const editor = $("editor");
    const digits = String(this.currentLines.length).length;
    editor.style.setProperty("--gutter", `${digits + 3.6}ch`);
    editor.innerHTML = this.currentLines
      .map((html, i) => `<div class="line" data-n="${i + 1}"><span class="ln">${i + 1}</span><code>${html || " "}</code></div>`)
      .join("");
    $("editor-empty").hidden = true;
    $("tabs").innerHTML = `<span class="tab is-active"><span class="file-icon ext-${lang}" aria-hidden="true"></span><span class="tab-name"></span></span>`;
    $("tabs").querySelector(".tab-name")!.textContent = this.currentFile!.split("/").pop()!;
    $("status-lang").textContent = langLabel(lang);
    this.applyHighlight();
  }

  private applyHighlight(): void {
    const [a, b] = this.highlight ?? [0, -1];
    for (const el of $("editor").querySelectorAll<HTMLElement>(".line")) {
      const n = Number(el.dataset.n);
      const on = n >= a && n <= b;
      el.classList.toggle("hl", on);
      el.classList.toggle("hl-first", on && n === a);
      el.classList.toggle("hl-last", on && n === b);
    }
  }

  private scrollToHighlight(): void {
    const editor = $("editor");
    if (!this.highlight) {
      editor.scrollTop = 0;
      return;
    }
    const first = editor.querySelector<HTMLElement>(`.line[data-n="${this.highlight[0]}"]`);
    const last = editor.querySelector<HTMLElement>(`.line[data-n="${this.highlight[1]}"]`) ?? first;
    if (!first || !last) return;
    const mid = (first.offsetTop + last.offsetTop + last.offsetHeight) / 2;
    const top = Math.max(0, mid - editor.clientHeight / 2);
    const tall = last.offsetTop + last.offsetHeight - first.offsetTop > editor.clientHeight;
    editor.scrollTo({ top: tall ? first.offsetTop - 8 : top, behavior: reducedMotion() ? "auto" : "smooth" });
  }

  /** Dissolvenza a blocchi di pixel sopra l'editor. */
  private async wipe(mode: "cover" | "reveal"): Promise<void> {
    const canvas = $<HTMLCanvasElement>("wipe");
    const wrap = canvas.parentElement!;
    if (reducedMotion()) {
      canvas.hidden = mode === "reveal";
      return;
    }
    const size = 18;
    const w = Math.ceil(wrap.clientWidth / size);
    const h = Math.ceil(wrap.clientHeight / size);
    canvas.width = w;
    canvas.height = h;
    canvas.hidden = false;
    const ctx = canvas.getContext("2d")!;
    const color = getComputedStyle(document.documentElement).getPropertyValue("--code-bg").trim() || "#1c1930";
    const cells = Array.from({ length: w * h }, (_, i) => i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    ctx.fillStyle = color;
    if (mode === "reveal") ctx.fillRect(0, 0, w, h);
    else ctx.clearRect(0, 0, w, h);
    const frames = 9;
    const per = Math.ceil(cells.length / frames);
    for (let f = 0; f < frames; f++) {
      for (const c of cells.slice(f * per, (f + 1) * per)) {
        const x = c % w;
        const y = Math.floor(c / w);
        if (mode === "cover") ctx.fillRect(x, y, 1, 1);
        else ctx.clearRect(x, y, 1, 1);
      }
      await sleep(22);
    }
    if (mode === "reveal") canvas.hidden = true;
  }

  // ---------- Dialogo ----------

  private say(line: DialogLine): void {
    this.stopTyping();
    // un nuovo fumetto sostituisce la risposta dal vivo: niente "riprendi" in sospeso
    this.afterLine = undefined;
    this.liveAnswer = false;
    const textEl = $("dialog-text");
    $("speaker").textContent = line.speaker ?? GUIDE;
    this.portrait.set({ expression: line.expression, talking: true });
    $("dialog-live").textContent = line.text;
    const note = $("dialog-note");
    note.hidden = !line.note;
    note.textContent = line.note ?? "";
    this.renderChoices([]);
    this.awaitingChoice = false;
    $("dialog").classList.add("is-typing");

    const finish = () => {
      this.stopTyping();
      textEl.textContent = line.text;
      this.portrait.set({ talking: false });
      $("dialog").classList.remove("is-typing");
      const choices: Choice[] =
        line.actions ??
        (line.choices && line.choices.length > 1
          ? line.choices.map((c) => ({ label: c.when ?? c.goto, run: () => this.followLink(c) }))
          : []);
      if (choices.length) {
        this.awaitingChoice = true;
        this.renderChoices(choices);
      }
      this.updateNav();
      // il dialogo può essere cresciuto (scelte): ricentra le righe evidenziate
      requestAnimationFrame(() => this.scrollToHighlight());
    };

    if (reducedMotion()) {
      finish();
      return;
    }
    let i = 0;
    textEl.textContent = "";
    const timer = window.setInterval(() => {
      i = Math.min(line.text.length, i + 2);
      textEl.textContent = line.text.slice(0, i);
      if (i >= line.text.length) finish();
    }, 24);
    this.typing = { full: line.text, timer };
    this.typingFinish = finish;
    this.updateNav();
  }

  private typingFinish: (() => void) | undefined;

  private stopTyping(): void {
    if (this.typing) clearInterval(this.typing.timer);
    this.typing = undefined;
  }

  private renderChoices(choices: Choice[]): void {
    const box = $("choices");
    box.innerHTML = "";
    choices.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice";
      btn.textContent = `${i + 1}. ${c.label}`;
      btn.addEventListener("click", () => {
        this.awaitingChoice = false;
        this.renderChoices([]);
        c.run();
        this.updateNav();
      });
      box.append(btn);
    });
    box.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }

  // ---------- Tour ----------

  async playTour(id: string, fromStep?: string, tourData?: Tour): Promise<void> {
    try {
      this.tour = tourData ?? (await this.source.loadTour(id));
    } catch (e) {
      this.say({ text: `Non riesco a caricare il tour: ${e instanceof Error ? e.message : String(e)}`, expression: "preoccupato" });
      return;
    }
    this.history = [];
    const start = fromStep ? Math.max(0, this.tour.steps.findIndex((s) => s.id === fromStep)) : 0;
    this.closeTitle();
    this.showStep(start, false);
  }

  private textFor(step: TourStep): { text: string; note?: string; missing: boolean } {
    const want = this.settings.level;
    const direct = step.text[want];
    if (direct) return { text: direct, missing: false };
    // livello più vicino disponibile
    const idx = LEVELS.indexOf(want);
    const order = [...LEVELS].sort((a, b) => Math.abs(LEVELS.indexOf(a) - idx) - Math.abs(LEVELS.indexOf(b) - idx));
    const fallback = order.find((l) => step.text[l]);
    return {
      text: fallback ? step.text[fallback]! : "(Questo passo non ha ancora testo.)",
      note: `Questo passo non ha ancora la versione «${LEVEL_INFO[want].label}»: ti mostro «${fallback ? LEVEL_INFO[fallback].label : "?"}».`,
      missing: true,
    };
  }

  private showStep(index: number, pushHistory = true): void {
    if (!this.tour) return;
    const step = this.tour.steps[index];
    if (!step) return;
    if (pushHistory && this.stepIndex >= 0) this.history.push(this.stepIndex);
    this.stepIndex = index;
    const { text, note, missing } = this.textFor(step);
    let fullNote = note;
    if (missing && this.settings.generation === "su_richiesta" && this.source.agent) {
      const sent = this.source.ask(
        `[richiesta automatica] Scrivi il testo di livello «${this.settings.level}» per il passo «${step.id}» del tour «${this.tour.id}» con set_step_text, poi riavvialo da quel passo con play_tour.`,
        this.context(),
      );
      if (sent) fullNote = `${note} Ho chiesto all'agente di scriverla: fammi pensare...`;
    }
    $("step-title").textContent = step.title ?? "";
    void this.goToFile(step.file, step.lines);
    this.say({ text, expression: step.expression ?? "neutro", choices: step.next, note: fullNote });
    this.renderStatus();
    this.reportState();
  }

  private followLink(link: StepLink): void {
    if (!this.tour) return;
    const idx = this.tour.steps.findIndex((s) => s.id === link.goto);
    if (idx === -1) {
      this.say({ text: `Il passo «${link.goto}» non esiste in questo tour.`, expression: "preoccupato" });
      return;
    }
    this.awaitingChoice = false;
    this.renderChoices([]);
    this.showStep(idx);
  }

  next(): void {
    if (this.typing) {
      this.typingFinish?.();
      return;
    }
    if (this.awaitingChoice) return;
    if (this.afterLine) {
      const fn = this.afterLine;
      this.afterLine = undefined;
      fn();
      return;
    }
    if (!this.tour || this.stepIndex < 0) return;
    const step = this.tour.steps[this.stepIndex];
    if (step.next && step.next.length === 0) return this.endTour();
    if (step.next && step.next.length === 1) return this.followLink(step.next[0]);
    if (this.stepIndex + 1 < this.tour.steps.length) return this.showStep(this.stepIndex + 1);
    this.endTour();
  }

  prev(): void {
    if (this.typing) {
      this.typingFinish?.();
      return;
    }
    const prev = this.history.pop();
    if (prev !== undefined) this.showStep(prev, false);
  }

  private endTour(): void {
    const title = this.tour?.title ?? "il tour";
    this.stepIndex = -1;
    const t = this.tour;
    this.tour = undefined;
    this.history = [];
    $("step-title").textContent = "Fine";
    this.say({
      text: `Abbiamo finito «${title}»! Puoi rigiocarlo, cambiare livello per rileggerlo con occhi diversi, o farmi una domanda.`,
      expression: "felice",
      actions: t
        ? [
            { label: "Ricomincia il tour", run: () => void this.playTour(t.id, undefined, t) },
            { label: "Resto qui", run: () => {} },
          ]
        : undefined,
    });
    this.renderStatus();
    this.reportState();
  }

  // ---------- Livello ----------

  private buildLevelSwitch(): void {
    const box = $("level-switch");
    for (const lv of LEVELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lv";
      btn.dataset.level = lv;
      btn.setAttribute("role", "radio");
      btn.title = `${LEVEL_INFO[lv].label}: ${LEVEL_INFO[lv].hint}`;
      btn.textContent = LEVEL_INFO[lv].label;
      btn.addEventListener("click", () => this.setLevel(lv));
      box.append(btn);
    }
    this.syncLevelSwitch();
  }

  private syncLevelSwitch(): void {
    for (const b of $("level-switch").querySelectorAll<HTMLButtonElement>(".lv")) {
      const on = b.dataset.level === this.settings.level;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  setLevel(level: Level): void {
    if (level === this.settings.level) return;
    this.settings.level = level;
    saveSettings(this.settings);
    this.syncLevelSwitch();
    this.syncTitleOptions();
    this.renderStatus();
    // durante un tour, il passo corrente viene riletto al nuovo livello
    if (this.tour && this.stepIndex >= 0 && $("title-screen").hidden) this.showStep(this.stepIndex, false);
    this.reportState();
  }

  // ---------- Domande e agente ----------

  private ask(text: string): void {
    const q = text.trim();
    if (!q) return;
    if (this.source.ask(q, this.context())) {
      this.say({ text: "Ho passato la tua domanda all'agente. Fammi pensare...", expression: "pensieroso" });
      this.portrait.set({ talking: false });
    } else if (this.source.kind === "demo") {
      this.say({
        text: "In questa demo non c'è un agente collegato, quindi non posso rispondere a domande libere. Avvia Code Dungeon con Claude Code, Codex o Gemini CLI (istruzioni nel README) e risponderò dal vivo.",
        expression: "pensieroso",
      });
    } else if (this.connection === "connected") {
      this.say({
        text: "Sei in modalità riproduzione (npm run play), senza un agente che possa rispondere. Avvia Code Dungeon come server MCP dal tuo agente e la tua domanda arriverà a lui.",
        expression: "pensieroso",
      });
    } else {
      this.say({ text: "Il ponte non è collegato: non riesco a far arrivare la domanda all'agente.", expression: "preoccupato" });
    }
  }

  private async onAgentCommand(cmd: AgentCommand): Promise<void> {
    if (!$("title-screen").hidden) this.closeTitle();
    switch (cmd.type) {
      case "open_file":
        await this.goToFile(cmd.path, undefined, cmd.content);
        break;
      case "highlight":
        await this.goToFile(cmd.path, [cmd.start, cmd.end], cmd.content);
        break;
      case "dialog": {
        // una risposta dal vivo interrompe il tour; "Avanti" lo riprende dal passo corrente
        const resume = this.tour && this.stepIndex >= 0 ? this.stepIndex : undefined;
        this.say({ text: cmd.text, expression: cmd.expression ?? "neutro", speaker: cmd.speaker });
        if (resume !== undefined) this.afterLine = () => this.showStep(resume, false);
        this.liveAnswer = true;
        this.reportState();
        break;
      }
      case "play_tour":
        this.fileCache.clear();
        await this.playTour(cmd.tour.id, cmd.fromStep, cmd.tour);
        await this.renderTourList();
        break;
    }
  }

  private context(): GameContext {
    const step = this.tour && this.stepIndex >= 0 ? this.tour.steps[this.stepIndex] : undefined;
    return {
      level: this.settings.level,
      file: this.currentFile,
      lines: this.highlight,
      tourId: this.tour?.id,
      stepId: step?.id,
      live: this.liveAnswer,
    };
  }

  private reportState(): void {
    this.source.sendState(this.context());
  }

  // ---------- Barra di stato e controlli ----------

  private renderStatus(): void {
    const conn = $("status-conn");
    const labels: Record<ConnectionState, string> = {
      demo: "● Demo",
      connecting: "○ Collegamento…",
      connected: this.source.agent ? "● Agente collegato" : "● Ponte collegato",
      offline: "○ Ponte non raggiungibile",
    };
    conn.textContent = labels[this.connection];
    conn.dataset.state = this.connection;
    const step = this.tour && this.stepIndex >= 0 ? this.tour.steps[this.stepIndex] : undefined;
    $("status-step").textContent = step && this.tour ? `Passo ${this.stepIndex + 1}/${this.tour.steps.length}` : "";
    $("status-level").textContent = `Livello: ${LEVEL_INFO[this.settings.level].label}`;
    $("status-gen").textContent = GENERATION_INFO[this.settings.generation].label;
  }

  private updateNav(): void {
    ($("prev-btn") as HTMLButtonElement).disabled = this.history.length === 0;
    const canNext = !!this.typing || !!this.afterLine || (!this.awaitingChoice && !!this.tour && this.stepIndex >= 0);
    ($("next-btn") as HTMLButtonElement).disabled = !canNext;
    $("next-btn").textContent = this.typing ? "Salta ▶▶" : "Avanti ▶";
    $("advance").hidden = !canNext || !!this.typing;
  }

  private bindControls(): void {
    $("next-btn").addEventListener("click", () => this.next());
    $("prev-btn").addEventListener("click", () => this.prev());
    $("dialog-text").addEventListener("click", () => this.next());
    $("menu-btn").addEventListener("click", () => this.openTitle());
    $("ask-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>("ask-input");
      this.ask(input.value);
      input.value = "";
    });
    document.addEventListener("keydown", (e) => {
      const inField = (e.target as HTMLElement).closest("input, textarea");
      if (e.key === "Escape") {
        if ($("title-screen").hidden) this.openTitle();
        else if (this.source.files.length) void this.start();
        return;
      }
      if (inField || !$("title-screen").hidden) return;
      if ((e.target as HTMLElement).closest("button") && (e.key === "Enter" || e.key === " ")) return;
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        this.next();
      } else if (e.key === "ArrowLeft") {
        this.prev();
      } else if (/^[1-4]$/.test(e.key)) {
        if (this.awaitingChoice) {
          $("choices").querySelectorAll<HTMLButtonElement>("button")[Number(e.key) - 1]?.click();
        } else {
          this.setLevel(LEVELS[Number(e.key) - 1]);
        }
      }
    });
    window.addEventListener("resize", () => {
      if (this.currentFile) void this.walkTo(this.currentFile);
    });
    this.updateNav();
  }

  /** Apre la schermata iniziale. */
  boot(): void {
    this.openTitle();
  }
}
