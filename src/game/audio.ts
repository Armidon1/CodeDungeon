// Suoni del gioco, tutti sintetizzati con Web Audio: musiche chiptune, effetti dell'interfaccia
// e la voce della guida (un bip a ogni sillaba, come nei Mystery Dungeon).
// Nessun file audio: niente licenze da gestire e la demo resta un file unico.
//
// Due uscite. Nel browser il grafo suona dal vivo su un AudioContext. Nell'app su Linux (WebKitGTK)
// l'uscita di Web Audio si guasta con alcune schede audio (con le cuffie bluetooth tace o cambia velocità):
// lì ogni suono si calcola senza uscita (OfflineAudioContext), diventa un WAV in memoria e suona da un
// elemento <audio>, che quel motore riproduce bene. La musica è un giro intero suonato in loop.

import type { Expression } from "../shared/types";

// ---------- Impostazioni ----------

export const TRACK_IDS = ["taverna", "grotta", "biblioteca", "forziere"] as const;
export type TrackId = (typeof TRACK_IDS)[number];

export interface SoundSettings {
  music: TrackId | "off";
  /** Volumi da 0 a 1. */
  musicVolume: number;
  sfxVolume: number;
  /** Bip della guida mentre parla. */
  voice: boolean;
  /** Suono dei tasti mentre si scrive (domanda, editor, terminali). */
  keys: boolean;
  /** Tutto spento (pulsante nella barra o tasto M). */
  muted: boolean;
}

export const SOUND_DEFAULTS: SoundSettings = { music: "taverna", musicVolume: 0.5, sfxVolume: 0.7, voice: true, keys: true, muted: false };

const unit = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

export function cleanSound(raw: unknown): SoundSettings {
  const s = (raw ?? {}) as Partial<SoundSettings>;
  return {
    music: s.music === "off" || TRACK_IDS.includes(s.music as TrackId) ? (s.music as SoundSettings["music"]) : SOUND_DEFAULTS.music,
    musicVolume: unit(s.musicVolume, SOUND_DEFAULTS.musicVolume),
    sfxVolume: unit(s.sfxVolume, SOUND_DEFAULTS.sfxVolume),
    voice: typeof s.voice === "boolean" ? s.voice : SOUND_DEFAULTS.voice,
    keys: typeof s.keys === "boolean" ? s.keys : SOUND_DEFAULTS.keys,
    muted: s.muted === true,
  };
}

// ---------- Motore ----------

type Wave = OscillatorType | "pulse25" | "pulse12";

interface Graph {
  ctx: BaseAudioContext;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  /** Ingresso dell'eco (delay con ritorno), condiviso da musica ed effetti. */
  echo: GainNode;
  noise: AudioBuffer;
  pulses: Map<number, PeriodicWave>;
}

let graph: Graph | undefined;
/** Contesto dal vivo (solo nel browser): si sospende e riprende. */
let live: AudioContext | undefined;
let settings: SoundSettings = { ...SOUND_DEFAULTS };
/** Il browser fa suonare solo dopo un gesto dell'utente (clic o tasto). */
let unlocked = false;

/** Uscita a clip: app desktop su Linux, oppure ?audio=clips per provarla nel browser. */
const CLIPS =
  typeof OfflineAudioContext !== "undefined" &&
  (("__TAURI_INTERNALS__" in window && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) ||
    new URLSearchParams(location.search).get("audio") === "clips");

function build(): Graph | undefined {
  if (CLIPS) return wire(new OfflineAudioContext(1, 1, CLIP_RATE));
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return undefined;
  live = new AC();
  return wire(live);
}

/** Bus, compressore ed eco del gioco su un contesto qualsiasi (dal vivo o di calcolo). */
function wire(ctx: BaseAudioContext): Graph {
  const master = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
  // la musica passa da un passa-basso: più morbida sotto la voce della guida
  const music = ctx.createGain();
  const soft = ctx.createBiquadFilter();
  soft.type = "lowpass";
  soft.frequency.value = 5200;
  music.connect(soft).connect(master);
  const sfx = ctx.createGain();
  sfx.connect(master);
  const echo = ctx.createGain();
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.27;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.38;
  const dark = ctx.createBiquadFilter();
  dark.type = "lowpass";
  dark.frequency.value = 2600;
  echo.connect(delay).connect(dark).connect(feedback).connect(delay);
  dark.connect(master);
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return { ctx, master, music, sfx, echo, noise, pulses: new Map() };
}

/** Onda quadra con duty cycle (12,5% o 25%): il timbro delle vecchie console. */
function pulseWave(g: Graph, duty: number): PeriodicWave {
  let w = g.pulses.get(duty);
  if (!w) {
    const n = 48;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
    w = g.ctx.createPeriodicWave(real, imag);
    g.pulses.set(duty, w);
  }
  return w;
}

interface ToneOpts {
  attack?: number;
  /** Frequenza d'arrivo (glissato). */
  slideTo?: number;
  /** Quanto del suono va nell'eco. */
  echo?: number;
}

function tone(g: Graph, out: AudioNode, wave: Wave, freq: number, t: number, dur: number, vol: number, o: ToneOpts = {}): void {
  const osc = g.ctx.createOscillator();
  if (wave === "pulse25" || wave === "pulse12") osc.setPeriodicWave(pulseWave(g, wave === "pulse25" ? 0.25 : 0.125));
  else osc.type = wave;
  osc.frequency.setValueAtTime(freq, t);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t + dur);
  const env = g.ctx.createGain();
  const a = Math.min(o.attack ?? 0.006, dur / 2);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vol, t + a);
  env.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  osc.connect(env).connect(out);
  if (o.echo) {
    const send = g.ctx.createGain();
    send.gain.value = o.echo;
    env.connect(send).connect(g.echo);
  }
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noiseHit(g: Graph, out: AudioNode, t: number, dur: number, vol: number, filter: BiquadFilterType, freq: number): void {
  const src = g.ctx.createBufferSource();
  src.buffer = g.noise;
  const f = g.ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  const env = g.ctx.createGain();
  env.gain.setValueAtTime(vol, t);
  env.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  src.connect(f).connect(env).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Volume percepito: la curva al quadrato rende lo slider più naturale. */
const level = (v: number) => v * v;

function applyVolumes(): void {
  if (CLIPS) {
    if (musicEl) musicEl.volume = settings.muted ? 0 : level(settings.musicVolume);
    return;
  }
  if (!graph) return;
  const t = graph.ctx.currentTime;
  graph.master.gain.setTargetAtTime(settings.muted ? 0 : 1, t, 0.03);
  graph.music.gain.setTargetAtTime(level(settings.musicVolume) * 0.9, t, 0.05);
  graph.sfx.gain.setTargetAtTime(level(settings.sfxVolume), t, 0.03);
}

// ---------- Musica ----------

/**
 * Un brano in 8 battute da 16 sedicesimi, che si ripete.
 * Melodia: un carattere per sedicesimo. 0-9 e a-e sono gradi della scala (7 = ottava sopra), "." prolunga, "-" pausa.
 * Basso: "x" fondamentale dell'accordo, "o" quinta, "8" ottava, "." prolunga, "-" pausa.
 */
interface Track {
  bpm: number;
  /** Nota MIDI della tonica, all'ottava del basso più uno. */
  root: number;
  scale: number[];
  /** Grado della scala su cui poggia l'accordo di ogni battuta. */
  chords: number[];
  lead: string[];
  leadWave: Wave;
  leadVol: number;
  bass: string;
  bassWave: Wave;
  /** Arpeggio sulle note dell'accordo, ogni `every` sedicesimi. */
  arp?: { wave: Wave; every: number; vol: number };
  /** Accordo tenuto per tutta la battuta. */
  pad?: { wave: Wave; vol: number };
  drums?: { kick: string; snare: string; hat: string };
  echo: number;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

const TRACKS: Record<TrackId, Track> = {
  taverna: {
    bpm: 104,
    root: 53, // Fa
    scale: MAJOR,
    chords: [0, 5, 3, 4, 0, 5, 1, 4],
    lead: [
      "4...2.4.7...4...",
      "5...4.2.0.......",
      "3...5.3.0.1.3...",
      "4.......6.4.1...",
      "4...2.4.7.9.7...",
      "9.8.7...5.......",
      "5.4.3.1.3...5...",
      "6...4...1...-...",
    ],
    leadWave: "pulse25",
    leadVol: 0.1,
    bass: "x...o...x.o.o...",
    bassWave: "triangle",
    drums: { kick: "x.......x.......", snare: "----------------", hat: "..x...x...x...x." },
    echo: 0.18,
  },
  grotta: {
    bpm: 88,
    root: 50, // Re minore
    scale: MINOR,
    chords: [0, 0, 6, 6, 5, 5, 4, 4],
    lead: [
      "7.......9...a...",
      "9...7...4.......",
      "8...6...3...4...",
      "3...............",
      "5...7...9...7...",
      "c.......b...9...",
      "b...8...6...4...",
      "4.......1...-...",
    ],
    leadWave: "triangle",
    leadVol: 0.13,
    bass: "x.......x...o...",
    bassWave: "triangle",
    arp: { wave: "pulse12", every: 1, vol: 0.035 },
    drums: { kick: "x...............", snare: "----------------", hat: "........x......." },
    echo: 0.42,
  },
  biblioteca: {
    bpm: 70,
    root: 48, // Do
    scale: MAJOR,
    chords: [0, 3, 0, 3, 5, 3, 4, 4],
    lead: [
      "4.......2...4...",
      "5.......3.......",
      "4...2...0...2...",
      "3...............",
      "2...4...7.......",
      "8...7...5...3...",
      "4.......6.......",
      "6.......4.......",
    ],
    leadWave: "sine",
    leadVol: 0.14,
    bass: "x...............",
    bassWave: "sine",
    arp: { wave: "triangle", every: 4, vol: 0.05 },
    pad: { wave: "triangle", vol: 0.025 },
    echo: 0.4,
  },
  forziere: {
    bpm: 138,
    root: 55, // Sol
    scale: MAJOR,
    chords: [0, 4, 5, 3, 0, 4, 3, 4],
    lead: [
      "4.4.7.4.2...4...",
      "4.5.4.2.1...-...",
      "2.2.5.2.0...2...",
      "3.2.0.2.3...5...",
      "7.7.9.7.4...7...",
      "8.7.6.4.5...4...",
      "3.4.5.7.8.7.5.3.",
      "4.......1.2.3.4.",
    ],
    leadWave: "pulse25",
    leadVol: 0.09,
    bass: "x.8.x.8.o.8.x.8.",
    bassWave: "square",
    drums: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "..x...x...x...x." },
    echo: 0.14,
  },
};

const degree = (tr: Track, d: number, base: number) => {
  const n = tr.scale.length;
  return base + 12 * Math.floor(d / n) + tr.scale[((d % n) + n) % n];
};

const parseDegree = (c: string): number | undefined => {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "a" && c <= "e") return c.charCodeAt(0) - 87;
  return undefined;
};

/** Lunghezza in sedicesimi della nota che parte in `i`: fino al prossimo simbolo che non sia ".". */
const span = (bar: string, i: number) => {
  let j = i + 1;
  while (j < bar.length && bar[j] === ".") j++;
  return j - i;
};

let playing: { id: TrackId; timer: number; step: number; next: number } | undefined;

function scheduleStep(g: Graph, tr: Track, step: number, t: number): void {
  const sd = 60 / tr.bpm / 4;
  const bar = Math.floor(step / 16) % tr.chords.length;
  const s = step % 16;
  const chord = tr.chords[bar];
  const out = g.music;
  // la tonica sta al centro; basso un'ottava sotto, melodia un'ottava sopra
  const bassBase = tr.root - 12;
  const leadBase = tr.root + 12;

  const lc = tr.lead[bar][s];
  const ld = parseDegree(lc);
  if (ld !== undefined) tone(g, out, tr.leadWave, hz(degree(tr, ld, leadBase)), t, span(tr.lead[bar], s) * sd * 0.92, tr.leadVol, { echo: tr.echo });

  const bc = tr.bass[s];
  if (bc === "x" || bc === "o" || bc === "8") {
    const d = chord + (bc === "o" ? 4 : bc === "8" ? 7 : 0);
    tone(g, out, tr.bassWave, hz(degree(tr, d, bassBase)), t, span(tr.bass, s) * sd * 0.9, 0.16);
  }

  if (tr.arp && s % tr.arp.every === 0) {
    const tones = [0, 2, 4, 7, 4, 2];
    const i = (s / tr.arp.every) % tones.length;
    tone(g, out, tr.arp.wave, hz(degree(tr, chord + tones[i], tr.root)), t, sd * tr.arp.every * 0.8, tr.arp.vol, { echo: tr.echo });
  }

  if (tr.pad && s === 0) {
    for (const d of [0, 2, 4]) tone(g, out, tr.pad.wave, hz(degree(tr, chord + d, tr.root)), t, sd * 16, tr.pad.vol, { attack: 0.4 });
  }

  if (tr.drums) {
    if (tr.drums.kick[s] === "x") tone(g, out, "sine", 130, t, 0.16, 0.32, { slideTo: 42 });
    if (tr.drums.snare[s] === "x") noiseHit(g, out, t, 0.12, 0.09, "bandpass", 1900);
    if (tr.drums.hat[s] === "x") noiseHit(g, out, t, 0.035, 0.035, "highpass", 7500);
  }
}

function startMusic(id: TrackId): void {
  const g = graph;
  if (!g) return;
  stopMusic();
  const tr = TRACKS[id];
  if (CLIPS) {
    playing = { id, step: 0, next: 0, timer: 0 };
    void clip(`music:${id}`, () => renderMusic(tr)).then((url) => {
      if (playing?.id !== id || !musicEl) return;
      musicEl.src = url;
      applyVolumes();
      void musicEl.play().catch(() => undefined);
    });
    return;
  }
  const state = { id, step: 0, next: g.ctx.currentTime + 0.12, timer: 0 };
  // pianificazione in anticipo: il timer di JS non è preciso, l'orologio audio sì
  state.timer = window.setInterval(() => {
    while (state.next < g.ctx.currentTime + 0.15) {
      scheduleStep(g, tr, state.step, state.next);
      state.next += 60 / tr.bpm / 4;
      state.step++;
    }
  }, 30);
  playing = state;
}

function stopMusic(): void {
  if (playing) clearInterval(playing.timer);
  playing = undefined;
  musicEl?.pause();
}

function syncMusic(): void {
  const want = unlocked && graph && !settings.muted && settings.music !== "off" ? settings.music : undefined;
  if (want === playing?.id) return;
  if (want) startMusic(want);
  else stopMusic();
}

// ---------- Effetti ----------

export type Sfx = "select" | "confirm" | "next" | "back" | "choice" | "step" | "board" | "ask" | "answer" | "menu" | "end" | "error";

/** Note di un effetto: [onda, frequenza, inizio, durata, volume, opzioni]. */
type Note = [Wave, number, number, number, number, ToneOpts?];

const SFX: Record<Exclude<Sfx, "step">, Note[]> = {
  select: [["pulse25", 1046, 0, 0.05, 0.12]],
  confirm: [
    ["pulse25", 784, 0, 0.06, 0.12],
    ["pulse25", 1046, 0.06, 0.06, 0.12],
    ["pulse25", 1568, 0.12, 0.14, 0.12, { echo: 0.3 }],
  ],
  next: [["triangle", 1175, 0, 0.05, 0.16]],
  back: [["triangle", 880, 0, 0.05, 0.16]],
  choice: [
    ["pulse12", 988, 0, 0.06, 0.1],
    ["pulse12", 1319, 0.07, 0.1, 0.1, { echo: 0.25 }],
  ],
  board: [
    ["triangle", 1568, 0, 0.08, 0.12, { echo: 0.4 }],
    ["triangle", 2093, 0.06, 0.08, 0.1, { echo: 0.4 }],
    ["triangle", 2637, 0.12, 0.16, 0.08, { echo: 0.4 }],
  ],
  ask: [["pulse25", 440, 0, 0.14, 0.1, { slideTo: 990 }]],
  answer: [
    ["triangle", 1319, 0, 0.18, 0.14, { echo: 0.35 }],
    ["triangle", 1760, 0.09, 0.3, 0.12, { echo: 0.35 }],
  ],
  menu: [
    ["pulse25", 523, 0, 0.06, 0.1],
    ["pulse25", 659, 0.06, 0.1, 0.1],
  ],
  // piccola fanfara di fine livello
  end: [
    ["pulse25", 523, 0, 0.1, 0.11],
    ["pulse25", 659, 0.1, 0.1, 0.11],
    ["pulse25", 784, 0.2, 0.1, 0.11],
    ["pulse25", 1046, 0.3, 0.45, 0.12, { echo: 0.3 }],
    ["triangle", 262, 0.3, 0.45, 0.14],
  ],
  error: [
    ["square", 220, 0, 0.09, 0.08],
    ["square", 185, 0.1, 0.16, 0.08],
  ],
};

export function play(name: Sfx): void {
  const g = graph;
  if (!g || !unlocked || settings.muted || settings.sfxVolume === 0) return;
  if (CLIPS) return clipSound(`sfx:${name}`, (c) => drawSfx(c, name, 0.01));
  drawSfx(g, name, g.ctx.currentTime + 0.01);
}

function drawSfx(g: Graph, name: Sfx, t: number): void {
  if (name === "step") {
    // due passi della mini guida tra i file
    noiseHit(g, g.sfx, t, 0.05, 0.12, "lowpass", 900);
    noiseHit(g, g.sfx, t + 0.16, 0.05, 0.1, "lowpass", 800);
    return;
  }
  for (const [wave, f, at, dur, vol, o] of SFX[name]) tone(g, g.sfx, wave, f, t + at, dur, vol, o);
}

// ---------- Voce della guida ----------

/** Timbro e altezza di ogni guida; l'immagine dell'utente ha una voce sua. */
const VOICES: Record<string, { wave: Wave; base: number }> = {
  lumen: { wave: "triangle", base: 830 },
  aria: { wave: "pulse25", base: 620 },
  patrizio: { wave: "square", base: 300 },
  nilo: { wave: "pulse12", base: 440 },
  custom: { wave: "pulse25", base: 520 },
};

const MOOD: Record<Expression, number> = { neutro: 1, felice: 1.12, pensieroso: 0.93, sorpreso: 1.25, preoccupato: 0.85 };

let lastBlip = 0;

/** Un bip della voce: chiamalo mentre il testo compare, viene limitato a uno ogni ~60 ms. */
export function blip(guide: string, expression: Expression): void {
  const g = graph;
  if (!g || !unlocked || settings.muted || !settings.voice || settings.sfxVolume === 0) return;
  const now = performance.now() / 1000;
  if (now - lastBlip < 0.06) return;
  lastBlip = now;
  const v = VOICES[guide] ?? VOICES.custom;
  // un po' di variazione: sembra che parli, non che suoni una nota sola
  const f = Math.round(v.base * MOOD[expression] * [1, 1, 1.06, 0.95, 1.12][Math.floor(Math.random() * 5)]);
  if (CLIPS) return clipSound(`blip:${v.wave}:${f}`, (c) => tone(c, c.sfx, v.wave, f, 0.005, 0.045, 0.09));
  tone(g, g.sfx, v.wave, f, g.ctx.currentTime + 0.005, 0.045, 0.09);
}

// ---------- Tasti ----------

export type KeyKind = "key" | "space" | "enter" | "back";

/**
 * Tasto di una tastiera meccanica morbida: un clic breve e attutito (rumore filtrato) sopra un colpo
 * grave che dà corpo. Altezza e volume cambiano di poco a ogni tasto, così non sembra una mitragliatrice.
 * Spazio e Invio più pieni e gravi, Cancella più leggero.
 */
const KEY_SOUND: Record<KeyKind, { click: number; thump: number; vol: number; dur: number }> = {
  key: { click: 2600, thump: 190, vol: 1, dur: 0.028 },
  back: { click: 3200, thump: 230, vol: 0.75, dur: 0.022 },
  space: { click: 1700, thump: 130, vol: 1.15, dur: 0.04 },
  enter: { click: 1500, thump: 115, vol: 1.3, dur: 0.05 },
};

let lastKey = 0;

export function keyClick(kind: KeyKind, repeat = false): void {
  const g = graph;
  if (!g || !unlocked || settings.muted || !settings.keys || settings.sfxVolume === 0) return;
  const now = performance.now() / 1000;
  // tasto tenuto premuto o raffica: al massimo un clic ogni 35 ms, e più piano
  if (now - lastKey < 0.035) return;
  lastKey = now;
  const vol = (repeat ? 0.55 : 1) * (0.85 + Math.random() * 0.3);
  if (CLIPS) {
    // quattro varianti d'altezza per tasto, calcolate una volta; il volume cambia sull'elemento
    const v = Math.floor(Math.random() * 4);
    return clipSound(`key:${kind}:${v}`, (c) => drawKey(c, kind, 0.94 + v * 0.04, 1, 0.003), vol);
  }
  drawKey(g, kind, 1 + (Math.random() - 0.5) * 0.12, vol, g.ctx.currentTime + 0.003);
}

function drawKey(g: Graph, kind: KeyKind, jitter: number, gain: number, t: number): void {
  const k = KEY_SOUND[kind];
  const vol = k.vol * gain;
  // clic: rumore passa-banda, attacco immediato e coda cortissima
  const src = g.ctx.createBufferSource();
  src.buffer = g.noise;
  const band = g.ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = k.click * jitter;
  band.Q.value = 1.2;
  const soft = g.ctx.createBiquadFilter();
  soft.type = "lowpass";
  soft.frequency.value = 5000;
  const env = g.ctx.createGain();
  env.gain.setValueAtTime(0.0005, t);
  env.gain.linearRampToValueAtTime(0.09 * vol, t + 0.001);
  env.gain.exponentialRampToValueAtTime(0.0005, t + k.dur);
  src.connect(band).connect(soft).connect(env).connect(g.sfx);
  src.start(t, Math.random() * 0.8);
  src.stop(t + k.dur + 0.02);
  // corpo: un colpo grave che scende subito (il "thock" del tasto che tocca il fondo)
  tone(g, g.sfx, "sine", k.thump * jitter, t, k.dur * 1.6, 0.07 * vol, { attack: 0.002, slideTo: k.thump * 0.7 });
}

// ---------- Ciclo di vita ----------

export function configure(s: SoundSettings): void {
  settings = { ...s };
  applyVolumes();
  syncMusic();
}

/**
 * Da chiamare a ogni gesto dell'utente finché non risolve true: prima il browser non permette di suonare.
 * Alcuni motori (WebKitGTK dell'app su Linux) non accettano ogni gesto: si riprova al successivo.
 */
export async function unlock(): Promise<boolean> {
  graph ??= build();
  if (!graph) return true;
  if (CLIPS) return unlockClips();
  unlocked = true;
  try {
    await Promise.race([live!.resume(), new Promise((r) => setTimeout(r, 300))]);
  } catch {
    // resume rifiutato: si riprova al prossimo gesto
  }
  applyVolumes();
  syncMusic();
  return live!.state === "running";
}

// finestra nascosta: musica in pausa (l'orologio audio si ferma e riparte da dove era)
document.addEventListener("visibilitychange", () => {
  if (!graph || !unlocked) return;
  if (CLIPS) {
    if (document.hidden) musicEl?.pause();
    else if (playing && musicEl?.src) void musicEl.play().catch(() => undefined);
  } else if (document.hidden) void live?.suspend();
  else void live?.resume();
});

// ---------- Uscita a clip (app su Linux) ----------

const CLIP_RATE = 44100;
/** Elementi che suonano gli effetti, a turno: più suoni insieme senza aprire un elemento per suono. */
const POOL_SIZE = 8;
const pool: HTMLAudioElement[] = [];
let poolNext = 0;
let musicEl: HTMLAudioElement | undefined;
const clips = new Map<string, Promise<string>>();

/** Calcola una volta il suono `key` e ne tiene l'indirizzo del WAV in memoria. */
function clip(key: string, render: () => Promise<Float32Array>): Promise<string> {
  let p = clips.get(key);
  if (!p) {
    p = render().then((data) => URL.createObjectURL(wavBlob(data)));
    clips.set(key, p);
  }
  return p;
}

/** Disegna un suono breve su un contesto di calcolo; il silenzio in coda si taglia. */
async function renderShort(draw: (g: Graph) => void, seconds = 2): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * CLIP_RATE), CLIP_RATE);
  const g = wire(ctx);
  draw(g);
  const data = (await ctx.startRendering()).getChannelData(0);
  let end = data.length;
  while (end > 0 && Math.abs(data[end - 1]) < 0.0003) end--;
  return data.slice(0, Math.max(end, 1));
}

/** Un giro intero del brano; la coda dell'eco oltre la fine si somma all'inizio, così il loop non si sente. */
async function renderMusic(tr: Track): Promise<Float32Array> {
  const sd = 60 / tr.bpm / 4;
  const steps = tr.chords.length * 16;
  const len = Math.round(steps * sd * CLIP_RATE);
  const ctx = new OfflineAudioContext(1, len + 4 * CLIP_RATE, CLIP_RATE);
  const g = wire(ctx);
  g.music.gain.value = 0.9;
  for (let i = 0; i < steps; i++) scheduleStep(g, tr, i, i * sd);
  const all = (await ctx.startRendering()).getChannelData(0);
  const out = all.slice(0, len);
  for (let i = len; i < all.length; i++) out[(i - len) % len] += all[i];
  return out;
}

function wavBlob(data: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + data.length * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, CLIP_RATE, true);
  v.setUint32(28, CLIP_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), true);
  return new Blob([buf], { type: "audio/wav" });
}

/** Suona un effetto dal pool, al volume degli effetti (per `gain` in più). */
function clipSound(key: string, draw: (g: Graph) => void, gain = 1): void {
  void clip(key, () => renderShort(draw)).then((url) => {
    if (settings.muted) return;
    const a = pool[poolNext++ % pool.length];
    if (!a) return;
    a.src = url;
    a.volume = Math.min(1, level(settings.sfxVolume) * gain);
    void a.play().catch(() => undefined);
  });
}

/** Un istante di silenzio da far partire durante il gesto: da lì il motore lascia suonare questi elementi. */
let silence: string | undefined;

async function unlockClips(): Promise<boolean> {
  silence ??= URL.createObjectURL(wavBlob(new Float32Array(441)));
  if (!musicEl) {
    musicEl = document.createElement("audio");
    musicEl.className = "cd-music";
    musicEl.loop = true;
    musicEl.hidden = true;
    document.body.append(musicEl);
    for (let i = 0; i < POOL_SIZE; i++) pool.push(new Audio());
  }
  const els = [musicEl, ...pool];
  const ok = await Promise.all(
    els.map((a) => {
      if (a.src && a.src !== silence) return true;
      a.src = silence!;
      return a.play().then(
        () => true,
        () => false,
      );
    }),
  );
  if (!ok.every(Boolean)) return false;
  unlocked = true;
  applyVolumes();
  syncMusic();
  // effetti pronti prima che servano: il primo clic non aspetta il calcolo
  for (const name of Object.keys(SFX) as Sfx[]) void clip(`sfx:${name}`, () => renderShort((c) => drawSfx(c, name, 0.01)));
  return true;
}
