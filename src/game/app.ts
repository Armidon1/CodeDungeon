// Il gioco: editor pixelato, esplora file con la guida che cammina, fumetti e riproduzione dei tour.

import {
  AIDS,
  LEVELS,
  READER_NOTE_MAX,
  SELECTION_MAX,
  type ConversationTurn,
  type Diagram,
  type Expression,
  type GameContext,
  type Level,
  type StepLink,
  type StoredPrefs,
  type Tour,
  type TourStep,
} from "../shared/types";
import * as sound from "./audio";
import { TRACK_IDS, type SoundSettings } from "./audio";
import { Board } from "./diagram";
import { highlightLines, langLabel, langOf } from "./highlight";
import { GuidePicker } from "./guide";
import { DEFAULT_GUIDE_NAMES, LANGS, LANG_INFO, setLang, t, type Lang } from "./i18n";
import { Portrait, drawMiniGuide, setGuideLook } from "./portrait";
import { applyReader, pages, reducedMotion } from "./reader";
import { FRAMES, TEXT_SCALE_MAX, TEXT_SCALE_MIN, TEXT_SCALE_STEP, cleanTextScale, fromStored, isEmpty, loadSettings, saveSettings, toStored, type Frame, type Settings } from "./settings";
import { isDesktopApp, type AgentCommand, type ConnectionState, type GameSource } from "./source";
import { pickSession, switchSession } from "./sessions";
import { initLayout, type LayoutControls } from "./layout";
import { fullscreenAvailable, onFullscreenChange, toggleFullscreen } from "./fullscreen";

/** Testo selezionato nel codice o nel fumetto, allegato alla prossima domanda. */
interface Quote {
  text: string;
  file?: string;
  lines?: [number, number];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DialogLine {
  text: string;
  expression: Expression;
  speaker?: string;
  choices?: StepLink[];
  /** Scelte con un'azione propria (es. "Ricomincia il tour"). */
  actions?: Choice[];
  note?: string;
  /** Da fare quando il fumetto compare (es. riaprire il codice di una vecchia risposta). */
  before?: () => void;
}

interface Choice {
  label: string;
  run: () => void;
}

export class App {
  private settings: Settings = loadSettings();
  private portrait = new Portrait($<HTMLCanvasElement>("portrait"));
  private titlePortrait = new Portrait($<HTMLCanvasElement>("title-portrait"));
  private guidePicker = new GuidePicker({
    choice: () => this.settings.guide,
    onChange: (choice, look) => {
      this.settings.guide = choice;
      this.persist();
      setGuideLook(look);
      this.renderGuide();
    },
  });
  /** Il fumetto mostra il nome della guida (e non un `speaker` scelto dall'agente). */
  private speakerIsGuide = true;

  private currentFile: string | undefined;
  private currentLines: string[] = [];
  private highlight: [number, number] | undefined;
  private fileCache = new Map<string, string>();
  private navigating = Promise.resolve();

  private tour: Tour | undefined;
  private stepIndex = -1;
  private history: number[] = [];

  private typing: { full: string; timer: number } | undefined;
  /** Fumetto corrente diviso in pagine ("poco testo per volta"); di solito una sola. */
  private dialogLine: DialogLine | undefined;
  private pageList: string[] = [];
  private page = 0;
  private awaitingChoice = false;
  private afterLine: (() => void) | undefined;
  /** Sul fumetto c'è una risposta dal vivo dell'agente, non il testo di un passo. */
  private liveAnswer = false;
  /** Altri fumetti dell'agente arrivati mentre l'utente leggeva una risposta: si leggono con "Avanti". */
  private liveQueue: DialogLine[] = [];
  /** Conversazione delle risposte sul fumetto: una domanda fatta mentre le leggi la continua. */
  private conversation: string | undefined;
  /** Testo selezionato che accompagna la prossima domanda ("Chiedi su questo"). */
  private quote: Quote | undefined;
  /** Passo del tour da riprendere dopo le risposte dal vivo. */
  private resumeStep: number | undefined;
  /** Suggerimento se l'agente tarda a rispondere a una domanda. */
  private waitHint: number | undefined;
  private connection: ConnectionState = "connecting";
  private loaded = false;

  /** Lavagna: la finestra che si apre durante la spiegazione e la vista nella scheda dell'editor. */
  private popBoard = new Board({ onOpenCode: (file, lines) => this.openFromBoard(file, lines, true), follow: true });
  private tabBoard = new Board({ onOpenCode: (file, lines) => this.openFromBoard(file, lines, false) });
  /** Schemi aperti come schede, nell'ordine di apertura. */
  private boardTabs: Diagram[] = [];
  /** Cosa mostra l'editor: il codice o lo schema con questo id. */
  private view: string | undefined;
  /** Finestra della lavagna nascosta mentre una scheda mostra lo stesso schema: torna quando si lascia la scheda. */
  private popParked = false;
  private diagramCache = new Map<string, Diagram>();
  private layout: LayoutControls | undefined;

  constructor(private source: GameSource) {
    applyReader(this.settings.reader);
    this.applyTextScale();
    this.applyFrame();
    sound.configure(this.settings.sound);
    this.buildTitleScreen();
    this.buildSoundOptions();
    this.buildReaderOptions();
    this.buildLevelSwitch();
    this.bindControls();
    this.applyLang();
    // il browser lascia suonare solo dopo un gesto dell'utente
    const unlock = () => {
      sound.unlock();
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    source.onStatus((s) => {
      this.connection = s;
      this.renderStatus();
      this.renderTitleSource();
      // il ponte è ripartito (es. nuova sessione dell'agente): file e tour possono essere cambiati
      if (s === "connected" && this.loaded) void this.onReady();
    });
    source.onCommand((cmd) => void this.onAgentCommand(cmd));
    source.onPrefs((p) => this.applyStored(p));
    this.titlePortrait.set({ expression: "felice" });
    this.renderGuide();
    void this.guidePicker.init().then((look) => {
      setGuideLook(look);
      this.renderGuide();
    });
    this.renderStatus();
    this.renderTitleSource();
    void source.ready().then(() => this.onReady());
  }

  // ---------- Avvio ----------

  private async onReady(): Promise<void> {
    this.loaded = true;
    const stored = this.source.prefs;
    // il database vale per tutti i progetti; se è vuoto riceve quello che c'era in questo browser
    if (stored && !isEmpty(stored)) this.applyStored(stored);
    else if (stored) this.persist();
    $("project-name").textContent = this.source.projectName;
    this.renderFileList();
    await Promise.all([this.renderTourList(), this.renderDiagramList(), this.renderConversationList()]);
    this.renderTitleSource();
  }

  private openTitle(): void {
    sound.play("menu");
    $("title-screen").hidden = false;
    $("app").inert = true;
    this.syncTitleOptions();
    this.guidePicker.sync();
    ($("title-screen").querySelector<HTMLInputElement>("input:checked") ?? $("start-btn")).focus();
  }

  private closeTitle(): void {
    $("title-screen").hidden = true;
    $("app").inert = false;
  }

  private async start(): Promise<void> {
    sound.play("confirm");
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
        text: t().msg.helloAgent(this.settings.guide.name),
        expression: "felice",
      });
    } else {
      this.say({
        text: t().msg.helloNoAgent(this.settings.guide.name),
        expression: "pensieroso",
      });
    }
  }

  // ---------- Impostazioni ----------

  /** Salva in questo browser e, col ponte, nel database. */
  private persist(): void {
    saveSettings(this.settings);
    this.source.savePrefs(toStored(this.settings));
  }

  /** Impostazioni arrivate dal ponte (all'avvio o da un'altra finestra). */
  private applyStored(p: StoredPrefs): void {
    const before = this.settings;
    this.settings = fromStored(p);
    saveSettings(this.settings);
    if (before.lang !== this.settings.lang) this.applyLang();
    applyReader(this.settings.reader);
    this.applyTextScale();
    if (before.frame !== this.settings.frame) this.applyFrame();
    sound.configure(this.settings.sound);
    this.syncSoundOptions();
    setGuideLook(this.guidePicker.refresh());
    this.renderGuide();
    this.syncLevelSwitch();
    this.syncTitleOptions();
    this.syncReaderOptions();
    this.renderStatus();
    // durante un tour il passo si rilegge con il nuovo livello o con le pagine
    const changed = before.level !== this.settings.level || before.reader.aids.includes("poco_testo") !== this.settings.reader.aids.includes("poco_testo");
    if (changed && this.tour && this.stepIndex >= 0 && $("title-screen").hidden && !this.liveAnswer) this.showStep(this.stepIndex, false);
  }

  // ---------- Lingua ----------

  private setLanguage(lang: Lang): void {
    if (lang === this.settings.lang) return;
    this.settings.lang = lang;
    this.applyLang();
    this.persist();
    this.reportState();
  }

  /** Riscrive l'interfaccia nella lingua scelta. Fumetti già mostrati e testi dei tour restano come sono. */
  private applyLang(): void {
    setLang(this.settings.lang);
    // il nome predefinito di un'immagine propria segue la lingua; uno scelto dall'utente resta
    const guide = this.settings.guide;
    if (guide.id === "custom" && DEFAULT_GUIDE_NAMES.includes(guide.name)) guide.name = t().msg.defaultGuide;
    const radio = document.getElementById(`opt-lang-${this.settings.lang}`) as HTMLInputElement | null;
    if (radio) radio.checked = true;
    this.guidePicker.relabel();
    this.renderGuide();
    this.setQuote(this.quote);
    this.renderStatus();
    this.renderTitleSource();
    this.syncTitleOptions();
    this.syncSoundOptions();
    this.foldPop($("board-pop").classList.contains("is-folded"));
    this.renderTabs();
    this.updateNav();
    if (this.loaded) void Promise.all([this.renderTourList(), this.renderDiagramList(), this.renderConversationList()]);
    if (this.currentFile) $("status-lang").textContent = langLabel(langOf(this.currentFile));
  }

  // ---------- Suoni ----------

  private buildSoundOptions(): void {
    const box = $("track-options");
    for (const track of [...TRACK_IDS, "off"]) {
      const id = `opt-music-${track}`;
      box.insertAdjacentHTML(
        "beforeend",
        `<label class="option" for="${id}">
          <input type="radio" name="music" id="${id}" value="${track}">
          <span class="option-name" data-i18n="tracks.${track}.label"></span>
          <span class="option-hint" data-i18n="tracks.${track}.hint"></span>
        </label>`,
      );
    }
    box.addEventListener("change", (e) => {
      // scegliere un brano vuol dire volerlo sentire: l'audio si riaccende
      this.setSound({ music: (e.target as HTMLInputElement).value as SoundSettings["music"], muted: false });
    });
    for (const [el, key] of [["music-volume", "musicVolume"], ["sfx-volume", "sfxVolume"]] as const) {
      const input = $<HTMLInputElement>(el);
      // mentre si trascina cambia solo il volume; si salva al rilascio
      input.addEventListener("input", () => this.setSound({ [key]: Number(input.value) / 100 }, false));
      input.addEventListener("change", () => {
        this.setSound({ [key]: Number(input.value) / 100 });
        if (key === "sfxVolume") sound.play("select");
      });
    }
    $<HTMLInputElement>("voice-on").addEventListener("change", (e) => {
      this.setSound({ voice: (e.target as HTMLInputElement).checked });
      sound.blip(this.settings.guide.id, "felice");
    });
    $("sound-btn").addEventListener("click", () => this.toggleMute());
    const fsBtn = $("fullscreen-btn");
    if (fullscreenAvailable()) {
      fsBtn.hidden = false;
      fsBtn.addEventListener("click", () => this.toggleFullscreen());
      onFullscreenChange((on) => fsBtn.setAttribute("aria-pressed", String(on)));
    }
    $("text-smaller").addEventListener("click", () => this.changeTextScale(-1));
    $("text-bigger").addEventListener("click", () => this.changeTextScale(1));
    this.syncSoundOptions();
  }

  private toggleFullscreen(): void {
    toggleFullscreen().catch(() => {
      // il browser può rifiutare (iframe, permessi): il gioco resta com'è
    });
  }

  private syncSoundOptions(): void {
    const s = this.settings.sound;
    const radio = document.getElementById(`opt-music-${s.music}`) as HTMLInputElement | null;
    if (radio) radio.checked = true;
    $<HTMLInputElement>("music-volume").value = String(Math.round(s.musicVolume * 100));
    $<HTMLInputElement>("sfx-volume").value = String(Math.round(s.sfxVolume * 100));
    $<HTMLInputElement>("voice-on").checked = s.voice;
    const btn = $("sound-btn");
    btn.setAttribute("aria-pressed", String(s.muted));
    btn.setAttribute("aria-label", s.muted ? t().msg.muted : t().msg.unmuted);
  }

  private setSound(patch: Partial<SoundSettings>, save = true): void {
    this.settings.sound = { ...this.settings.sound, ...patch };
    sound.configure(this.settings.sound);
    this.syncSoundOptions();
    if (save) this.persist();
  }

  /** Dimensione del testo: --fs moltiplica ogni font-size di styles.css. */
  /** Finestra larga o classica: classe sul body; nella classica la misura scelta la tiene layout.ts. */
  private applyFrame(): void {
    for (const f of FRAMES) document.body.classList.toggle(`frame-${f}`, f === this.settings.frame);
    this.layout?.refreshFrame();
    this.relayout();
  }

  private applyTextScale(): void {
    const scale = this.settings.textScale;
    document.documentElement.style.setProperty("--fs", String(scale));
    $<HTMLButtonElement>("text-smaller").disabled = scale <= TEXT_SCALE_MIN;
    $<HTMLButtonElement>("text-bigger").disabled = scale >= TEXT_SCALE_MAX;
  }

  private changeTextScale(dir: 1 | -1): void {
    const next = cleanTextScale(this.settings.textScale + dir * TEXT_SCALE_STEP);
    if (next === this.settings.textScale) return;
    this.settings.textScale = next;
    this.applyTextScale();
    this.persist();
    sound.play("select");
    this.relayout();
  }

  /** Righe e lavagne si rimisurano dopo un cambio di dimensioni (finestra o testo). */
  private relayout(): void {
    if (this.currentFile) void this.walkTo(this.currentFile);
    if (!$("board-pop").hidden) this.popBoard.refresh();
    if (this.view !== undefined) this.tabBoard.refresh();
  }

  private toggleMute(): void {
    this.setSound({ muted: !this.settings.sound.muted });
    sound.play("select");
  }

  // ---------- Questionario ----------

  private buildReaderOptions(): void {
    const box = $("reader-options");
    for (const aid of AIDS) {
      const id = `opt-aid-${aid}`;
      box.insertAdjacentHTML(
        "beforeend",
        `<label class="option check" for="${id}">
          <input type="checkbox" name="aid" id="${id}" value="${aid}">
          <span class="option-name" data-i18n="aids.${aid}.label"></span>
          <span class="option-hint" data-i18n="aids.${aid}.hint"></span>
        </label>`,
      );
    }
    const note = $<HTMLTextAreaElement>("reader-note");
    note.maxLength = READER_NOTE_MAX;
    box.addEventListener("change", () => {
      const aids = AIDS.filter((a) => $<HTMLInputElement>(`opt-aid-${a}`).checked);
      this.setReader({ ...this.settings.reader, aids });
    });
    // la nota si salva quando si esce dal campo, non a ogni tasto
    note.addEventListener("change", () => {
      const text = note.value.trim();
      this.setReader({ aids: this.settings.reader.aids, ...(text ? { note: text } : {}) });
    });
    $("reader-clear").addEventListener("click", () => {
      this.setReader({ aids: [] });
      this.syncReaderOptions();
    });
    this.syncReaderOptions();
  }

  private syncReaderOptions(): void {
    for (const aid of AIDS) $<HTMLInputElement>(`opt-aid-${aid}`).checked = this.settings.reader.aids.includes(aid);
    $<HTMLTextAreaElement>("reader-note").value = this.settings.reader.note ?? "";
  }

  private setReader(reader: Settings["reader"]): void {
    this.settings.reader = reader;
    applyReader(reader);
    this.persist();
  }

  // ---------- Schermata iniziale ----------

  private buildTitleScreen(): void {
    const langs = $("lang-options");
    for (const l of LANGS) {
      const id = `opt-lang-${l}`;
      langs.insertAdjacentHTML(
        "beforeend",
        `<label class="option" for="${id}" lang="${l}">
          <input type="radio" name="lang" id="${id}" value="${l}">
          <span class="option-name">${LANG_INFO[l].label}</span>
          <span class="option-hint">${LANG_INFO[l].hint}</span>
        </label>`,
      );
    }
    const levels = $("level-options");
    for (const lv of LEVELS) {
      const id = `opt-level-${lv}`;
      levels.insertAdjacentHTML(
        "beforeend",
        `<label class="option" for="${id}">
          <input type="radio" name="level" id="${id}" value="${lv}">
          <span class="option-name" data-i18n="levels.${lv}.label"></span>
          <span class="option-hint" data-i18n="levels.${lv}.hint"></span>
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
          <span class="option-name" data-i18n="generation.${g}.label"></span>
          <span class="option-hint" data-i18n="generation.${g}.hint"></span>
        </label>`,
      );
    }
    const frames = $("frame-options");
    for (const f of FRAMES) {
      const id = `opt-frame-${f}`;
      frames.insertAdjacentHTML(
        "beforeend",
        `<label class="option" for="${id}">
          <input type="radio" name="frame" id="${id}" value="${f}">
          <span class="option-name" data-i18n="frames.${f}.label"></span>
          <span class="option-hint" data-i18n="frames.${f}.hint"></span>
        </label>`,
      );
    }
    $("title-screen").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.type === "radio" || input.type === "checkbox") sound.play("select");
      if (input.name === "lang") this.setLanguage(input.value as Lang);
      if (input.name === "level") this.setLevel(input.value as Level);
      if (input.name === "frame") {
        this.settings.frame = input.value as Frame;
        this.persist();
        this.applyFrame();
      }
      if (input.name === "generation") {
        this.settings.generation = input.value as Settings["generation"];
        this.persist();
        this.renderStatus();
      }
    });
    $("start-btn").addEventListener("click", () => void this.start());
    this.syncTitleOptions();
  }

  private syncTitleOptions(): void {
    const lv = document.getElementById(`opt-level-${this.settings.level}`) as HTMLInputElement | null;
    const gen = document.getElementById(`opt-gen-${this.settings.generation}`) as HTMLInputElement | null;
    const frame = document.getElementById(`opt-frame-${this.settings.frame}`) as HTMLInputElement | null;
    if (frame) frame.checked = true;
    const lang = document.getElementById(`opt-lang-${this.settings.lang}`) as HTMLInputElement | null;
    if (lv) lv.checked = true;
    if (gen) gen.checked = true;
    if (lang) lang.checked = true;
    $("start-btn").textContent = this.tour ? t().menu.resume : t().menu.enter;
  }

  private renderTitleSource(): void {
    const el = $("title-source");
    if (this.source.kind === "demo") {
      el.textContent = t().msg.sourceDemo(this.source.projectName);
    } else if (this.connection === "connected") {
      el.textContent = t().msg.sourceProject(this.source.projectName, this.source.agent);
    } else {
      el.textContent = isDesktopApp() ? t().msg.sourceSearching : t().msg.sourceWaiting;
    }
    $("session-btn").hidden = this.source.kind !== "bridge";
  }

  /** Elenco delle sessioni aperte; scegliendone un'altra la pagina si ricollega a lei. */
  private async chooseSession(): Promise<void> {
    if (this.source.kind !== "bridge") return;
    sound.play("menu");
    const s = await pickSession(undefined, this.source.port);
    if (s && s.port !== this.source.port) switchSession(s.port);
  }

  /** Nome e mini-guida ovunque compaiano. */
  private renderGuide(): void {
    const name = this.settings.guide.name;
    $("tagline").textContent = t().msg.tagline(name);
    this.renderAskHint();
    if (this.speakerIsGuide) $("speaker").textContent = name;
    drawMiniGuide($<HTMLCanvasElement>("walker"), 0);
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
    drawMiniGuide($<HTMLCanvasElement>("walker"), 0);
  }

  private async renderTourList(): Promise<void> {
    const list = $("tour-list");
    list.innerHTML = "";
    const tours = await this.source.listTours().catch(() => []);
    if (tours.length === 0) {
      list.innerHTML = `<li class="muted small">${t().msg.noTours}</li>`;
      return;
    }
    for (const tour of tours) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tour-item";
      btn.innerHTML = `<span class="tour-title"></span><span class="tour-meta"></span>`;
      btn.querySelector(".tour-title")!.textContent = tour.title;
      btn.querySelector(".tour-meta")!.textContent = t().msg.steps(tour.steps);
      btn.addEventListener("click", () => void this.playTour(tour.id));
      li.append(btn);
      list.append(li);
    }
  }

  private async renderDiagramList(): Promise<void> {
    const list = $("diagram-list");
    list.innerHTML = "";
    const diagrams = await this.source.listDiagrams().catch(() => []);
    if (diagrams.length === 0) {
      list.innerHTML = `<li class="muted small">${t().msg.noDiagrams}</li>`;
      return;
    }
    for (const d of diagrams) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tour-item";
      btn.innerHTML = `<span class="tour-title"></span><span class="tour-meta"></span>`;
      btn.querySelector(".tour-title")!.textContent = d.title;
      btn.querySelector(".tour-meta")!.textContent = t().kinds[d.kind];
      btn.addEventListener("click", () => void this.openDiagramTab(d.id));
      li.append(btn);
      list.append(li);
    }
  }

  private async renderConversationList(): Promise<void> {
    const list = $("conversation-list");
    const convs = await this.source.listConversations().catch(() => []);
    list.innerHTML = "";
    if (convs.length === 0) {
      list.innerHTML = `<li class="muted small">${t().msg.noConversations}</li>`;
      return;
    }
    const date = new Intl.DateTimeFormat(this.settings.lang, { day: "numeric", month: "short" });
    for (const c of convs) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tour-item";
      btn.innerHTML = `<span class="tour-title"></span><span class="tour-meta"></span>`;
      btn.querySelector(".tour-title")!.textContent = c.title;
      btn.querySelector(".tour-meta")!.textContent = `${t().msg.questions(c.turns)} · ${date.format(new Date(c.updatedAt))}`;
      btn.addEventListener("click", () => void this.openConversation(c.id));
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
    if (walker.style.transform !== `translate(${x}px, ${y}px)`) sound.play("step");
    if (reducedMotion()) {
      walker.style.transform = `translate(${x}px, ${y}px)`;
      return;
    }
    let frame = 0;
    const tick = setInterval(() => drawMiniGuide(walker, ++frame), 90);
    walker.style.transform = `translate(${x}px, ${y}px)`;
    await sleep(460);
    clearInterval(tick);
    drawMiniGuide(walker, 0);
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
      this.say({ text: t().msg.cantOpenFile(path, e instanceof Error ? e.message : String(e)), expression: "preoccupato" });
    });
    return this.navigating;
  }

  private async doGoToFile(path: string, lines?: [number, number], content?: string): Promise<void> {
    if (content !== undefined) this.fileCache.set(path, content);
    if (this.view !== undefined) this.setView(undefined);
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
    this.renderTabs();
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

  // ---------- Schede e lavagna ----------

  /** Scheda del file aperto più una scheda per ogni schema mostrato. */
  private renderTabs(): void {
    const tabs = $("tabs");
    tabs.innerHTML = "";
    const tab = (label: string, icon: string, active: boolean, open: () => void) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `tab${active ? " is-active" : ""}`;
      btn.innerHTML = `<span class="${icon}" aria-hidden="true"></span><span class="tab-name"></span>`;
      btn.querySelector(".tab-name")!.textContent = label;
      if (active) btn.setAttribute("aria-current", "page");
      btn.addEventListener("click", open);
      tabs.append(btn);
      return btn;
    };
    if (this.currentFile) {
      tab(this.currentFile.split("/").pop()!, `file-icon ext-${langOf(this.currentFile)}`, this.view === undefined, () => this.setView(undefined));
    }
    for (const d of this.boardTabs) {
      const btn = tab(d.title, "tab-board-icon", this.view === d.id, () => this.setView(d.id));
      btn.title = t().msg.tabDiagram(d.title);
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = t().ui.closeTab;
      close.setAttribute("aria-hidden", "true");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeBoardTab(d.id);
      });
      btn.append(close);
    }
  }

  /** Mostra il codice (undefined) o lo schema di una scheda. */
  private setView(id: string | undefined): void {
    const d = id === undefined ? undefined : this.boardTabs.find((t) => t.id === id);
    this.view = d?.id;
    const view = $("board-view");
    view.hidden = !d;
    const pop = $("board-pop");
    if (d && this.popBoard.current?.id === d.id) {
      // la scheda mostra lo stesso schema della finestra: la finestra si mette da parte, non si chiude
      if (!pop.hidden) this.popParked = true;
      pop.hidden = true;
    } else if (this.popParked) {
      this.popParked = false;
      pop.hidden = false;
      this.popBoard.refresh();
    }
    if (d) {
      $("board-view-title").textContent = d.title;
      if (!view.contains(this.tabBoard.el)) view.append(this.tabBoard.el);
      void this.tabBoard.show(d, undefined, false);
    }
    this.renderTabs();
  }

  private addBoardTab(d: Diagram): void {
    const i = this.boardTabs.findIndex((t) => t.id === d.id);
    if (i === -1) this.boardTabs.push(d);
    else this.boardTabs[i] = d;
    this.diagramCache.set(d.id, d);
    if (this.view === d.id) this.setView(d.id);
    else this.renderTabs();
  }

  private closeBoardTab(id: string): void {
    // chiudere la scheda chiude anche la finestra messa da parte con lo stesso schema
    if (this.popParked && this.popBoard.current?.id === id) this.closePop();
    this.boardTabs = this.boardTabs.filter((t) => t.id !== id);
    if (this.view === id) this.setView(undefined);
    else this.renderTabs();
  }

  private async loadDiagram(id: string): Promise<Diagram> {
    const cached = this.diagramCache.get(id);
    if (cached) return cached;
    const d = await this.source.loadDiagram(id);
    this.diagramCache.set(id, d);
    return d;
  }

  private async openDiagramTab(id: string): Promise<void> {
    try {
      this.addBoardTab(await this.loadDiagram(id));
      this.setView(id);
    } catch (e) {
      this.say({ text: t().msg.cantOpenDiagram(e instanceof Error ? e.message : String(e)), expression: "preoccupato" });
    }
  }

  /** Apre la finestra della lavagna sopra il codice e salva lo schema in una scheda. */
  private async openPop(d: Diagram, upto: number | undefined): Promise<void> {
    this.addBoardTab(d);
    this.popParked = false;
    const pop = $("board-pop");
    // se lo stesso schema è già aperto, resta ridotto come l'ha lasciato l'utente
    if (pop.hidden || this.popBoard.current?.id !== d.id) {
      this.foldPop(false);
      sound.play("board");
    }
    $("board-pop-title").textContent = d.title;
    if (!pop.contains(this.popBoard.el)) pop.append(this.popBoard.el);
    pop.hidden = false;
    await this.popBoard.show(d, upto);
  }

  private closePop(): void {
    $("board-pop").hidden = true;
    this.popParked = false;
  }

  private foldPop(folded: boolean): void {
    $("board-pop").classList.toggle("is-folded", folded);
    const btn = $("board-pop-fold");
    btn.textContent = folded ? t().ui.unfold : t().ui.fold;
    btn.setAttribute("aria-expanded", String(!folded));
  }

  /** Clic su una stanza della lavagna: apre il suo codice. */
  private openFromBoard(file: string, lines: [number, number], fromPop: boolean): void {
    if (fromPop) this.foldPop(true);
    void this.goToFile(file, lines);
  }

  /** Lo schema del passo si apre nella finestra; un passo senza schema lascia com'è quella già aperta. */
  private async showStepDiagram(step: TourStep): Promise<void> {
    if (!step.diagram) return;
    try {
      const d = await this.loadDiagram(step.diagram.id);
      // l'utente può essere già andato avanti
      if (this.tour?.steps[this.stepIndex] !== step) return;
      await this.openPop(d, step.diagram.upto);
    } catch (e) {
      this.say({ text: t().msg.cantLoadDiagram(step.diagram.id, e instanceof Error ? e.message : String(e)), expression: "preoccupato" });
    }
  }

  // ---------- Dialogo ----------

  private say(line: DialogLine): void {
    this.stopTyping();
    clearTimeout(this.waitHint);
    // un nuovo fumetto sostituisce la risposta dal vivo: niente "riprendi" in sospeso
    this.afterLine = undefined;
    this.liveAnswer = false;
    this.liveQueue = [];
    this.renderAskHint();
    this.speakerIsGuide = !line.speaker;
    $("speaker").textContent = line.speaker ?? this.settings.guide.name;
    // chi usa un lettore di schermo riceve il testo intero, non le pagine
    $("dialog-live").textContent = line.text;
    this.dialogLine = line;
    this.pageList = pages(line.text);
    this.showPage(0);
  }

  /** Mostra una pagina del fumetto corrente; scelte e azioni solo sull'ultima. */
  private showPage(index: number): void {
    const line = this.dialogLine;
    if (!line) return;
    this.stopTyping();
    this.page = index;
    const text = this.pageList[index];
    const last = index === this.pageList.length - 1;
    const textEl = $("dialog-text");
    textEl.scrollTop = 0;
    this.portrait.set({ expression: line.expression, talking: true });
    const note = $("dialog-note");
    const pageNote = this.pageList.length > 1 ? t().msg.page(index + 1, this.pageList.length) : "";
    const noteText = [last ? line.note : undefined, pageNote].filter(Boolean).join(" ");
    note.hidden = !noteText;
    note.textContent = noteText;
    if (last) this.renderLiveNote();
    this.renderChoices([]);
    this.awaitingChoice = false;
    $("dialog").classList.add("is-typing");

    const finish = () => {
      this.stopTyping();
      textEl.textContent = text;
      this.portrait.set({ talking: false });
      $("dialog").classList.remove("is-typing");
      const choices: Choice[] = !last
        ? []
        : (line.actions ??
          (line.choices && line.choices.length > 1
            ? line.choices.map((c) => ({ label: c.when ?? c.goto, run: () => this.followLink(c) }))
            : []));
      if (choices.length) {
        this.awaitingChoice = true;
        this.renderChoices(choices);
        sound.play("choice");
      }
      this.updateNav();
      // il dialogo può essere cresciuto (scelte): ricentra le righe evidenziate
      requestAnimationFrame(() => this.scrollToHighlight());
    };

    const voice = () => sound.blip(this.settings.guide.id, line.expression);
    if (reducedMotion()) {
      voice();
      finish();
      return;
    }
    let i = 0;
    textEl.textContent = "";
    const timer = window.setInterval(() => {
      const from = i;
      i = Math.min(text.length, i + 2);
      textEl.textContent = text.slice(0, i);
      // un bip per sillaba, non per spazi e punteggiatura (come nei Mystery Dungeon)
      if (/[\p{L}\p{N}]/u.test(text.slice(from, i))) voice();
      if (i >= text.length) finish();
    }, 24);
    this.typing = { full: text, timer };
    this.typingFinish = finish;
    this.updateNav();
  }

  /** Altre pagine del fumetto corrente da leggere. */
  private get morePages(): boolean {
    return this.page < this.pageList.length - 1;
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
        sound.play("confirm");
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
    const before = this.tour?.id;
    try {
      this.tour = tourData ?? (await this.source.loadTour(id));
    } catch (e) {
      this.say({ text: t().msg.cantLoadTour(e instanceof Error ? e.message : String(e)), expression: "preoccupato" });
      return;
    }
    this.history = [];
    // la lavagna resta per tutto il tour: si chiude solo cambiando tour
    if (before !== this.tour.id) this.closePop();
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
      text: fallback ? step.text[fallback]! : t().msg.noText,
      note: t().msg.missingLevel(t().levels[want].label, fallback ? t().levels[fallback].label : "?"),
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
      if (sent) fullNote = `${note} ${t().msg.askedAgent}`;
    }
    $("step-title").textContent = step.title ?? "";
    void this.goToFile(step.file, step.lines);
    void this.showStepDiagram(step);
    this.say({ text, expression: step.expression ?? "neutro", choices: step.next, note: fullNote });
    this.renderStatus();
    this.reportState();
  }

  private followLink(link: StepLink): void {
    if (!this.tour) return;
    const idx = this.tour.steps.findIndex((s) => s.id === link.goto);
    if (idx === -1) {
      this.say({ text: t().msg.missingStep(link.goto), expression: "preoccupato" });
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
    if (this.morePages) {
      sound.play("next");
      return this.showPage(this.page + 1);
    }
    if (this.awaitingChoice) return;
    if (this.afterLine) {
      sound.play("next");
      const fn = this.afterLine;
      this.afterLine = undefined;
      fn();
      return;
    }
    if (!this.tour || this.stepIndex < 0) return;
    const step = this.tour.steps[this.stepIndex];
    if (step.next && step.next.length === 0) return this.endTour();
    sound.play("next");
    if (step.next && step.next.length === 1) return this.followLink(step.next[0]);
    if (this.stepIndex + 1 < this.tour.steps.length) return this.showStep(this.stepIndex + 1);
    this.endTour();
  }

  prev(): void {
    if (this.typing) {
      this.typingFinish?.();
      return;
    }
    if (this.page > 0) {
      sound.play("back");
      return this.showPage(this.page - 1);
    }
    const prev = this.history.pop();
    if (prev !== undefined) {
      sound.play("back");
      this.showStep(prev, false);
    }
  }

  private endTour(): void {
    const title = this.tour?.title ?? t().msg.theTour;
    this.stepIndex = -1;
    const tour = this.tour;
    this.tour = undefined;
    this.history = [];
    $("step-title").textContent = t().msg.end;
    sound.play("end");
    this.say({
      text: t().msg.tourEnd(title),
      expression: "felice",
      actions: tour
        ? [
            { label: t().msg.restart, run: () => void this.playTour(tour.id, undefined, tour) },
            { label: t().msg.stay, run: () => {} },
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
      btn.dataset.i18n = `levels.${lv}.label`;
      btn.dataset.i18nTitle = `levels.${lv}.hint`;
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
    this.persist();
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
    // chi chiede mentre legge una risposta continua quella conversazione
    const ctx = this.context();
    const quote = this.quote;
    const context: GameContext = quote ? { ...ctx, selection: quote.text, file: quote.file ?? ctx.file, lines: quote.lines ?? ctx.lines } : ctx;
    const sent = this.source.ask(q, context, this.liveAnswer ? this.conversation : undefined);
    sound.play(sent ? "ask" : "error");
    if (sent) {
      this.setQuote(undefined);
      this.say({ text: t().msg.asked, expression: "pensieroso" });
      this.portrait.set({ talking: false });
      this.waitHint = window.setTimeout(() => {
        const note = $("dialog-note");
        note.hidden = false;
        note.textContent = t().msg.waitHint;
      }, 30_000);
    } else if (this.source.kind === "demo") {
      this.say({
        text: t().msg.demoNoAgent,
        expression: "pensieroso",
      });
    } else if (this.connection === "connected") {
      this.say({
        text: t().msg.playNoAgent,
        expression: "pensieroso",
      });
    } else {
      this.say({ text: t().msg.bridgeDown, expression: "preoccupato" });
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
        sound.play("answer");
        const line: DialogLine = { text: cmd.text, expression: cmd.expression ?? "neutro", speaker: cmd.speaker };
        // l'utente sta ancora leggendo una risposta: il nuovo fumetto aspetta il suo turno
        if (this.liveAnswer) {
          this.liveQueue.push(line);
          this.afterLine ??= () => this.nextLive();
          this.renderLiveNote();
          this.updateNav();
          break;
        }
        // una risposta dal vivo interrompe il tour; "Avanti" lo riprende dal passo corrente
        this.resumeStep = this.tour && this.stepIndex >= 0 ? this.stepIndex : undefined;
        this.showLive(line, []);
        break;
      }
      case "diagram":
        this.diagramCache.set(cmd.diagram.id, cmd.diagram);
        await this.openPop(cmd.diagram, cmd.upto);
        void this.renderDiagramList();
        break;
      case "play_tour":
        this.fileCache.clear();
        this.diagramCache.clear();
        await this.playTour(cmd.tour.id, cmd.fromStep, cmd.tour);
        await this.renderTourList();
        break;
      case "conversation":
        this.conversation = cmd.summary.id;
        void this.renderConversationList();
        break;
    }
  }

  /** Rilegge una conversazione salvata: ogni domanda col suo codice, poi le risposte, con "Avanti". */
  private async openConversation(id: string): Promise<void> {
    let turns: ConversationTurn[];
    try {
      turns = (await this.source.loadConversation(id)).turns;
    } catch (e) {
      this.say({ text: t().msg.cantLoadConversation(e instanceof Error ? e.message : String(e)), expression: "preoccupato" });
      return;
    }
    const lines = turns.flatMap((turn): DialogLine[] => {
      const { file, lines } = turn.question.context;
      const question: DialogLine = {
        text: turn.question.text,
        expression: "pensieroso",
        speaker: t().msg.you,
        before: file ? () => void this.goToFile(file, lines) : undefined,
      };
      const answers = turn.answers.map((a, i): DialogLine => ({
        text: a.text,
        expression: a.expression ?? "neutro",
        before: i === 0 ? () => void this.showAnswerScene(turn) : undefined,
      }));
      return [question, ...answers];
    });
    const [first, ...rest] = lines;
    if (!first) return;
    if (!$("title-screen").hidden) this.closeTitle();
    this.conversation = id;
    if (!this.liveAnswer) this.resumeStep = this.tour && this.stepIndex >= 0 ? this.stepIndex : undefined;
    this.showLive(first, rest);
  }

  /** Il codice e lo schema che l'agente aveva mostrato rispondendo. */
  private async showAnswerScene(turn: ConversationTurn): Promise<void> {
    if (turn.code) await this.goToFile(turn.code.file, turn.code.lines);
    if (!turn.diagram) return;
    try {
      await this.openPop(await this.loadDiagram(turn.diagram.id), turn.diagram.upto);
    } catch (e) {
      this.say({ text: t().msg.cantLoadDiagram(turn.diagram.id, e instanceof Error ? e.message : String(e)), expression: "preoccupato" });
    }
  }

  /** Il campo delle domande dice se la prossima continua la conversazione o riguarda il testo selezionato. */
  private renderAskHint(): void {
    const name = this.settings.guide.name;
    $<HTMLInputElement>("ask-input").placeholder = this.quote
      ? t().msg.askSelectedPlaceholder
      : this.liveAnswer && this.conversation
        ? t().msg.followUp
        : t().msg.askPlaceholder(name);
  }

  // ---------- Testo selezionato ----------

  /** La selezione corrente, se sta tutta nel codice o tutta nel fumetto. */
  private readSelection(): { quote: Quote; range: Range } | undefined {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return undefined;
    const range = sel.getRangeAt(0);
    const area = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest("#editor, #dialog-text");
    const where = area(range.startContainer);
    if (!where || where !== area(range.endContainer)) return undefined;
    if (where.id === "dialog-text") {
      const text = sel.toString().trim();
      return text ? { quote: { text: text.slice(0, SELECTION_MAX) }, range } : undefined;
    }
    // nel codice: niente numeri di riga, una riga di testo per ogni riga dell'editor
    const frag = range.cloneContents();
    const rows = [...frag.querySelectorAll(".line")];
    const raw = rows.length ? rows.map((r) => r.querySelector("code")?.textContent ?? "") : [frag.textContent ?? ""];
    // via il rientro comune: conta la forma del codice, non quanto è annidato
    const indent = Math.min(...raw.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const text = raw.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n").replace(/\s+$/, "");
    if (!text.trim()) return undefined;
    const lineOf = (n: Node) => Number((n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>(".line")?.dataset.n);
    const a = lineOf(range.startContainer);
    const b = lineOf(range.endContainer);
    const lines: [number, number] | undefined = a && b ? [Math.min(a, b), Math.max(a, b)] : undefined;
    return { quote: { text: text.slice(0, SELECTION_MAX), file: this.currentFile, lines }, range };
  }

  /** Mostra "Chiedi su questo" accanto alla selezione, o lo nasconde. */
  private placeAskSelection(): void {
    const btn = $("ask-sel");
    const found = $("title-screen").hidden ? this.readSelection() : undefined;
    if (!found) {
      btn.hidden = true;
      return;
    }
    const rects = found.range.getClientRects();
    const r = rects[rects.length - 1] ?? found.range.getBoundingClientRect();
    btn.hidden = false;
    const w = btn.offsetWidth;
    const h = btn.offsetHeight;
    const below = r.bottom + 6 + h < innerHeight - 8;
    btn.style.left = `${Math.max(8, Math.min(r.right - w / 2, innerWidth - w - 8))}px`;
    btn.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
  }

  private setQuote(quote: Quote | undefined): void {
    this.quote = quote;
    $("ask-quote").hidden = !quote;
    if (quote) {
      $("ask-quote-label").textContent = t().msg.quoteFrom(quote.file, quote.lines);
      $("ask-quote-text").textContent = quote.text.replace(/\s+/g, " ");
      $("ask-quote-text").title = quote.text;
    }
    this.renderAskHint();
  }

  private showLive(line: DialogLine, queue: DialogLine[]): void {
    this.say(line);
    line.before?.();
    this.liveQueue = queue;
    this.liveAnswer = true;
    this.renderAskHint();
    $("step-title").textContent = t().msg.answer;
    if (queue.length || this.resumeStep !== undefined) this.afterLine = () => this.nextLive();
    this.renderLiveNote();
    this.updateNav();
    this.reportState();
  }

  /** "Avanti" su una risposta dal vivo: il fumetto seguente, oppure si torna al passo del tour. */
  private nextLive(): void {
    const [line, ...rest] = this.liveQueue;
    if (line) return this.showLive(line, rest);
    const resume = this.resumeStep;
    this.resumeStep = undefined;
    if (resume !== undefined && this.tour) this.showStep(resume, false);
  }

  private renderLiveNote(): void {
    if (!this.liveQueue.length || this.morePages) return;
    const n = this.liveQueue.length;
    const note = $("dialog-note");
    note.hidden = false;
    note.textContent = t().msg.moreMessages(n);
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
      guide: this.settings.guide.name,
      lang: this.settings.lang,
    };
  }

  private reportState(): void {
    this.source.sendState(this.context());
  }

  // ---------- Barra di stato e controlli ----------

  private renderStatus(): void {
    const conn = $("status-conn");
    const labels: Record<ConnectionState, string> = {
      demo: t().msg.statusDemo,
      connecting: t().msg.statusConnecting,
      connected: this.source.agent ? t().msg.statusAgent : t().msg.statusBridge,
      offline: t().msg.statusOffline,
    };
    conn.textContent = labels[this.connection];
    conn.dataset.state = this.connection;
    const step = this.tour && this.stepIndex >= 0 ? this.tour.steps[this.stepIndex] : undefined;
    $("status-step").textContent = step ? this.stepCounter() : "";
    $("status-level").textContent = t().msg.statusLevel(t().levels[this.settings.level].label);
    $("status-gen").textContent = t().generation[this.settings.generation].label;
  }

  /** Indici dei passi che possono seguire il passo i. */
  private successors(i: number): number[] {
    const steps = this.tour?.steps ?? [];
    const next = steps[i]?.next;
    if (!next) return i + 1 < steps.length ? [i + 1] : [];
    return next.map((l) => steps.findIndex((s) => s.id === l.goto)).filter((j) => j >= 0);
  }

  /**
   * "Passo k/n" lungo il percorso seguito, non nell'elenco: con le diramazioni i passi degli altri rami non contano.
   * k = passi già fatti, n = k + il percorso più lungo che resta.
   */
  private stepCounter(): string {
    const memo = new Map<number, number>();
    const remaining = (i: number, seen: Set<number>): number => {
      const known = memo.get(i);
      if (known !== undefined) return known;
      if (seen.has(i)) return 0;
      seen.add(i);
      const r = 1 + Math.max(0, ...this.successors(i).map((j) => remaining(j, seen)));
      seen.delete(i);
      memo.set(i, r);
      return r;
    };
    const done = this.history.length || this.distanceFromStart(this.stepIndex);
    return t().msg.stepCounter(done + 1, done + remaining(this.stepIndex, new Set()));
  }

  /** Passi dall'inizio del tour fino a i (per un tour ripreso a metà, senza cronologia). */
  private distanceFromStart(i: number): number {
    const dist = new Map<number, number>([[0, 0]]);
    const queue = [0];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === i) return dist.get(cur)!;
      for (const j of this.successors(cur)) {
        if (!dist.has(j)) {
          dist.set(j, dist.get(cur)! + 1);
          queue.push(j);
        }
      }
    }
    return 0;
  }

  private updateNav(): void {
    ($("prev-btn") as HTMLButtonElement).disabled = this.history.length === 0 && this.page === 0;
    const canNext = !!this.typing || this.morePages || !!this.afterLine || (!this.awaitingChoice && !!this.tour && this.stepIndex >= 0);
    ($("next-btn") as HTMLButtonElement).disabled = !canNext;
    $("next-btn").textContent = this.typing ? t().ui.skip : t().ui.next;
    $("advance").hidden = !canNext || !!this.typing;
  }

  private bindControls(): void {
    $("next-btn").addEventListener("click", () => this.next());
    $("prev-btn").addEventListener("click", () => this.prev());
    // un clic avanza, ma non quando si sta selezionando del testo da chiedere
    $("dialog-text").addEventListener("click", () => {
      if (!getSelection()?.isCollapsed) return;
      this.next();
    });
    this.layout = initLayout(() => this.relayout());
    const askSel = $("ask-sel");
    // il clic sul pulsante non deve togliere la selezione prima di leggerla
    askSel.addEventListener("pointerdown", (e) => e.preventDefault());
    askSel.addEventListener("click", () => {
      const found = this.readSelection();
      askSel.hidden = true;
      if (!found) return;
      this.setQuote(found.quote);
      getSelection()?.removeAllRanges();
      sound.play("select");
      $("ask-input").focus();
    });
    $("ask-quote-clear").addEventListener("click", () => {
      this.setQuote(undefined);
      $("ask-input").focus();
    });
    document.addEventListener("pointerup", (e) => {
      if (e.target !== askSel) setTimeout(() => this.placeAskSelection());
    });
    document.addEventListener("keyup", (e) => {
      if (e.shiftKey || e.key === "Shift") this.placeAskSelection();
    });
    document.addEventListener("selectionchange", () => {
      if (getSelection()?.isCollapsed) askSel.hidden = true;
    });
    $("editor").addEventListener("scroll", () => (askSel.hidden = true));
    $("menu-btn").addEventListener("click", () => this.openTitle());
    $("project-name").addEventListener("click", () => void this.chooseSession());
    $("session-btn").addEventListener("click", () => void this.chooseSession());
    $("board-pop-close").addEventListener("click", () => this.closePop());
    $("board-pop-fold").addEventListener("click", () => this.foldPop(!$("board-pop").classList.contains("is-folded")));
    $("board-pop-tab").addEventListener("click", () => {
      const d = this.popBoard.current;
      if (d) this.setView(d.id);
    });
    $("ask-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>("ask-input");
      this.ask(input.value);
      input.value = "";
    });
    document.addEventListener("keydown", (e) => {
      const inField = (e.target as HTMLElement).closest("input, textarea");
      if (e.key === "Escape") {
        if ($("title-screen").hidden && !$("board-pop").hidden) this.closePop();
        else if ($("title-screen").hidden) this.openTitle();
        else if (this.source.files.length) void this.start();
        return;
      }
      // nel browser F11 è già suo; nell'app lo prende il gioco
      if (e.key === "F11" && isDesktopApp()) {
        e.preventDefault();
        this.toggleFullscreen();
        return;
      }
      if (inField) return;
      if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey && fullscreenAvailable()) {
        this.toggleFullscreen();
        return;
      }
      if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.toggleMute();
        return;
      }
      if ((e.key === "+" || e.key === "=" || e.key === "-") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.changeTextScale(e.key === "-" ? -1 : 1);
        return;
      }
      if (!$("title-screen").hidden) return;
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
    window.addEventListener("resize", () => this.relayout());
    this.updateNav();
  }

  /** Apre la schermata iniziale. */
  boot(): void {
    this.openTitle();
  }
}
