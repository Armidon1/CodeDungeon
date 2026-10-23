// Suoni del gioco, tutti sintetizzati con Web Audio: musiche chiptune, effetti dell'interfaccia
// e la voce della guida (un bip a ogni sillaba, come nei Mystery Dungeon).
// Nessun file audio: niente licenze da gestire e la demo resta un file unico.

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
  /** Tutto spento (pulsante nella barra o tasto M). */
  muted: boolean;
}

export const SOUND_DEFAULTS: SoundSettings = { music: "taverna", musicVolume: 0.5, sfxVolume: 0.7, voice: true, muted: false };

const unit = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

export function cleanSound(raw: unknown): SoundSettings {
  const s = (raw ?? {}) as Partial<SoundSettings>;
  return {
    music: s.music === "off" || TRACK_IDS.includes(s.music as TrackId) ? (s.music as SoundSettings["music"]) : SOUND_DEFAULTS.music,
    musicVolume: unit(s.musicVolume, SOUND_DEFAULTS.musicVolume),
    sfxVolume: unit(s.sfxVolume, SOUND_DEFAULTS.sfxVolume),
    voice: typeof s.voice === "boolean" ? s.voice : SOUND_DEFAULTS.voice,
    muted: s.muted === true,
  };
}

// ---------- Motore ----------

type Wave = OscillatorType | "pulse25" | "pulse12";

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  /** Ingresso dell'eco (delay con ritorno), condiviso da musica ed effetti. */
  echo: GainNode;
  noise: AudioBuffer;
  pulses: Map<number, PeriodicWave>;
}

let graph: Graph | undefined;
let settings: SoundSettings = { ...SOUND_DEFAULTS };
/** Il browser fa suonare solo dopo un gesto dell'utente (clic o tasto). */
let unlocked = false;

function build(): Graph | undefined {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return undefined;
  const ctx = new AC();
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
  const t = g.ctx.currentTime + 0.01;
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
  const now = g.ctx.currentTime;
  if (now - lastBlip < 0.06) return;
  lastBlip = now;
  const v = VOICES[guide] ?? VOICES.custom;
  // un po' di variazione: sembra che parli, non che suoni una nota sola
  const f = v.base * MOOD[expression] * [1, 1, 1.06, 0.95, 1.12][Math.floor(Math.random() * 5)];
  tone(g, g.sfx, v.wave, f, now + 0.005, 0.045, 0.09);
}

// ---------- Ciclo di vita ----------

export function configure(s: SoundSettings): void {
  settings = { ...s };
  applyVolumes();
  syncMusic();
}

/** Da chiamare al primo gesto dell'utente: prima il browser non permette di suonare. */
export function unlock(): void {
  graph ??= build();
  if (!graph) return;
  unlocked = true;
  void graph.ctx.resume();
  applyVolumes();
  syncMusic();
}

// finestra nascosta: musica in pausa (l'orologio audio si ferma e riparte da dove era)
document.addEventListener("visibilitychange", () => {
  if (!graph || !unlocked) return;
  if (document.hidden) void graph.ctx.suspend();
  else void graph.ctx.resume();
});
