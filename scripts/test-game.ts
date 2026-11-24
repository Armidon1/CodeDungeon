// Prova del gioco nel browser: avvia il ponte in modalità play sul progetto d'esempio, apre Chromium headless
// e lo pilota via DevTools Protocol (menu, tour, modalità chat e storico salvato, divisori, modalità tutor, layout a 1400 e a 390 px).
// Il progetto è una copia temporanea: la modalità tutor ci scrive.
//   npm run build:game && npm run test:game
// Il browser si sceglie con CHROME_PATH; altrimenti si cerca chromium o google-chrome nel PATH.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const PORT = 7400 + Math.floor(Math.random() * 500);
const URL_GAME = `http://127.0.0.1:${PORT}/`;

if (!existsSync("dist/game/index.html")) {
  console.error("Manca dist/game: esegui prima npm run build:game.");
  process.exit(2);
}

function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
  }
  console.error("Chromium non trovato: installalo o indica il percorso con CHROME_PATH.");
  process.exit(2);
}

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "code-dungeon-game-"));
const children: ChildProcess[] = [];
const cleanup = async () => {
  for (const c of children) c.kill();
  await sleep(200);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
};

// ---------- ponte ----------

const project = path.join(tmp, "packet-server");
await fs.cp(path.resolve("examples/packet-server"), project, { recursive: true });
// lacune e conversazioni sono dati locali di chi prova il gioco: il test parte da un registro vuoto
await fs.rm(path.join(project, ".tour", "lacune.json"), { force: true });
await fs.rm(path.join(project, ".tour", "conversazioni"), { recursive: true, force: true });
// cartelle annidate per l'albero dei file
await fs.mkdir(path.join(project, "lib", "deep"), { recursive: true });
await fs.writeFile(path.join(project, "lib", "util.py"), "def aiuto():\n    return 1\n");
await fs.writeFile(path.join(project, "lib", "deep", "inner.py"), "from ..util import aiuto\nX = 2\n");
// file in altri linguaggi per l'evidenziazione
await fs.writeFile(path.join(project, "lib", "deep", "vuln.c"), '#include <stdio.h>\n/* buffer\n   piccolo */\nint main(void) {\n  char buf[8]; // pila\n  printf("%s\\n", buf);\n  return 0;\n}\n');
await fs.writeFile(path.join(project, "lib", "deep", "page.html"), '<!-- pagina -->\n<a href="/x">ciao</a>\n<script>\nconst n = 1;\n</script>\n');

// modalità mcp con lo stdin aperto e muto: il gioco vede un agente collegato e le domande partono davvero
const server = spawn("npx", ["tsx", "src/server/cli.ts", "mcp", "--project", project, "--port", String(PORT)], {
  env: { ...process.env, CODE_DUNGEON_DATA: path.join(tmp, "data") },
  stdio: ["pipe", "pipe", "pipe"],
});
children.push(server);
// l'agente finto parla MCP (2025) sullo stdin: serve per mandare al gioco i comandi degli strumenti
let rpcId = 0;
const rpcWaiting = new Map<number, (msg: any) => void>();
let rpcBuf = "";
server.stdout!.on("data", (d) => {
  rpcBuf += String(d);
  let nl: number;
  while ((nl = rpcBuf.indexOf("\n")) >= 0) {
    const line = rpcBuf.slice(0, nl);
    rpcBuf = rpcBuf.slice(nl + 1);
    try {
      const msg = JSON.parse(line);
      rpcWaiting.get(msg.id)?.(msg);
      rpcWaiting.delete(msg.id);
    } catch {}
  }
});
const rpc = (method: string, params: unknown): Promise<any> => {
  const id = ++rpcId;
  server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => rpcWaiting.set(id, resolve));
};
let mcpReady: Promise<unknown> | undefined;
const callTool = async (name: string, args: unknown): Promise<any> => {
  mcpReady ??= rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-game", version: "0" } }).then(() =>
    server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"),
  );
  await mcpReady;
  return (await rpc("tools/call", { name, arguments: args })).result;
};
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("il ponte non parte")), 30_000);
  server.stderr!.on("data", (d) => {
    if (String(d).includes("gioco su")) {
      clearTimeout(timer);
      resolve();
    }
  });
});

// ---------- browser ----------

const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${path.join(tmp, "chrome")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--window-size=1400,900",
    // i runner di CI girano come root senza sandbox utente
    ...(process.env.CI ? ["--no-sandbox"] : []),
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
children.push(chrome);
const browserWs = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Chromium non risponde")), 30_000);
  chrome.stderr!.on("data", (d) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
});

const ws = new WebSocket(browserWs);
await new Promise((r) => ws.once("open", r));
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const errors: string[] = [];
const dialogs: string[] = [];
ws.on("message", (d) => {
  const msg = JSON.parse(String(d));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  } else if (msg.method === "Page.javascriptDialogOpening") {
    // es. "lasciare la pagina?" con modifiche non salvate: si conta e si accetta, se no la navigazione resta ferma
    dialogs.push(msg.params.type);
    void send("Page.handleJavaScriptDialog", { accept: true });
  } else if (msg.method === "Runtime.exceptionThrown") {
    errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
});
let sessionId: string | undefined;
const send = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
await send("Runtime.enable");
await send("Page.enable");

/** Valuta un'espressione nella pagina e ne restituisce il valore. */
const evaluate = async <T = any>(expression: string): Promise<T> => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value as T;
};
const waitFor = async (expression: string, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate<boolean>(`!!(${expression})`).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
};
const KEYS: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, Backspace: 8 };
/** modifiers: 2 = Ctrl, 8 = Maiusc. */
const press = async (key: string, modifiers = 0) => {
  const code = KEYS[key] ?? (key === "Tab" ? 9 : key.toUpperCase().charCodeAt(0));
  const text = key.length === 1 && !(modifiers & 2) ? key : key === "Enter" ? "\r" : undefined;
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, windowsVirtualKeyCode: code, text, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, modifiers });
  await sleep(120);
};
const typeText = async (text: string) => {
  await send("Input.insertText", { text });
  await sleep(150);
};
const click = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const rightClick = async (selector: string) => {
  const { x, y } = await evaluate<{ x: number; y: number }>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
};
// larghezza emulata: con l'emulazione mobile Chromium allarga innerWidth fino al contenuto che sborda
let screenW = 1400;
let screenH = 900;
const viewport = async (width: number, height: number) => {
  screenW = width;
  screenH = height;
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(300);
};
const load = async () => {
  await send("Page.navigate", { url: URL_GAME });
  return waitFor(`document.readyState === "complete" && !document.getElementById("title-screen").hidden`, 10_000);
};
/**
 * Niente esce di lato dalla finestra. La pagina taglia ciò che sborda (scrollWidth non cresce), quindi si cercano
 * gli elementi visibili oltre i bordi che non stanno dentro un contenitore con scorrimento proprio entro la finestra.
 */
const overflowing = () =>
  evaluate<string[]>(`(() => {
    const W = ${screenW} + 1;
    const contained = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== "visible") {
          const r = a.getBoundingClientRect();
          return r.left >= -1 && r.right <= W;
        }
      }
      return false;
    };
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if ((r.right > W || r.left < -1) && !contained(el)) out.push((el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + el.classList[0]) + " " + Math.round(r.left) + "→" + Math.round(r.right));
    }
    return out.slice(0, 5);
  })()`);
/** Conta solo i disegni sui due canvas animati durante la finestra di osservazione. */
const portraitDraws = (ms: number) => evaluate<{ title: number; game: number }>(`(async () => {
  const counts = { title: 0, game: 0 };
  const proto = CanvasRenderingContext2D.prototype;
  const clear = proto.clearRect;
  proto.clearRect = function (...args) {
    if (this.canvas.id === "title-portrait") counts.title++;
    if (this.canvas.id === "portrait") counts.game++;
    return clear.apply(this, args);
  };
  try {
    await new Promise(resolve => setTimeout(resolve, ${ms}));
    return counts;
  } finally { proto.clearRect = clear; }
})()`);
const fillsWindow = () => evaluate<boolean>(`(() => {
  const r = document.getElementById("app").getBoundingClientRect();
  return r.left === 0 && r.top === 0 && r.right === ${screenW} && r.bottom === ${screenH};
})()`);
const noOverflow = async () => {
  const out = await overflowing();
  if (out.length) console.log(`     oltre il bordo: ${out.join(", ")}`);
  return out.length === 0;
};
/** L'elemento è tutto dentro la finestra. */
const inView = (id: string) =>
  evaluate<boolean>(`(() => {
    const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= ${screenH} + 1 && r.right <= ${screenW} + 1;
  })()`);

try {
  // ---------- desktop ----------
  await viewport(1400, 900);
  check(await load(), "il gioco si apre sul menu");
  check(await noOverflow(), "menu senza scorrimento orizzontale a 1400 px");
  const idle = await portraitDraws(2100);
  check(idle.game === 0 && idle.title > 0 && idle.title < 10,
    `nel menu in 2,1 s il ritratto visibile si aggiorna ${idle.title} volte, quello coperto ${idle.game}`);

  await viewport(3440, 1440);
  await click("#opt-frame-classica");
  check(await evaluate(`document.body.classList.contains("frame-classica") && document.getElementById("app").getBoundingClientRect().left > 0`), "la finestra classica resta centrata su ultrawide");
  await click("#opt-frame-larga");
  check(await fillsWindow(), "la finestra larga copre tutti i 3440 × 1440 pixel");
  await viewport(1400, 900);

  await evaluate(`document.querySelector(".menu-tab[aria-selected=true]").focus()`);
  const firstTab = await evaluate<string>(`document.activeElement.id`);
  await press("ArrowRight");
  const tabState = await evaluate<{ id: string; panel: boolean }>(`(() => {
    const tab = document.querySelector(".menu-tab[aria-selected=true]");
    return { id: tab.id, panel: !document.getElementById(tab.getAttribute("aria-controls")).hidden };
  })()`);
  check(tabState.id !== firstTab && tabState.panel, "le frecce cambiano scheda del menu e mostrano il suo pannello");

  const enterEn = await evaluate<string>(`document.getElementById("start-btn").textContent`);
  await click(`#lang-options input[value="it"]`);
  await sleep(200);
  const enterIt = await evaluate<string>(`document.getElementById("start-btn").textContent`);
  check(enterIt && enterIt !== enterEn && (await evaluate(`document.documentElement.lang`)) === "it", "il cambio di lingua traduce l'interfaccia senza ricaricare");

  await click("#start-btn");
  check(await waitFor(`document.getElementById("title-screen").hidden`), "Inizia chiude il menu");
  check(await waitFor(`document.getElementById("dialog-text").textContent.trim().length > 0`, 8000), "parte il primo tour con il fumetto della guida");
  check(await waitFor(`document.querySelector("#tabs [role=tab], #tabs .tab")`), "il tour apre un file nell'editor");
  check(await noOverflow(), "editor senza scorrimento orizzontale a 1400 px");
  const inGame = await portraitDraws(2000);
  check(inGame.title === 0 && inGame.game > 0, "entrando nel tour si anima solo il ritratto di gioco");

  // modalità chat
  await evaluate(`document.activeElement?.blur()`);
  await press("c");
  check(await evaluate(`document.getElementById("app").classList.contains("is-chat")`), "il tasto C apre la modalità chat");
  await press("ArrowRight");
  await press("ArrowRight");
  check(await waitFor(`document.querySelectorAll("#chat-log .chat-msg").length > 0`), "i fumetti passati finiscono nello storico della chat");
  check(await inView("ask-input"), "in chat il campo della domanda resta visibile");

  const dialogH = () => evaluate<number>(`Math.round(document.getElementById("dialog").getBoundingClientRect().height)`);
  const before = await dialogH();
  await evaluate(`document.getElementById("split-dialog").focus()`);
  await press("ArrowUp");
  await press("ArrowUp");
  check((await dialogH()) > before, "il divisore della chat ingrandisce il fumetto con le frecce");
  for (let i = 0; i < 8; i++) await press("ArrowUp");
  check(
    await evaluate(`(() => { const d = document.getElementById("dialog").getBoundingClientRect(); const a = document.getElementById("ask-form").getBoundingClientRect(); const t = document.getElementById("dialog-text").getBoundingClientRect(); return d.bottom - a.bottom < 40 && t.height > 160; })()`),
    "col fumetto ingrandito la domanda resta in fondo e il testo si allarga",
  );

  await load();
  check(await evaluate(`document.getElementById("app").classList.contains("is-chat")`), "la modalità chat resta dopo il ricaricamento");
  check(await evaluate(`document.documentElement.lang === "it"`), "la lingua resta dopo il ricaricamento");
  check(
    await waitFor(`document.querySelectorAll("#chat-log .chat-msg").length > 0 && !!document.querySelector("#chat-log .chat-sep")`),
    "lo storico della chat resta dopo il ricaricamento, separato dai messaggi nuovi",
  );
  await click("#chat-clear");
  check(await evaluate(`document.querySelectorAll("#chat-log .chat-msg").length === 0 && !!document.querySelector("#chat-log .chat-empty")`), "Svuota cancella lo storico della chat");
  await load();
  check(await evaluate(`document.querySelectorAll("#chat-log .chat-msg").length === 0`), "lo storico svuotato resta vuoto dopo il ricaricamento");

  // ---------- telefono ----------
  await viewport(390, 844);
  check(await load(), "il gioco si apre a 390 px");
  check(await fillsWindow(), "la finestra larga occupa anche lo schermo a 390 px");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(200);
  const still = await portraitDraws(600);
  check(still.title === 0 && still.game === 0, "a 390 px i ritratti restano fermi con movimento ridotto");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  const moving = await portraitDraws(2100);
  check(moving.title > 0 && moving.game === 0, "a 390 px il ritratto visibile riprende quando torna il movimento");
  check(await noOverflow(), "menu senza scorrimento orizzontale a 390 px");
  await click("#start-btn");
  await waitFor(`document.getElementById("title-screen").hidden`);
  await waitFor(`document.getElementById("dialog-text").textContent.trim().length > 0`, 8000);
  check(await noOverflow(), "chat senza scorrimento orizzontale a 390 px");
  await evaluate(`document.activeElement?.blur()`);
  await press("ArrowRight");
  await press("ArrowRight");
  await waitFor(`document.querySelectorAll("#chat-log .chat-msg").length > 0`);
  await load();
  check(await waitFor(`!!document.querySelector("#chat-log .chat-sep")`), "a 390 px lo storico resta dopo il ricaricamento");
  check(await noOverflow(), "storico salvato senza scorrimento orizzontale a 390 px");
  await click("#start-btn");
  await waitFor(`document.getElementById("title-screen").hidden`);
  check(await inView("ask-input"), "a 390 px il campo della domanda resta visibile");
  await evaluate(`document.activeElement?.blur()`);
  await press("c");
  check(await evaluate(`!document.getElementById("app").classList.contains("is-chat")`), "il tasto C torna alla vista classica");
  check(await noOverflow(), "vista classica senza scorrimento orizzontale a 390 px");

  // ---------- modalità tutor ----------
  await viewport(1400, 900);
  await load();
  // le domande inviate al ponte, lette dal test
  await evaluate(`(() => {
    const send = WebSocket.prototype.send;
    window.__questions = [];
    WebSocket.prototype.send = function (d) {
      const m = JSON.parse(String(d));
      if (m.type === "question") window.__questions.push(m);
      return send.call(this, d);
    };
  })()`);
  const lastQuestion = () => evaluate<any>(`window.__questions.at(-1)`);
  await click(`#mode-options input[value="tutor"]`);
  await click("#start-btn");
  await waitFor(`document.getElementById("title-screen").hidden`);
  check(
    (await waitFor(`/tutor/i.test(document.getElementById("dialog-text").textContent)`, 8000)) &&
      (await evaluate(`!document.querySelector("#tabs .tab") && !document.getElementById("edit-bar").hidden`)),
    "in tutor Inizia non avvia un tour: saluto della guida e barra del file pronta",
  );
  await click(`#file-list .file[data-path="protocol.py"]`);
  await waitFor(`document.querySelector("#file-list .file.is-active")?.dataset.path === "protocol.py"`);
  check(await waitFor(`document.getElementById("code-input") && !document.getElementById("edit-bar").hidden`), "in tutor l'editor diventa modificabile, con la barra del file");
  const aligned = () =>
    evaluate<boolean>(`(() => {
      const ta = document.getElementById("code-input");
      const lines = document.querySelectorAll("#editor .line");
      const last = lines[lines.length - 1];
      const rows = ta.value.split("\\n").length;
      return rows === lines.length && Math.abs(ta.offsetTop - lines[0].offsetTop) <= 1 && Math.abs(ta.offsetTop + ta.offsetHeight - last.offsetTop - last.offsetHeight) <= 1;
    })()`);
  check(await aligned(), "la textarea è allineata alle righe evidenziate");
  const original = await fs.readFile(path.join(project, "protocol.py"), "utf8");
  const muted = await evaluate<string>(`document.getElementById("sound-btn").getAttribute("aria-pressed")`);
  await evaluate(`(() => { const ta = document.getElementById("code-input"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); })()`);
  await press("Enter");
  await typeText("def tutor():");
  await press("Enter");
  await press("Tab");
  await typeText("return \"prova\"");
  await press("m");
  check(await evaluate(`document.getElementById("sound-btn").getAttribute("aria-pressed")`) === muted, "il tasto M non scatta mentre si scrive nell'editor");
  check(await waitFor(`document.getElementById("edit-state").classList.contains("is-dirty")`), "si vede l'indicatore delle modifiche non salvate");
  check(await waitFor(`[...document.querySelectorAll("#editor .line code")].some((c) => c.textContent === '    return "prova"m')`), "le righe si ri-evidenziano mentre si scrive, Tab indenta");
  check(await aligned(), "la textarea resta allineata dopo le nuove righe");

  // Chiedi ▾ → Controlla: la domanda salva i file modificati e parte con il codice dell'editor e le righe cambiate
  await click("#edit-ask-btn");
  check(await waitFor(`!document.getElementById("edit-ask").hidden && document.getElementById("edit-actions").hidden`), "Chiedi apre le scelte rapide");
  await click(`#edit-ask [data-quick="check"]`);
  check(await waitFor(`document.activeElement?.id === "ask-input" && document.getElementById("ask-input").value.length > 0`), "Controlla precompila la domanda");
  await press("Enter");
  await waitFor(`window.__questions.length === 1`);
  const lines0 = original.split("\n").length;
  let q = await lastQuestion();
  check(
    q?.context.mode === "tutor" && q.context.buffer?.file === "protocol.py" && q.context.buffer.dirty === false &&
      q.context.buffer.content.endsWith('def tutor():\n    return "prova"m') &&
      JSON.stringify(q.context.changed) === JSON.stringify([[lines0 + 1, lines0 + 2]]),
    "la domanda in tutor porta il codice dell'editor e le righe cambiate",
  );
  check(
    (await fs.readFile(path.join(project, "protocol.py"), "utf8")) === original + '\ndef tutor():\n    return "prova"m' &&
      (await evaluate(`!document.getElementById("edit-state").classList.contains("is-dirty")`)),
    "fare una domanda salva il file (Invio mantiene l'indentazione)",
  );
  // Errore: si incolla l'output, compare sopra la domanda e parte con lei; le righe non sono cambiate
  await click("#edit-ask-btn");
  await click(`#edit-ask [data-quick="error"]`);
  check(await waitFor(`!document.getElementById("edit-error").hidden && document.activeElement?.id === "edit-error-output"`), "Errore apre il riquadro per incollare l'output");
  await typeText("NameError: name 'x' is not defined");
  await evaluate(`document.getElementById("edit-error").requestSubmit()`);
  check(
    await waitFor(`document.getElementById("edit-error").hidden && !document.getElementById("ask-sections").hidden && document.activeElement?.id === "ask-input"`),
    "l'output resta allegato sopra il campo della domanda",
  );
  await press("Enter");
  await waitFor(`window.__questions.length === 2`);
  q = await lastQuestion();
  check(/NameError/.test(q?.context.output) && !q.context.changed && (await evaluate(`document.getElementById("ask-sections").hidden`)), "l'output parte con la domanda, senza righe cambiate se il codice è lo stesso");
  await evaluate(`document.getElementById("code-input").focus()`);
  await typeText("#");
  await press("s", 2);
  check(await waitFor(`document.getElementById("edit-state").dataset.msg === "ok"`), "Ctrl+S salva il file");
  check((await fs.readFile(path.join(project, "protocol.py"), "utf8")).endsWith('"prova"m#'), "il file su disco ha il testo scritto");

  // file cambiato fuori: la domanda parte lo stesso ma non lo sovrascrive
  await fs.writeFile(path.join(project, "protocol.py"), "# cambiato fuori\n");
  await typeText("!");
  await evaluate(`(() => { const i = document.getElementById("ask-input"); i.value = "e ora?"; document.getElementById("ask-form").requestSubmit(); })()`);
  await waitFor(`window.__questions.length === 3`);
  check(
    (await waitFor(`document.getElementById("edit-state").dataset.msg === "error"`)) &&
      (await fs.readFile(path.join(project, "protocol.py"), "utf8")) === "# cambiato fuori\n" &&
      (await lastQuestion())?.context.buffer?.dirty === true,
    "se il file è cambiato su disco la domanda non lo sovrascrive e lo dice",
  );
  await evaluate(`document.getElementById("code-input").focus()`);
  await press("s", 2);
  check(await waitFor(`!document.getElementById("edit-confirm").hidden`), "se il file è cambiato su disco chiede prima di sovrascrivere");
  await click("#edit-overwrite");
  check(await waitFor(`document.getElementById("edit-state").dataset.msg === "ok"`), "Sovrascrivi salva");
  check((await fs.readFile(path.join(project, "protocol.py"), "utf8")).endsWith('"prova"m#!'), "il file sovrascritto ha il testo dell'editor");

  // segni della guida: ondina, pulsante nel margine col commento; seguono le righe e spariscono se le cambi
  const marked = await callTool("mark_lines", {
    path: "protocol.py",
    marks: [
      { line: 3, kind: "error", message: "Guarda le parentesi." },
      { line: 5, kind: "hint", message: "Ripassa gli import." },
    ],
  });
  check(!marked?.isError && (await waitFor(`document.querySelector('#editor .line[data-n="3"]').classList.contains("mark-error") && document.querySelector('#editor .line[data-n="5"]').classList.contains("mark-hint")`)), "mark_lines sottolinea le righe nell'editor");
  check(
    await evaluate(`(() => {
      const pin = document.querySelector('#editor .line[data-n="3"] .mark-pin');
      pin.scrollIntoView({ block: "center" });
      const r = pin.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === pin && !document.getElementById("edit-marks-clear").hidden;
    })()`),
    "il pulsante del segno sta sopra l'editor modificabile e compare Pulisci segni",
  );
  await evaluate(`document.querySelector('#editor .line[data-n="3"] .mark-pin').dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))`);
  check(await waitFor(`!document.getElementById("mark-note").hidden && /parentesi/.test(document.getElementById("mark-note").textContent)`), "al passaggio del mouse si legge il commento");
  // riga segnata in fondo all'editor: il commento si apre sopra, senza finire sotto il fumetto
  check(
    await evaluate(`(() => {
      const ed = document.getElementById("editor");
      const line = document.querySelector('#editor .line[data-n="3"]');
      ed.scrollTop = Math.max(0, line.offsetTop + line.offsetHeight - ed.clientHeight + 2);
      line.querySelector(".mark-pin").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      const n = document.getElementById("mark-note").getBoundingClientRect();
      const e = ed.getBoundingClientRect();
      return n.bottom <= e.bottom + 1 && n.top >= e.top - 1;
    })()`),
    "il commento di un segno in fondo all'editor resta visibile",
  );
  await evaluate(`(() => { const ta = document.getElementById("code-input"); ta.focus(); ta.setSelectionRange(0, 0); })()`);
  check(await waitFor(`document.getElementById("mark-note").hidden`), "il commento si chiude tornando a scrivere");
  await press("Enter");
  check(
    await waitFor(`document.querySelector('#editor .line[data-n="4"]').classList.contains("mark-error") && document.querySelector('#editor .line[data-n="6"]').classList.contains("mark-hint") && !document.querySelector('#editor .line[data-n="3"]').classList.contains("mark")`),
    "i segni seguono le righe quando ne aggiungi sopra",
  );
  await evaluate(`(() => { const ta = document.getElementById("code-input"); const lines = ta.value.split("\\n"); const end = lines.slice(0, 4).join("\\n").length; ta.setSelectionRange(end, end); })()`);
  await typeText(" ");
  check(
    await waitFor(`!document.querySelector('#editor .line.mark-error') && document.querySelector('#editor .line[data-n="6"]').classList.contains("mark-hint")`),
    "modificare una riga segnata toglie il suo segno, gli altri restano",
  );
  await click("#edit-marks-clear");
  check(await waitFor(`!document.querySelector('#editor .line.mark') && document.getElementById("edit-marks-clear").hidden`), "Pulisci segni toglie tutti i segni");
  await press("s", 2);
  await waitFor(`document.getElementById("edit-state").dataset.msg === "ok"`);

  // registro delle lacune: record_gap aggiorna il pannello "Da ripassare" e il numerino
  await callTool("record_gap", { concept: "Parentesi chiuse", example: "print((1)" });
  check(await waitFor(`document.getElementById("review-badge").textContent === "1" && !document.getElementById("review-badge").hidden`), "record_gap accende il numerino del pannello Da ripassare");
  await click(`.act-btn[data-panel="review"]`);
  check(await waitFor(`/Parentesi chiuse/.test(document.querySelector("#gap-list .gap-item")?.textContent ?? "")`), "il pannello mostra la lacuna con l'esempio");
  await click("#gap-list .gap-exercise");
  check(await waitFor(`/Parentesi chiuse/.test(document.getElementById("ask-input").value)`), "Esercizio prepara la domanda alla guida");
  await evaluate(`document.getElementById("ask-input").value = ""`);
  await click("#gap-list .gap-resolve");
  check(await waitFor(`document.querySelector("#gap-list .gap-item.is-resolved") && document.getElementById("review-badge").hidden`), "Capito sposta la lacuna tra le risolte");
  await click(`.act-btn[data-panel="files"]`);

  await click("#edit-new-btn");
  await evaluate(`document.getElementById("edit-new-name").value = "solve.py"`);
  await evaluate(`document.getElementById("edit-new").requestSubmit()`);
  check(await waitFor(`document.querySelector('#file-list .file.is-active')?.dataset.path === "solve.py"`), "Nuovo file crea e apre il file nella radice");
  check(existsSync(path.join(project, "solve.py")), "il nuovo file esiste su disco");
  check(await waitFor(`document.activeElement?.id === "code-input"`), "il nuovo file è pronto per scrivere (cursore nell'editor)");
  await typeText("print(1)");
  check(await evaluate(`document.querySelector("#editor .line code").textContent === "print(1)"`), "nel nuovo file si scrive");

  // albero dei file: cartelle chiuse di partenza, si aprono col clic, restano aperte dopo il ricaricamento
  const visible = (sel: string) => evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.getClientRects().length > 0; })()`);
  check(
    (await visible(`#file-list .dir[data-dir="lib"] .dir-btn`)) && !(await visible(`#file-list .file[data-path="lib/util.py"]`)),
    "le cartelle partono chiuse e non mostrano i loro file",
  );
  check(
    await evaluate(`[...document.querySelectorAll("#file-list > li")].findIndex((li) => li.dataset.dir === "lib") < [...document.querySelectorAll("#file-list > li")].findIndex((li) => li.querySelector('[data-path="protocol.py"]'))`),
    "le cartelle vengono prima dei file",
  );
  const libIcon = `document.querySelector('#file-list [data-dir="lib"] .dir-icon')`;
  const closedIcon = await evaluate<string>(`getComputedStyle(${libIcon}, "::after").clipPath`);
  await click(`#file-list .dir[data-dir="lib"] .dir-btn`);
  check(
    (await visible(`#file-list .file[data-path="lib/util.py"]`)) && !(await visible(`#file-list .file[data-path="lib/deep/inner.py"]`)) &&
      (await evaluate(`document.querySelector('#file-list .dir[data-dir="lib"] .dir-btn').getAttribute("aria-expanded") === "true"`)),
    "il clic apre la cartella, quelle dentro restano chiuse",
  );
  check(closedIcon.startsWith("polygon(") && await evaluate(`getComputedStyle(${libIcon}, "::after").clipPath !== ${JSON.stringify(closedIcon)}`),
    "l'icona pixel art mostra la cartella aperta con una sagoma diversa");

  // file e cartelle creati fuori dal gioco (dall'agente o dal terminale) compaiono senza ricaricare
  await fs.mkdir(path.join(project, "nuova"), { recursive: true });
  await fs.writeFile(path.join(project, "nuova", "fuori.py"), "x = 1\n");
  check(await waitFor(`!!document.querySelector('#file-list .dir[data-dir="nuova"]')`, 6000), "una cartella creata fuori dal gioco compare nell'albero senza ricaricare");
  await fs.rm(path.join(project, "nuova"), { recursive: true });
  check(await waitFor(`!document.querySelector('#file-list .dir[data-dir="nuova"]')`, 6000), "una cartella cancellata fuori dal gioco sparisce dall'albero");

  // tutor: un file trascinato su una cartella ci finisce dentro, e la sua scheda lo segue
  await fs.mkdir(path.join(project, "dentro"), { recursive: true });
  await fs.writeFile(path.join(project, "dentro", "gia.py"), "y = 2\n");
  await fs.writeFile(path.join(project, "sposta.py"), "z = 3\n");
  await waitFor(`!!document.querySelector('#file-list .file[data-path="sposta.py"]') && !!document.querySelector('#file-list .dir[data-dir="dentro"]')`, 6000);
  await click(`#file-list .file[data-path="sposta.py"]`);
  await waitFor(`!!document.querySelector('#tabs .tab.is-active[data-file="sposta.py"]')`);
  const dragTestFile = async () => {
    const box = (sel: string) => evaluate<{ x: number; y: number }>(`(() => { const el = document.querySelector('${sel}'); el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const a = await box(`#file-list .file[data-path="sposta.py"]`);
    const b = await box(`#file-list .dir[data-dir="dentro"] .dir-btn`);
    const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await mouse("mousePressed", a.x, a.y);
    for (let k = 1; k <= 6; k++) await mouse("mouseMoved", a.x + ((b.x - a.x) * k) / 6, a.y + ((b.y - a.y) * k) / 6);
    check(await evaluate(`document.querySelector('#file-list .dir[data-dir="dentro"]').classList.contains("is-drop")`), "trascinando un file la cartella sotto si illumina");
    await mouse("mouseReleased", b.x, b.y);
  };
  await dragTestFile();
  check(
    (await waitFor(`!!document.querySelector('#file-list .file[data-path="dentro/sposta.py"]') && !document.querySelector('#file-list .file[data-path="sposta.py"]')`)) &&
      (await fs.readFile(path.join(project, "dentro", "sposta.py"), "utf8")) === "z = 3\n" &&
      !(await fs.stat(path.join(project, "sposta.py")).then(() => true, () => false)),
    "lasciato su una cartella, il file si sposta su disco e nell'albero",
  );
  check(await evaluate(`!!document.querySelector('#tabs .tab.is-active[data-file="dentro/sposta.py"]') && !document.querySelector('#tabs .tab[data-file="sposta.py"]')`), "la scheda del file spostato segue il percorso nuovo");

  await evaluate(`(() => { const ta = document.getElementById("code-input"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); })()`);
  await typeText("# bozza");
  await fs.writeFile(path.join(project, "sposta.py"), "origine occupata\n");
  await click("#explorer-undo-move");
  check(await waitFor(`document.getElementById("explorer-move-status").hasAttribute("data-error") && !document.getElementById("explorer-undo-move").disabled`) &&
    (await fs.readFile(path.join(project, "sposta.py"), "utf8")) === "origine occupata\n" &&
    (await fs.readFile(path.join(project, "dentro", "sposta.py"), "utf8")) === "z = 3\n", "Annulla lascia entrambi i file intatti se il percorso originale è occupato");
  await fs.unlink(path.join(project, "sposta.py"));
  await click("#explorer-undo-move");
  check(await waitFor(`document.getElementById("explorer-move").hidden &&
    !!document.querySelector('#tabs .tab.is-active[data-file="sposta.py"]') &&
    document.getElementById("code-input").value.endsWith("# bozza")`) &&
    !existsSync(path.join(project, "dentro", "sposta.py")) &&
    (await fs.readFile(path.join(project, "sposta.py"), "utf8")) === "z = 3\n", "Annulla riporta il file alla radice e conserva scheda e bozza");
  await dragTestFile();
  await waitFor(`document.querySelector('#tabs .tab.is-active[data-file="dentro/sposta.py"]')`);

  const movedFile = '#file-list .file[data-path="dentro/sposta.py"]';
  const renamedFile = '#file-list .file[data-path="dentro/con bozza.js"]';
  const renameAction = '.file-menu [data-action="rename"]';
  const deleteAction = '.file-menu [data-action="delete"]';
  const referencesAction = '.file-menu [data-action="references"]';
  const newFolderAction = '.file-menu [data-action="newFolder"]';
  const newFileAction = '.file-menu [data-action="newFile"]';
  const referenceResults = `(() => {
    const text = document.getElementById("references-results").textContent;
    return text.includes("dentro/collega.py:1") && text.includes("Tour di verifica") && text.includes("Schema di verifica");
  })()`;
  await Promise.all([
    fs.writeFile(path.join(project, "dentro", "collega.py"), "import sposta\n"),
    fs.writeFile(path.join(project, ".tour", "verifica-riferimenti.json"), JSON.stringify({
      version: 1, id: "verifica-riferimenti", title: "Tour di verifica",
      steps: [{ id: "passo", title: "Passo collegato", file: "./dentro/sposta.py", lines: [1, 1], text: { facile: "Prova." } }],
    })),
    fs.writeFile(path.join(project, ".tour", "schemi", "verifica-riferimenti.json"), JSON.stringify({
      version: 1, id: "verifica-riferimenti", title: "Schema di verifica", kind: "flusso", edges: [],
      nodes: [{ id: "nodo", label: "Nodo collegato", code: { file: "dentro/sposta.py", lines: [1, 1] } }],
    })),
  ]);
  await waitFor(`document.querySelector('#file-list .file[data-path="dentro/collega.py"]')`, 6000);
  await evaluate(`document.getElementById("code-input").focus()`);
  await typeText("#");
  await rightClick(movedFile);
  check((await visible(renameAction)) && (await visible(deleteAction)) && (await visible(referencesAction)), "il clic destro mostra Rinomina, Sposta nel cestino e Trova riferimenti");
  await press("ArrowDown");
  check(await evaluate(`document.activeElement?.dataset.action === "delete"`), "le frecce cambiano azione nel menu contestuale");
  await press("Escape");
  check(!(await visible(".file-menu")) && (await evaluate(`document.getElementById("title-screen").hidden`)), "Esc chiude il menu contestuale");
  await rightClick(movedFile);
  await click(referencesAction);
  check(await waitFor(referenceResults), "Trova riferimenti elenca gli import, i passi dei tour e i nodi degli schemi");
  await click("#references-close");
  await rightClick(movedFile);
  await click(renameAction);
  check(await evaluate(`(() => {
    const input = document.getElementById("rename-file-name");
    return document.activeElement === input && input.value === "sposta.py" && input.selectionStart === 0 && input.selectionEnd === 6;
  })()`), "Rinomina propone il nome attuale e seleziona la parte prima dell'estensione");
  await click("#rename-file-references");
  check(await waitFor(referenceResults), "la finestra Rinomina può mostrare i riferimenti al nome originale");
  await press("Escape");
  check(await evaluate(`!document.getElementById("references-dialog").open && document.getElementById("rename-file-dialog").open &&
    document.getElementById("rename-file-name").value === "sposta.py"`), "Esc torna dalla ricerca a Rinomina");
  await press("Escape");
  check(await evaluate(`!document.getElementById("rename-file-dialog").open && document.getElementById("title-screen").hidden`) &&
    existsSync(path.join(project, "dentro", "sposta.py")), "Esc annulla la rinomina");
  await rightClick(movedFile);
  await click(renameAction);
  await typeText("gia");
  await press("Enter");
  check(await waitFor(`document.getElementById("rename-file-dialog").open && !document.getElementById("rename-file-error").hidden`) &&
    (await fs.readFile(path.join(project, "dentro", "gia.py"), "utf8")) === "y = 2\n", "un nome già occupato resta intatto e il messaggio permette di correggere il nome");
  await evaluate(`document.getElementById("rename-file-name").select()`);
  await typeText("con bozza.js");
  await press("Enter");
  check(await waitFor(`!document.getElementById("rename-file-dialog").open &&
      !document.querySelector(${JSON.stringify(movedFile)}) && !!document.querySelector(${JSON.stringify(renamedFile)}) &&
      !!document.querySelector('#tabs .tab.is-active[data-file="dentro/con bozza.js"]') &&
      document.getElementById("code-input").value.includes("#") && document.getElementById("status-lang").textContent === "JavaScript"`) &&
    !existsSync(path.join(project, "dentro", "sposta.py")) &&
    (await fs.readFile(path.join(project, "dentro", "con bozza.js"), "utf8")) === "z = 3\n",
    "la rinomina aggiorna nome ed estensione su disco e conserva la bozza nella scheda attiva");
  await rightClick(renamedFile);
  await click(deleteAction);
  check(await evaluate(`document.getElementById("delete-file-dialog").open &&
    document.getElementById("delete-file-text").textContent.includes("dentro/con bozza.js") &&
    !document.getElementById("delete-file-unsaved").hidden &&
    document.activeElement?.id === "delete-file-cancel"`), "la conferma nomina il file, avvisa della bozza e dà il fuoco ad Annulla");
  await press("Escape");
  check(await evaluate(`!document.getElementById("delete-file-dialog").open &&
      document.getElementById("title-screen").hidden && document.getElementById("code-input").value.includes("#")`) &&
    (await fs.readFile(path.join(project, "dentro", "con bozza.js"), "utf8")) === "z = 3\n", "annullare conserva la bozza e il file su disco");
  await rightClick(renamedFile);
  await click(deleteAction);
  await click("#delete-file-confirm");
  check(await waitFor(`!document.getElementById("delete-file-dialog").open &&
      !document.querySelector(${JSON.stringify(renamedFile)}) &&
      !document.querySelector('#tabs .tab[data-file="dentro/con bozza.js"]') &&
      !!document.querySelector('#tabs .tab.is-active[data-file="solve.py"]')`) &&
    !existsSync(path.join(project, "dentro", "con bozza.js")), "la conferma sposta il file nel cestino, aggiorna l'albero e passa alla scheda accanto");
  await click("#explorer-trash");
  check(await waitFor(`document.querySelector("#trash-list li")?.textContent.includes("dentro/con bozza.js")`), "il Cestino mostra il percorso del file appena spostato");
  await click("#trash-list button");
  check(await waitFor(`!!document.querySelector(${JSON.stringify(renamedFile)}) && !document.querySelector("#trash-list button")`) &&
    (await fs.readFile(path.join(project, "dentro", "con bozza.js"), "utf8")) === "z = 3\n", "Ripristina recupera la versione salvata al percorso originale");
  await click("#trash-close");

  await click("#explorer-new");
  await click(newFolderAction);
  await typeText("prove");
  await press("Enter");
  check(await waitFor(`!document.getElementById("create-entry-dialog").open && !!document.querySelector('#file-list .dir[data-dir="prove"]')`) &&
    (await fs.readdir(path.join(project, "prove"))).length === 0, "Nuova cartella mostra subito nell'albero una cartella vuota");
  await rightClick('#file-list .dir[data-dir="prove"] .dir-btn');
  await click(newFolderAction);
  await typeText("esercizi");
  await press("Enter");
  check(await waitFor(`!document.getElementById("create-entry-dialog").open && !!document.querySelector('#file-list .dir[data-dir="prove/esercizi"]:not(.is-folded)')`) &&
    (await fs.stat(path.join(project, "prove", "esercizi"))).isDirectory(), "il menu di una cartella crea una sottocartella al suo interno");

  const folderRow = (dir: string) => `#file-list .dir[data-dir="${dir}"]`;
  const folderButton = (dir: string) => `${folderRow(dir)} .dir-btn`;
  await fs.mkdir(path.join(project, "schedario", "interno", "vuota"), { recursive: true });
  await fs.mkdir(path.join(project, "schedario-altro"));
  await fs.writeFile(path.join(project, "schedario", "primo.py"), "a = 1\n");
  await fs.writeFile(path.join(project, "schedario", "interno", "secondo.py"), "b = 2\n\n");
  await waitFor(`document.querySelector(${JSON.stringify(folderRow("schedario"))})`, 6000);
  await click(folderButton("schedario"));
  await click(folderButton("schedario/interno"));
  await click('#file-list .file[data-path="schedario/primo.py"]');
  await waitFor(`document.querySelector('#tabs .tab.is-active[data-file="schedario/primo.py"]')`);
  await evaluate(`document.querySelector('#file-list .file[data-path="schedario/interno/secondo.py"]')
    .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }))`);
  await waitFor(`document.querySelector('#tabs .tab.is-active[data-file="schedario/interno/secondo.py"]')`);
  await callTool("mark_lines", { path: "schedario/interno/secondo.py", marks: [{ line: 1, kind: "warning", message: "Controlla il valore." }] });
  await waitFor(`document.querySelector('#editor .line[data-n="1"] .mark-pin')`);
  await evaluate(`(() => { const ta = document.getElementById("code-input"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); })()`);
  await typeText("# bozza");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  {
    const point = (selector: string) => evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const from = await point(folderButton("schedario"));
    const descendant = await point(folderButton("schedario/interno"));
    const to = await point(folderButton("prove"));
    const mouse = (type: string, { x, y }: { x: number; y: number }) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await mouse("mousePressed", from);
    await mouse("mouseMoved", descendant);
    check(await evaluate(`!document.querySelector('#file-list .is-drop')`), "trascinare una cartella su una propria sottocartella non la rende una destinazione");
    await mouse("mouseReleased", descendant);
    await mouse("mousePressed", from);
    await mouse("mouseMoved", to);
    check(await evaluate(`document.querySelector(${JSON.stringify(folderRow("prove"))}).classList.contains("is-drop")`), "trascinando una cartella si illumina la destinazione valida");
    await mouse("mouseReleased", to);
  }
  check(await waitFor(`!!document.querySelector('#tabs .tab.is-active[data-file="prove/schedario/interno/secondo.py"]') &&
    !!document.querySelector('#tabs .tab[data-file="prove/schedario/primo.py"]') &&
    !!document.querySelector('#file-list [data-dir="prove/schedario/interno"].is-open') &&
    !!document.querySelector('#file-list [data-dir="prove/schedario/interno/vuota"]') &&
    !!document.querySelector('#file-list [data-dir="schedario-altro"]') && !document.querySelector('#file-list [data-dir="schedario"]') &&
    document.getElementById("code-input").value.endsWith("# bozza") &&
    !!document.querySelector('#editor .line[data-n="1"] .mark-pin')`) &&
    !existsSync(path.join(project, "schedario")) &&
    (await fs.readFile(path.join(project, "prove", "schedario", "interno", "secondo.py"), "utf8")) === "b = 2\n\n",
  "spostare una cartella conserva i file, le schede, la bozza, i segni e le cartelle aperte");
  check(await evaluate(`(() => {
    const sparkle = document.querySelector('#file-list [data-dir="prove/schedario"].dir-arrived .dir-sparkle');
    return !!sparkle && getComputedStyle(sparkle).animationName === "dir-sparkle";
  })()`), "la cartella spostata mostra una scintilla nella sua nuova posizione");
  await click("#edit-save");
  check(await waitFor(`document.querySelector('#tabs .tab.is-active')?.title === "prove/schedario/interno/secondo.py"`) &&
    (await fs.readFile(path.join(project, "prove", "schedario", "interno", "secondo.py"), "utf8")).endsWith("# bozza"),
  "Salva scrive nel nuovo percorso dopo lo spostamento della cartella");

  await viewport(390, 844);
  check(await load(), "a 390 px il gioco si apre in tutor");
  check(dialogs.includes("beforeunload"), "lasciare la pagina con modifiche non salvate chiede conferma");
  await click("#start-btn");
  await waitFor(`document.getElementById("title-screen").hidden`);
  await waitFor(`document.getElementById("app").classList.contains("is-chat")`, 1000);
  if (await evaluate(`document.getElementById("app").classList.contains("is-chat")`)) {
    await evaluate(`document.activeElement?.blur()`);
    await press("c");
  }
  await sleep(800);
  await click(`#file-list .file[data-path="protocol.py"]`);
  check(await waitFor(`document.getElementById("code-input")`), "a 390 px l'editor è modificabile");
  check(await inView("edit-save"), "a 390 px il pulsante Salva è visibile");
  await callTool("mark_lines", { path: "protocol.py", marks: [{ line: 2, kind: "warning", message: "Un commento lungo abbastanza da andare a capo sullo schermo stretto del telefono." }] });
  await waitFor(`document.querySelector('#editor .line[data-n="2"] .mark-pin')`);
  await click(`#editor .line[data-n="2"] .mark-pin`);
  check(
    await waitFor(`(() => { const n = document.getElementById("mark-note"); const r = n.getBoundingClientRect(); return !n.hidden && r.right <= innerWidth && r.left >= 0; })()`),
    "a 390 px il commento del segno sta nello schermo",
  );
  check(await noOverflow(), "tutor senza scorrimento orizzontale a 390 px");
  check(await evaluate(`document.querySelector('#file-list .file[data-path="lib/deep/inner.py"]').getClientRects().length > 0`), "a 390 px la striscia dei file mostra anche quelli nelle cartelle chiuse");
  check(await evaluate(`document.querySelector('#file-list .dir[data-dir="lib"]').classList.contains("is-open")`), "la cartella aperta resta aperta dopo il ricaricamento");

  await rightClick(folderButton("prove/schedario"));
  await click('.file-menu [data-action="moveFolder"]');
  check(await inView("move-folder-dialog") && await noOverflow() && await evaluate(`(() => {
    const options = [...document.getElementById("move-folder-to").options].map((option) => option.value);
    return options.includes("") && !options.some((dir) => dir.startsWith("prove/schedario"));
  })()`), "a 390 px il menu Sposta cartella offre la radice ed esclude le sottocartelle della sorgente");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await click("#move-folder-confirm");
  check(await waitFor(`!document.getElementById("move-folder-dialog").open && !!document.querySelector('#file-list [data-dir="schedario/interno/vuota"]')`) &&
    !existsSync(path.join(project, "prove", "schedario")) && existsSync(path.join(project, "schedario", "primo.py")),
  "a 390 px il menu sposta la cartella e i suoi file nella radice");
  const arrivalOnPhone = await evaluate<{ visible: boolean; focused: boolean; highlight: string; animation: string } | null>(`(() => {
    const row = document.querySelector('#file-list [data-dir="schedario"].dir-arrived');
    if (!row) return null;
    const button = row.querySelector('.dir-btn');
    const r = button.getBoundingClientRect();
    return {
      visible: r.left >= 0 && r.right <= innerWidth,
      focused: document.activeElement === button,
      highlight: getComputedStyle(button).boxShadow,
      animation: getComputedStyle(row.querySelector('.dir-sparkle')).animationName,
    };
  })()`);
  const staticArrival = arrivalOnPhone?.visible && arrivalOnPhone.focused && arrivalOnPhone.highlight !== "none" && arrivalOnPhone.animation === "none";
  if (!staticArrival) console.log("     risalto dopo lo spostamento:", arrivalOnPhone);
  check(staticArrival && await noOverflow(), "a 390 px, con movimento ridotto, la cartella è visibile e ha un risalto statico");
  await send("Emulation.setEmulatedMedia", { features: [] });
  check(await inView("explorer-undo-move") && await noOverflow(), "a 390 px Annulla è visibile in Esplora");
  await click("#explorer-undo-move");
  check(await waitFor(`document.getElementById("explorer-move").hidden &&
    !!document.querySelector('#file-list [data-dir="prove/schedario/interno/vuota"]')`) &&
    !existsSync(path.join(project, "schedario")) && existsSync(path.join(project, "prove", "schedario", "primo.py")) &&
    await noOverflow(), "a 390 px Annulla riporta la cartella e il suo contenuto nel percorso originale");

  const narrowFile = '#file-list .file[data-path="dentro/gia.py"]';
  const narrowRenamed = '#file-list .file[data-path="dentro/prima.py"]';
  await rightClick(narrowFile);
  check(await visible(".file-menu") && (await noOverflow()), "a 390 px il menu contestuale resta nello schermo");
  await click(renameAction);
  check(await evaluate(`document.getElementById("rename-file-dialog").open`) && (await noOverflow()), "a 390 px la finestra Rinomina resta nello schermo");
  await typeText("prima");
  await press("Enter");
  check(await waitFor(`!document.getElementById("rename-file-dialog").open &&
      !document.querySelector(${JSON.stringify(narrowFile)}) && !!document.querySelector(${JSON.stringify(narrowRenamed)}) &&
      !!document.querySelector('#tabs .tab.is-active[data-file="protocol.py"]')`) &&
    existsSync(path.join(project, "dentro", "prima.py")), "a 390 px si può rinominare un altro file mentre si lavora nell'editor");
  await rightClick(narrowRenamed);
  await click(deleteAction);
  check(await evaluate(`document.getElementById("delete-file-dialog").open &&
    document.getElementById("delete-file-unsaved").hidden`) && (await noOverflow()), "a 390 px la conferma di un file senza bozza resta nello schermo");
  await click("#delete-file-confirm");
  check(await waitFor(`!document.querySelector(${JSON.stringify(narrowRenamed)}) &&
      !document.getElementById("delete-file-dialog").open &&
      !!document.querySelector('#tabs .tab.is-active[data-file="protocol.py"]')`) &&
    !existsSync(path.join(project, "dentro", "prima.py")), "a 390 px si può spostare nel cestino un altro file");
  await click("#explorer-trash");
  check(await waitFor(`document.querySelector("#trash-list li")?.textContent.includes("dentro/prima.py")`) && (await noOverflow()), "a 390 px il Cestino resta nello schermo");
  await click("#trash-list button");
  check(await waitFor(`!!document.querySelector(${JSON.stringify(narrowRenamed)})`), "a 390 px il file ripristinato torna nell'albero");
  await click("#trash-close");

  await rightClick('#file-list .dir[data-dir="prove/esercizi"] .dir-btn');
  await click(newFileAction);
  check(await evaluate(`document.getElementById("create-entry-dialog").open &&
    document.getElementById("create-entry-location").textContent.includes("prove/esercizi")`) && (await noOverflow()),
    "a 390 px Nuovo file qui mostra la cartella di destinazione");
  await typeText("appunti.py");
  await press("Enter");
  check(await waitFor(`!document.getElementById("create-entry-dialog").open &&
    !!document.querySelector('#tabs .tab.is-active[data-file="prove/esercizi/appunti.py"]')`) &&
    (await fs.readFile(path.join(project, "prove", "esercizi", "appunti.py"), "utf8")) === "", "Nuovo file qui crea e apre un file nella sottocartella");
  await rightClick('#file-list .file[data-path="prove/esercizi/appunti.py"]');
  await click(referencesAction);
  const noReferences = await waitFor(`document.getElementById("references-dialog").open &&
    /Nessun riferimento|No references/.test(document.getElementById("references-status").textContent)`);
  if (!noReferences) console.log(await evaluate(`({
    open: document.getElementById("references-dialog").open,
    file: document.getElementById("references-file").textContent,
    status: document.getElementById("references-status").textContent,
    results: document.getElementById("references-results").textContent,
  })`));
  check(noReferences && (await noOverflow()), "a 390 px i riferimenti vuoti restano nello schermo");
  await click("#references-close");

  // risposta della guida in tutor (dopo l'ultimo ricaricamento: il ponte rimanderebbe la scena): righe in giallo, che spariscono tornando a scrivere
  const lit = await callTool("highlight_lines", { path: "protocol.py", start: 3, end: 4 });
  check(
    !lit?.isError && (await waitFor(`document.querySelectorAll("#editor .line.hl").length === 2 && document.querySelector('#editor .line[data-n="3"]').classList.contains("hl-first")`)),
    "in tutor highlight_lines colora di giallo le righe della risposta",
  );
  await evaluate(`(() => { const ta = document.getElementById("code-input"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); })()`);
  await typeText("x");
  check(await waitFor(`!document.querySelector("#editor .line.hl")`), "tornando a scrivere il giallo sparisce");
  // La modifica resta nella bozza durante la risposta della guida.

  await click("#edit-ask-btn");
  check(
    (await evaluate(`[...document.querySelectorAll("#edit-ask button")].every((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; })`)) &&
      (await noOverflow()),
    "a 390 px le scelte rapide stanno nella barra",
  );
  await click(`#edit-ask [data-quick="error"]`);
  check(
    (await evaluate(`(() => { const r = document.getElementById("edit-error").getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; })()`)) && (await noOverflow()),
    "a 390 px il riquadro dell'errore sta nella finestra",
  );

  await typeText("riga\n".repeat(1200) + "ERRORE FINALE");
  await evaluate(`document.getElementById("edit-error").requestSubmit()`);
  check(await waitFor(`!document.getElementById("ask-sections").hidden`), "anche Spiegami l’errore accetta un log oltre 4000 caratteri");
  await click("#edit-ask-btn");
  await click('#edit-ask [data-quick="error"]');
  check(await evaluate(`document.getElementById("edit-error-output").value.endsWith("ERRORE FINALE")`), "il riquadro dell’errore conserva anche l’ultima riga");
  await click("#edit-error-cancel");
  await click("#ask-sections [data-kind=output] button");

  // risposte formattate (dopo l'ultimo ricaricamento: il ponte rimanda l'ultimo fumetto e chiuderebbe il menu): paragrafi, elenchi, codice e link, senza apici inversi visibili
  const RICH = "Due fonti:\n\n- Indice: https://docs.pwntools.com.\n- Classe `ELF(\"./vuln\")`, vedi [la pagina](https://docs.pwntools.com/en/stable/elf/elf.html)\n\n1. Web\n2. **Offline**";
  const diskPath = path.join(project, "protocol.py");
  const diskBefore = await fs.readFile(diskPath, "utf8");
  await fs.writeFile(diskPath, diskBefore + "\n# external edit");
  await callTool("show_dialog", { text: RICH, highlight: { path: "protocol.py", start: 2, end: 2 } });
  check(await waitFor(`document.querySelector('#editor .line[data-n="2"].hl')`), "a 390 px il fumetto evidenzia anche il codice");
  check(
    await waitFor(`(() => {
      const d = document.getElementById("dialog-text");
      const links = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      return d.querySelectorAll("ul > li").length === 2 && d.querySelectorAll("ol > li").length === 2 &&
        d.querySelector("code")?.textContent === 'ELF("./vuln")' && d.querySelector("strong")?.textContent === "Offline" &&
        links[0] === "https://docs.pwntools.com" && links[1].endsWith("elf.html") && !d.textContent.includes("\`");
    })()`, 8000),
    "il fumetto mostra elenchi, codice, grassetto e link (senza il punto finale nell'indirizzo)",
  );
  check(/• Indice/.test(await evaluate<string>(`document.getElementById("dialog-live").textContent`)), "il lettore di schermo riceve il testo con i punti dell'elenco");

  await evaluate(`document.getElementById("code-input").focus()`);
  await press("s", 2);
  check(await waitFor(`!document.getElementById("edit-confirm").hidden`), "anche dopo la risposta con righe evidenziate il salvataggio rileva il conflitto");
  await click("#edit-confirm-cancel");
  await fs.writeFile(diskPath, diskBefore);
  await evaluate(`document.getElementById("code-input").focus()`);
  await press("Backspace");
  check(await noOverflow(), "a 390 px elenchi e indirizzi lunghi vanno a capo senza scorrimento orizzontale");

  // blocchi di codice: cornice col linguaggio, colori dell'editor, rientro conservato, pulsante Copia
  const C_CODE = "int main(void) {\n    return 0; /* una riga di commento molto lunga che a 390 px deve scorrere dentro il blocco */\n}";
  await callTool("show_dialog", { text: `Prova così:\n\`\`\`C\n${C_CODE}\n\`\`\`\nPoi compila.` });
  // il fumetto nuovo aspetta in coda finché non si va avanti
  await waitFor(`!document.getElementById("next-btn").disabled`, 4000);
  await click("#next-btn");
  check(
    await waitFor(`(() => {
      const d = document.getElementById("dialog-text");
      const box = d.querySelector(".rich-code");
      return !!box && box.querySelector(".rich-code-lang").textContent === "C" && box.querySelector("code").textContent === ${JSON.stringify(C_CODE)} &&
        !!box.querySelector(".tk-kw") && !!box.querySelector(".tk-com") && !d.textContent.includes("\`\`\`") && d.textContent.includes("Poi compila.");
    })()`, 8000),
    "un blocco \`\`\`C ha la cornice col linguaggio, i colori dell'editor e il rientro",
  );
  check(await noOverflow(), "a 390 px una riga lunga scorre dentro il blocco di codice, non la pagina");
  await evaluate(`navigator.clipboard.writeText = async (s) => { window.__copied = s; }`);
  await click("#dialog-text .rich-copy");
  check(
    (await waitFor(`window.__copied === ${JSON.stringify(C_CODE)} && document.querySelector("#dialog-text .rich-copy").classList.contains("is-copied")`)),
    "il pulsante Copia copia il codice del blocco",
  );

  // l'agente apre un file in una cartella chiusa (in fondo: il ponte rimanderebbe open_file a ogni ricaricamento)
  await viewport(1400, 900);
  await click(`#file-list .dir[data-dir="lib"] .dir-btn`);
  await callTool("open_file", { path: "lib/deep/inner.py" });
  check(
    await waitFor(`document.querySelector("#file-list .file.is-active")?.dataset.path === "lib/deep/inner.py" && document.querySelector("#file-list .file.is-active").getClientRects().length > 0`),
    "open_file apre da solo le cartelle del file",
  );
  await click(`#file-list .dir[data-dir="lib"] .dir-btn`);
  check(!(await visible(`#file-list .file[data-path="lib/util.py"]`)) && !(await visible(`#file-list .dir[data-dir="lib/deep"] .dir-btn`)), "chiudere una cartella nasconde tutto quello che contiene");

  // più schede di file
  const tabFiles = () => evaluate<string[]>(`[...document.querySelectorAll("#tabs .tab[data-file]")].map((t) => t.dataset.file)`);
  const activeTab = () => evaluate<string | undefined>(`document.querySelector("#tabs .tab.is-active")?.dataset.file`);
  const ctrlClick = (js: string) => evaluate(`${js}.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }))`);
  const tabsBefore = (await tabFiles()).length;
  // Ctrl+clic sull'import (riga 1 di inner.py): util.py in una scheda nuova
  await evaluate(`document.getElementById("code-input").setSelectionRange(5, 5)`);
  await ctrlClick(`document.getElementById("code-input")`);
  check(
    (await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "lib/util.py"`)) && (await tabFiles()).length === tabsBefore + 1,
    "Ctrl+clic su un import apre il file in una scheda nuova",
  );
  // clic semplice nella barra: sostituisce la scheda corrente
  await click(`#file-list .file[data-path="protocol.py"]`);
  await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "protocol.py"`);
  let tabsNow = await tabFiles();
  check(tabsNow.length === tabsBefore + 1 && !tabsNow.includes("lib/util.py"), "il clic semplice sostituisce la scheda corrente");
  // Ctrl+clic nella barra: scheda nuova accanto alla corrente
  await ctrlClick(`document.querySelector('#file-list .file[data-path="handlers.py"]')`);
  await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "handlers.py"`);
  tabsNow = await tabFiles();
  check(tabsNow.length === tabsBefore + 2 && tabsNow.indexOf("handlers.py") === tabsNow.indexOf("protocol.py") + 1, "Ctrl+clic nella barra apre una scheda nuova dopo la corrente");
  // open_file su un file già aperto: porta in primo piano la sua scheda
  await callTool("open_file", { path: "lib/deep/inner.py" });
  check((await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "lib/deep/inner.py"`)) && (await tabFiles()).length === tabsBefore + 2, "open_file porta in primo piano la scheda già aperta");
  // Ctrl+frecce fuori dai campi e Ctrl+PagSu/PagGiù anche nell'editor: scheda accanto, in giro
  {
    const tabs = await evaluate<string[]>(`[...document.querySelectorAll("#tabs .tab")].map((t) => t.dataset.file ?? "board")`);
    const at = tabs.indexOf("lib/deep/inner.py");
    const prev = tabs[(at - 1 + tabs.length) % tabs.length];
    await evaluate(`document.activeElement?.blur()`);
    await press("ArrowLeft", 2);
    const left = await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === ${JSON.stringify(prev)}`);
    await evaluate(`document.getElementById("code-input").focus()`);
    await press("PageDown", 2);
    check(left && (await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "lib/deep/inner.py"`)), "Ctrl+← e Ctrl+PagGiù passano da una scheda all'altra");
  }
  // trascinare una scheda col tasto sinistro la sposta dopo un'altra (prima e ultima scheda di file si scambiano di posto)
  {
    const before = await tabFiles();
    const first = before[0], last = before[before.length - 1];
    const box = (f: string) => evaluate<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('#tabs .tab[data-file="${f}"]').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
    await evaluate(`document.querySelector('#tabs .tab[data-file="${last}"]').scrollIntoView({ inline: "nearest" })`);
    const a = await box(first), b = await box(last);
    const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await mouse("mousePressed", a.x + a.w / 2, a.y);
    for (let k = 1; k <= 6; k++) await mouse("mouseMoved", a.x + a.w / 2 + ((b.x + b.w * 0.8) - (a.x + a.w / 2)) * k / 6, a.y);
    const marked = await evaluate<boolean>(`!!document.querySelector('#tabs .tab.drop-after[data-file="${last}"]')`);
    await mouse("mouseReleased", b.x + b.w * 0.8, b.y);
    const after = await tabFiles();
    check(marked && after[after.length - 1] === first && after.length === before.length && !(await evaluate<boolean>(`!!document.querySelector("#tabs .is-dragging, #tabs .drop-after, #tabs .drop-before")`)),
      "trascinare una scheda la sposta dopo un'altra");
  }
  // modifica: pallino sulla scheda, chiuderla chiede conferma
  await evaluate(`document.getElementById("code-input").focus()`);
  await typeText("# nota\n");
  check(await waitFor(`document.querySelector('#tabs .tab[data-file="lib/deep/inner.py"]').textContent.includes("●")`), "la scheda modificata ha il pallino");
  await click(`#tabs .tab[data-file="handlers.py"]`);
  await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "handlers.py"`);
  check(await evaluate<boolean>(`document.querySelector('#tabs .tab[data-file="lib/deep/inner.py"]').textContent.includes("●")`), "il pallino resta sulla scheda modificata anche quando non è in primo piano");
  await click(`#tabs .tab[data-file="lib/deep/inner.py"] .tab-close`);
  check(
    (await waitFor(`!document.getElementById("edit-close").hidden && document.querySelector("#tabs .tab.is-active")?.dataset.file === "lib/deep/inner.py"`)) &&
      (await evaluate<string>(`document.getElementById("code-input").value`)).startsWith("from ..util"),
    "chiudere una scheda modificata chiede conferma e la mostra",
  );
  await click("#edit-close-cancel");
  check((await tabFiles()).includes("lib/deep/inner.py") && (await evaluate<boolean>(`document.getElementById("edit-close").hidden`)), "Annulla lascia la scheda aperta");
  await click(`#tabs .tab[data-file="lib/deep/inner.py"] .tab-close`);
  await waitFor(`!document.getElementById("edit-close").hidden`);
  await click("#edit-close-discard");
  check(
    (await waitFor(`!document.querySelector('#tabs .tab[data-file="lib/deep/inner.py"]') && !!document.querySelector("#tabs .tab.is-active[data-file]")`)) &&
      (await fs.readFile(path.join(project, "lib", "deep", "inner.py"), "utf8")) === "from ..util import aiuto\nX = 2\n",
    "Non salvare chiude la scheda senza toccare il file e passa a quella accanto",
  );
  // tornando a una scheda si ritrova lo scorrimento
  await click(`#tabs .tab[data-file="protocol.py"]`);
  await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "protocol.py"`);
  await evaluate(`document.getElementById("editor").scrollTop = 60`);
  await click(`#tabs .tab[data-file="handlers.py"]`);
  await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "handlers.py"`);
  await click(`#tabs .tab[data-file="protocol.py"]`);
  check(await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "protocol.py" && Math.abs(document.getElementById("editor").scrollTop - 60) < 4`), "ogni scheda ricorda il suo scorrimento");
  await viewport(390, 844);
  check(await noOverflow(), "a 390 px le schede scorrono senza allargare la pagina");
  for (const f of await tabFiles()) await click(`#tabs .tab[data-file="${f}"] .tab-close`);
  check(await waitFor(`!document.getElementById("editor-empty").hidden && !document.querySelector("#tabs .tab[data-file]")`), "chiusa l'ultima scheda l'editor torna vuoto");

  // evidenziazione di C e HTML (con <script> dentro), anche a 390 px
  await callTool("open_file", { path: "lib/deep/vuln.c" });
  await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "lib/deep/vuln.c"`);
  const tk = (n: number, cls: string) => evaluate<string[]>(`[...document.querySelectorAll('#editor .line[data-n="${n}"] .tk-${cls}')].map((e) => e.textContent)`);
  check(
    (await tk(1, "pre")).includes("#include") && (await tk(1, "str")).some((x) => x.includes("<stdio.h>")) && (await tk(3, "com")).length === 1 &&
      (await tk(4, "type")).includes("int") && (await tk(5, "com")).includes("// pila") && (await tk(6, "builtin")).includes("printf") && (await tk(7, "kw")).includes("return"),
    "il C ha i colori: direttive, tipi, commenti anche su più righe, funzioni note",
  );
  check(
    (await evaluate(`document.getElementById("status-lang").textContent === "C"`)) && (await evaluate(`!!document.querySelector('#tabs .tab.is-active .file-icon.ext-c')`)),
    "barra di stato e scheda dicono che il file è in C",
  );
  await callTool("open_file", { path: "lib/deep/page.html" });
  await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "lib/deep/page.html"`);
  check(
    (await tk(1, "com")).length > 0 && (await tk(2, "tag")).includes("<a") && (await tk(2, "attr")).includes("href") && (await tk(4, "kw")).includes("const"),
    "l'HTML colora tag, attributi e commenti, e il JavaScript dentro <script>",
  );
  check(await noOverflow(), "a 390 px il codice colorato non allarga la pagina");
  for (const f of await tabFiles()) await click(`#tabs .tab[data-file="${f}"] .tab-close`);

  // elenco delle sessioni: il titolo della chat dato dall'agente, il progetto sotto
  await callTool("name_session", { title: "Buffer overflow in vuln.c" });
  // il test non è sulle porte 7337-7356: la sessione di prova risponde al posto della 7337, le altre tacciono
  await evaluate(`(() => {
    const real = window.fetch.bind(window);
    window.fetch = (u, o) => {
      const m = /^http:\\/\\/127\\.0\\.0\\.1:(\\d+)\\/session$/.exec(String(u));
      if (!m) return real(u, o);
      // la 7338 finge un server vecchio, senza ora di avvio né titolo
      if (m[1] === "7338") return Promise.resolve(new Response(JSON.stringify({ project: "vecchio", agent: true, port: 7338 })));
      if (m[1] !== "7337") return Promise.reject(new Error("chiusa"));
      return real("/session", o).then((r) => r.json()).then((j) => new Response(JSON.stringify({ ...j, port: 7337 })));
    };
  })()`);
  await click("#project-name");
  check(
    await waitFor(`(() => { const b = document.querySelector('#session-list .session-item[data-port="7337"]'); return !!b && b.querySelector(".tour-title").textContent === "Buffer overflow in vuln.c" && b.querySelector(".session-folder").textContent.endsWith("packet-server") && !b.querySelector(".session-old"); })()`),
    "l'elenco delle sessioni mostra il titolo della chat e sotto la cartella del progetto",
  );
  check(
    await waitFor(`!!document.querySelector('#session-list .session-item[data-port="7338"] .session-old')`),
    "una sessione col server vecchio dice di riavviarlo per vedere il titolo",
  );
  check(await noOverflow(), "a 390 px l'elenco delle sessioni non allarga la pagina");
  await click("#session-close");
  await waitFor(`!document.getElementById("session-picker").open`);

  // numeri di riga: clic e Maiusc+clic scelgono righe intere, il pulsante "Chiedi a <guida>" le cita
  await viewport(1400, 900);
  await callTool("open_file", { path: "protocol.py" });
  await waitFor(`document.querySelector("#tabs .tab.is-active")?.dataset.file === "protocol.py"`);
  await evaluate(`document.getElementById("editor").scrollTop = 0`);
  const gutterAt = (n: number, shift = false) =>
    evaluate(`(() => {
      const ln = document.querySelector('#editor .line[data-n="${n}"] .ln').getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, clientX: ln.left + ln.width / 2, clientY: ln.top + ln.height / 2, shiftKey: ${shift}, button: 0, pointerId: 1 };
      const el = document.elementFromPoint(o.clientX, o.clientY);
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
    })()`);
  await gutterAt(2);
  await gutterAt(4, true);
  check(
    await waitFor(`(() => {
      const b = document.getElementById("ask-sel");
      return !b.hidden && /^\\? (Ask|Chiedi a) \\S/.test(b.textContent) && document.querySelectorAll("#editor .line.is-picked").length === 3;
    })()`),
    "clic e Maiusc+clic sui numeri scelgono le righe e compare Chiedi a <guida>",
  );
  await click("#ask-sel");
  check(
    (await waitFor(`!document.getElementById("ask-sections").hidden && /2.*4/.test(document.querySelector("#ask-sections [data-kind=quote] .ask-quote-label").textContent)`)) &&
      (await evaluate<number>(`document.querySelectorAll("#editor .line.is-picked").length`)) === 0,
    "Chiedi a <guida> cita le righe scelte",
  );
  // tutor: la selezione dentro la textarea
  await evaluate(`(() => { const ta = document.getElementById("code-input"); ta.focus(); ta.setSelectionRange(0, ta.value.indexOf("\\n", 40)); })()`);
  // la focus fa scorrere l'editor, e lo scorrimento nasconde il pulsante: si riprova finché lo scorrimento non si ferma
  let selShown = false;
  for (let k = 0; k < 5 && !selShown; k++) {
    await sleep(300);
    await press("Shift");
    selShown = await waitFor(`!document.getElementById("ask-sel").hidden`, 600);
  }
  check(selShown, "anche la selezione nell'editor del tutor mostra Chiedi a <guida>");
  await click("#ask-sel");
  check(await waitFor(`!document.getElementById("ask-sections").hidden && /protocol\\.py/.test(document.querySelector("#ask-sections [data-kind=quote] .ask-quote-label").textContent)`), "la selezione del tutor diventa la citazione della domanda");
  const quoteLabels = await evaluate<string[]>(`[...document.querySelectorAll("#ask-sections [data-kind=quote] .ask-quote-label")].map(el => el.textContent)`);
  check(quoteLabels.length === 2 && quoteLabels.every(label => label.includes("protocol.py")), "due Chiedi alla guida conservano entrambe le selezioni con file e righe");

  // terminali: Ctrl+` apre il pannello sotto il codice con una shell vera nella cartella del progetto
  const ctrlBackquote = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: "`", code: "Backquote", windowsVirtualKeyCode: 192, modifiers: 2 });
    }
    await sleep(150);
  };
  const termRows = `[...document.querySelectorAll("#term-body .term-view:not([hidden]) .xterm-rows > div")].map((d) => d.textContent).join(" ")`;
  check(await waitFor(`!document.getElementById("term-btn").hidden`), "la barra di stato offre i terminali");
  const shellTabsOnRight = () => evaluate<boolean>(`(() => {
    const body = document.getElementById("term-body").getBoundingClientRect();
    const tabs = document.getElementById("term-tabs").getBoundingClientRect();
    const rows = [...document.querySelectorAll("#term-tabs .term-tab")].map(el => el.getBoundingClientRect());
    return body.width > tabs.width && tabs.width > 0 && Math.abs(body.right - tabs.left) < 1 &&
      Math.abs(body.top - tabs.top) < 1 && rows.length > 0 &&
      rows.every((row, i) => row.left >= tabs.left && (!i || row.top >= rows[i - 1].bottom));
  })()`);
  await click("#term-btn");
  check(
    await waitFor(`!document.getElementById("term-panel").hidden && document.querySelectorAll("#term-tabs .term-tab").length === 1 && document.querySelector("#term-body .xterm-rows")`, 8000),
    "Terminali nella barra inferiore apre una shell restando in Agente",
  );
  check(await evaluate<boolean>(`document.querySelector(".editor-wrap").getBoundingClientRect().height >= 120`), "con i terminali aperti il codice resta visibile");
  check(await shellTabsOnRight(), "nel pannello in basso le schede delle shell sono a destra dell’output");
  const termFont = `parseFloat(getComputedStyle(document.querySelector(".term-view:not([hidden]) .xterm-rows")).fontSize)`;
  const initialFont = await evaluate<number>(termFont);
  const codeFont = await evaluate<string>(`getComputedStyle(document.getElementById("editor")).fontSize`);
  await click("#term-zoom-in");
  check(await waitFor(`${termFont} > ${initialFont}`) &&
    await evaluate(`getComputedStyle(document.getElementById("editor")).fontSize === ${JSON.stringify(codeFont)}`),
    "Zoom + ingrandisce il testo del terminale indipendentemente dall’editor");
  await waitFor(`!/^(Terminal|Terminale) /.test(document.querySelector("#term-tabs .term-tab").textContent)`, 8000);
  await sleep(500); // il prompt della shell
  await evaluate(`document.querySelector("#term-body .xterm-helper-textarea").focus()`);
  await typeText("echo cd-$((6*7)) $PWD");
  await press("Enter");
  const termOk = await waitFor(`/cd-42 \\S*packet-server/.test(${termRows})`, 8000);
  if (!termOk) console.log(`     terminale: ${await evaluate<string>(termRows)}`);
  check(termOk, "il terminale esegue i comandi nella cartella del progetto");
  await press("Escape");
  check(await evaluate<boolean>(`document.getElementById("title-screen").hidden`), "Esc dentro il terminale resta alla shell");
  // doppio clic sull'output "cd-42" (non sul comando) e Ctrl+Maiusc+C: la selezione va negli appunti
  const wordAt = await evaluate<{ x: number; y: number } | null>(`(() => {
    const rows = [...document.querySelectorAll("#term-body .term-view:not([hidden]) .xterm-rows > div")];
    const row = rows.find((d) => /^\\s*cd-42 /.test(d.textContent));
    if (!row) return null;
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.textContent.indexOf("cd-42");
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + 1);
      r.setEnd(n, i + 3);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  })()`);
  await evaluate(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }`);
  if (wordAt) {
    for (const clickCount of [1, 2]) for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: wordAt.x, y: wordAt.y, button: "left", clickCount });
    }
    for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "C", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 10 });
  }
  check(!!wordAt && await waitFor(`window.__copied === "cd-42"`, 3000), "Ctrl+Maiusc+C copia la selezione del terminale");
  await click("#terminals-tab");
  check(await waitFor(`document.getElementById("agent-workspace").hidden && document.querySelector("#terminal-workspace #term-panel").clientHeight > innerHeight / 2 && /cd-42/.test(${termRows})`),
    "la scheda Terminali occupa l’area di lavoro e riprende la stessa shell");
  await click("#term-new");
  check(await waitFor(`document.querySelectorAll("#term-tabs .term-tab").length === 2 && document.querySelectorAll("#term-body .term-view:not([hidden])").length === 1`, 8000), "+ apre un secondo terminale in una scheda nuova");
  await waitFor(`!/^(Terminal|Terminale) /.test(document.querySelector("#term-tabs .is-active").textContent)`);
  check(await evaluate(`${termFont} > ${initialFont}`), "una nuova shell nella scheda Terminali eredita lo zoom");
  check(await shellTabsOnRight(), "nella vista Terminali le due shell sono impilate nella colonna destra");
  await evaluate(`document.querySelector("#term-tabs .is-active").focus()`);
  await press("ArrowUp");
  check(await waitFor(`document.activeElement.matches('#term-tabs .term-tab:first-child.is-active') && /cd-42/.test(${termRows})`),
    "Freccia su nella lista seleziona la shell precedente");
  await press("ArrowDown");
  check(await evaluate(`document.activeElement.matches('#term-tabs .term-tab:last-child.is-active')`), "Freccia giù torna alla seconda shell");
  await click("#term-zoom-out");
  check(await waitFor(`${termFont} === ${initialFont}`), "Zoom − ripristina la misura precedente");
  await typeText("echo secondo-$((8*9))");
  await press("Enter");
  check(await waitFor(`/secondo-72/.test(${termRows})`), "la seconda scheda usa una shell indipendente");
  const outputLine = await evaluate<{ x: number; y: number }>(`(() => {
    const row = [...document.querySelectorAll("#term-body .term-view:not([hidden]) .xterm-rows > div")].find(el => el.textContent.trim() === "secondo-72");
    const rect = row.getBoundingClientRect();
    return { x: rect.left + 8, y: rect.top + rect.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, ...outputLine, button: "left", clickCount: 3 });
  }
  await click("#term-share");
  check(await waitFor(`document.querySelector("#ask-sections [data-kind=output] .ask-quote-text").textContent.trim() === "secondo-72"`),
    "Allega selezione prepara la sola riga scelta nel terminale");
  await click("#terminals-tab");
  // Un clic nella shell toglie la selezione prima della prova sulla cronologia.
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, ...outputLine, button: "left", clickCount: 1 });
  }
  await viewport(390, 844);
  check(await shellTabsOnRight(), "a 390 px le due schede restano a destra con spazio per la shell");
  check(await inView("term-share") && await inView("term-new") && await noOverflow(), "a 390 px si possono creare terminali e allegarne l’output");
  await click("#term-share");
  check(await waitFor(`document.getElementById("terminal-workspace").hidden && !document.getElementById("ask-sections").hidden && document.activeElement.id === "ask-input"`),
    "Allega cronologia prepara la domanda nella scheda Agente");
  check(await evaluate(`document.querySelectorAll("#ask-sections li").length === 4`) && await inView("ask-sections") && await noOverflow(),
    "a 390 px due sezioni di codice e due allegati del terminale restano nella lista");
  await click("#ask-sections li:nth-child(3) button");
  const kept = await evaluate<string[]>(`[...document.querySelectorAll("#ask-sections .ask-quote-label")].map(el => el.textContent)`);
  check(kept.length === 3 && quoteLabels.every((label, i) => kept[i] === label) && kept[2].startsWith("3."), "togliere un allegato intermedio conserva e rinumera gli altri");
  await evaluate(`document.getElementById("ask-input").value = "Risultato della seconda shell?"`);
  await press("Enter");
  await waitFor(`document.getElementById("ask-sections").hidden`);
  const shellQueue = (await callTool("get_user_questions", {})).content[0].text;
  const shellQuestion = JSON.parse(shellQueue.slice(shellQueue.indexOf("\n"))).find(q => q.text === "Risultato della seconda shell?");
  const sharedShell = shellQuestion?.textBytes && (await callTool("read_question_text", { question_id: shellQuestion.id })).content[0].text;
  check(sharedShell && sharedShell.includes("echo secondo-") && sharedShell.includes("secondo-72") && !sharedShell.includes("cd-42"), "l’agente legge solo la cronologia della shell allegata");
  const sectionsText = sharedShell && JSON.parse(sharedShell.slice(sharedShell.indexOf("\n"))).text;
  check(sectionsText && sectionsText.startsWith(kept[0] + "\n") && sectionsText.indexOf(kept[1] + "\n") > 0 &&
    sectionsText.indexOf(kept[2] + "\n") > sectionsText.indexOf(kept[1] + "\n") && !sectionsText.includes("\n4. "),
    "l'agente legge tutte e sole le sezioni rimaste nello stesso ordine della bozza");
  await viewport(1400, 900);
  await click("#term-tabs .term-tab:last-child .tab-close");
  check(await waitFor(`document.querySelectorAll("#term-tabs .term-tab").length === 1 && document.querySelectorAll("#term-body .term-view").length === 1`), "× chiude il terminale");
  const editorHeight = await evaluate<number>(`document.querySelector(".editor-wrap").clientHeight`);
  const termH = await evaluate<number>(`document.getElementById("term-panel").getBoundingClientRect().height`);
  await evaluate(`document.getElementById("split-term").focus()`);
  await press("ArrowUp");
  check(
    (await evaluate<number>(`document.getElementById("term-panel").getBoundingClientRect().height`)) > termH + 10 &&
      typeof (await evaluate<any>(`JSON.parse(localStorage.getItem("code-dungeon:layout")).term`)) === "number",
    "il divisore allarga i terminali e la misura resta salvata",
  );
  check(await evaluate(`document.querySelector(".editor-wrap").clientHeight === ${editorHeight} &&
    Math.abs(document.getElementById("term-panel").getBoundingClientRect().bottom - document.querySelector(".editor-wrap").getBoundingClientRect().bottom) < 2`),
    "il terminale si sovrappone al fondo dell’editor senza ridimensionarlo");
  const desktopGrip = await evaluate<{ x: number; y: number; height: number }>(`(() => {
    const r = document.getElementById("split-term").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, height: document.getElementById("term-panel").clientHeight };
  })()`);
  for (const [type, dy] of [["mousePressed", 0], ["mouseMoved", 32], ["mouseReleased", 32]] as const) {
    await send("Input.dispatchMouseEvent", { type, x: desktopGrip.x, y: desktopGrip.y + dy, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  }
  check(await waitFor(`document.getElementById("term-panel").clientHeight < ${desktopGrip.height - 20} && document.querySelector(".editor-wrap").clientHeight === ${editorHeight}`),
    "il bordo del pannello segue il mouse senza spostare l’editor");
  await viewport(390, 844);
  check(await noOverflow(), "a 390 px i terminali non allargano la pagina");
  check(await evaluate<boolean>(`document.querySelector(".editor-wrap").getBoundingClientRect().height >= 100`), "a 390 px con i terminali il codice resta visibile");
  const grip = await evaluate<{ x: number; y: number; height: number; editor: number }>(`(() => {
    const r = document.getElementById("split-term").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, height: document.getElementById("term-panel").clientHeight, editor: document.querySelector(".editor-wrap").clientHeight };
  })()`);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: grip.x, y: grip.y }] });
  await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: grip.x, y: grip.y + 40 }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  const dragWorked = await waitFor(`document.getElementById("term-panel").clientHeight < ${grip.height - 20} && document.querySelector(".editor-wrap").clientHeight === ${grip.editor}`);
  check(dragWorked && await inView("term-zoom-in") && await inView("term-zoom-out"), "a 390 px si trascina il bordo sopra il codice e si raggiungono i pulsanti Zoom");
  await viewport(1400, 900);
  await ctrlBackquote();
  check(await waitFor(`document.getElementById("term-panel").hidden && document.getElementById("term-btn").getAttribute("aria-pressed") === "false"`), "Ctrl+` richiude il pannello");
  await click("#chat-btn");
  await click("#term-btn");
  check(await waitFor(`!document.getElementById("agent-workspace").hidden && document.getElementById("term-panel").getBoundingClientRect().height > 50 && /cd-42/.test(${termRows})`) &&
    await inView("ask-input"), "nella chat Agente il terminale si apre in basso e la domanda resta accessibile");
  await ctrlBackquote();
  await click("#terminals-tab");
  check(await waitFor(`document.getElementById("term-panel").clientHeight > innerHeight / 2 && /cd-42/.test(${termRows})`),
    "anche dalla chat si ritrova la prima shell con il suo output");
  await click("#agent-tab");
  check(await evaluate(`document.getElementById("app").classList.contains("is-chat") && document.getElementById("term-panel").hidden`),
    "Agente ripristina la chat e il pannello del terminale chiuso");
  await click("#chat-btn");
  // /term accetta solo il gioco: un'altra pagina su localhost non apre una shell
  const termFrom = (origin: string) =>
    new Promise<boolean>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${PORT}/term?cols=80&rows=24`, { origin });
      s.on("open", () => {
        s.close();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
  check(!(await termFrom("http://localhost:3000")) && (await termFrom(`http://127.0.0.1:${PORT}`)), "/term rifiuta le altre pagine su localhost");

  // campo della domanda: Maiusc+Invio va a capo e il campo cresce, Invio manda
  const askH = () => evaluate<number>(`document.getElementById("ask-input").getBoundingClientRect().height`);
  await evaluate(`(() => { const i = document.getElementById("ask-input"); i.value = ""; i.focus(); })()`);
  const h1 = await askH();
  await typeText("prima riga");
  await press("Enter", 8);
  await typeText("seconda riga");
  await press("Enter", 8);
  await typeText("terza riga");
  check(
    (await evaluate<string>(`document.getElementById("ask-input").value`)) === "prima riga\nseconda riga\nterza riga" && (await askH()) > h1 + 20,
    "Maiusc+Invio va a capo e il campo della domanda cresce",
  );
  // Ritarda il primo giro del timer del brano mentre l'orologio Web Audio continua.
  const lagged = await evaluate<{ late: number; played: number; delayed: boolean }>(`(async () => {
    const music = id => {
      const radio = document.getElementById("opt-music-" + id);
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    };
    music("off");
    const originalInterval = window.setInterval;
    const proto = AudioScheduledSourceNode.prototype;
    const originalStart = proto.start;
    let delayed = false;
    let late = 0, played = 0;
    try {
      const resumeAt = performance.now() + 1000;
      window.setInterval = (fn, ms) => originalInterval(() => {
        if (performance.now() < resumeAt) delayed = true;
        else fn();
      }, ms);
      music("taverna");
      window.setInterval = originalInterval;
      proto.start = function (when) {
        if (when < this.context.currentTime - 0.03) late++;
        played++;
        return originalStart.call(this, when);
      };
      await new Promise(resolve => setTimeout(resolve, 1800));
      return { late, played, delayed };
    } finally {
      proto.start = originalStart;
      window.setInterval = originalInterval;
      music("off");
    }
  })()`);
  check(lagged.delayed && lagged.late === 0 && lagged.played > 0,
    `con un timer musicale in ritardo il brano prosegue (${lagged.played} note, ${lagged.late} scadute)`);
  // suono dei tasti: si conta quanti suoni nascono scrivendo, acceso e spento dal menu
  // la musica crea oscillatori anche lei: si spegne, così si contano solo i tasti
  await evaluate(`(() => { const r = document.getElementById("opt-music-off"); r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); document.getElementById("ask-input").focus(); })()`);
  await evaluate(`(() => {
    window.__osc = 0;
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () { window.__osc++; return orig.call(this); };
  })()`);
  for (const ch of "abc") await press(ch);
  const withKeys = await evaluate<number>(`window.__osc`);
  await evaluate(`(() => { const c = document.getElementById("keys-on"); c.checked = false; c.dispatchEvent(new Event("change")); window.__osc = 0; document.getElementById("ask-input").focus(); })()`);
  for (const ch of "def") await press(ch);
  const withoutKeys = await evaluate<number>(`window.__osc`);
  check(withKeys >= 3 && withoutKeys <= 1, `i tasti suonano mentre si scrive e si spengono dal menu (${withKeys} / ${withoutKeys})`);
  await evaluate(`(() => { const c = document.getElementById("keys-on"); c.checked = true; c.dispatchEvent(new Event("change")); const i = document.getElementById("ask-input"); i.value = i.value.replace(/abcdef$/, ""); i.focus(); })()`);
  await press("Enter");
  check(await waitFor(`document.getElementById("ask-input").value === ""`), "Invio manda la domanda");
  check((await askH()) < h1 + 4, "mandata la domanda il campo torna di una riga");
  const smallPng = (await fs.readFile("src-tauri/icons/32x32.png")).toString("base64");
  const largePng = (await fs.readFile("src-tauri/icons/64x64.png")).toString("base64");
  const pasteImages = (...images: string[]) => evaluate(`(() => {
    const input = document.getElementById("ask-input");
    const data = new DataTransfer();
    ${JSON.stringify(images)}.forEach((b64, i) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      data.items.add(new File([bytes], "appunti-" + i + ".png", { type: "image/png" }));
    });
    input.focus();
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  const receivedImages = async (caption: string) => {
    const result = await callTool("get_user_questions", {});
    const summary = result?.content?.[0]?.text ?? "";
    const question = JSON.parse(summary.slice(summary.indexOf("\n"))).find((q) => q.text === caption && q.imageCount === 1);
    return question ? result.content.filter((item) => item.type === "image") : [];
  };
  await pasteImages(smallPng, largePng);
  check(await waitFor(`[...document.querySelectorAll("#ask-images img")].filter((img) => img.naturalWidth).length === 2`), "incollare più immagini mostra le miniature prima dell'invio");
  await click("#ask-images li:first-child button");
  check(await evaluate(`document.querySelectorAll("#ask-images img").length === 1 && document.activeElement.id === "ask-input"`), "un'immagine si può rimuovere lasciando le altre negli allegati");
  await typeText("Che cosa vedi nello screenshot?");
  await press("Enter");
  check(await waitFor(`document.getElementById("ask-images").hidden && document.getElementById("ask-input").value === ""`) &&
    (await receivedImages("Che cosa vedi nello screenshot?"))[0]?.data === largePng, "il browser invia all'agente il testo e l'immagine rimasta");
  await viewport(390, 844);
  check(await noOverflow(), "a 390 px il campo della domanda non allarga la pagina");
  await pasteImages(smallPng);
  check(await waitFor(`document.querySelector("#ask-images img")?.naturalWidth === 32`) && await inView("ask-images") && await noOverflow(), "a 390 px l'anteprima incollata resta nello schermo");
  await click("#ask-submit");
  check(await waitFor(`document.getElementById("ask-images").hidden`) &&
    (await receivedImages(""))[0]?.data === smallPng, "a 390 px si può inviare un'immagine anche senza testo");
  await evaluate(`navigator.clipboard.readText = async () => "exit 1"`);
  await evaluate(`document.getElementById("ask-input").focus()`);
  await typeText("Come mai?");
  await click("#ask-paste-output");
  check(await waitFor(`document.querySelector("#ask-sections [data-kind=output] .ask-quote-text").textContent === "exit 1" && document.activeElement.id === "ask-input" && document.activeElement.value === "Come mai?"`) &&
    await inView("ask-paste-output") && await noOverflow(), "a 390 px il pulsante allega anche una riga e conserva la domanda");
  await click("#ask-sections [data-kind=output] button");
  check(await evaluate(`document.getElementById("ask-sections").hidden && document.activeElement.value === "Come mai?"`), "si può togliere soltanto l’output breve");
  await evaluate(`navigator.clipboard.readText = async () => { throw new DOMException("denied", "NotAllowedError"); }`);
  await click("#ask-paste-output");
  check(await waitFor(`!document.getElementById("ask-image-status").hidden && document.activeElement.id === "ask-input"`), "se il browser blocca gli appunti si può incollare nel campo");
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "exit 1");
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await press("Enter");
  check(await waitFor(`document.getElementById("ask-input").value === "" && document.getElementById("ask-sections").hidden`), "la domanda con l’allegato breve viene inviata");
  const shortQueue = (await callTool("get_user_questions", {})).content[0].text;
  const shortQuestion = JSON.parse(shortQueue.slice(shortQueue.indexOf("\n"))).find((q) => q.text === "Come mai?");
  const shortPage = shortQuestion?.textBytes === 6 && (await callTool("read_question_text", { question_id: shortQuestion.id })).content[0].text;
  check(shortPage && JSON.parse(shortPage.slice(shortPage.indexOf("\n"))).text === "exit 1", "l’agente riceve anche l’output breve come allegato di testo");
  const log = "passo completato\n".repeat(9000) + "ULTIMO ERRORE 🪲\n";
  const pasteLog = () => evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(log)});
    const input = document.getElementById("ask-input");
    input.focus();
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await pasteLog();
  check(await inView("ask-sections") && await noOverflow(), "a 390 px il log lungo compare come allegato compatto");
  await click("#ask-sections [data-kind=output] button");
  await typeText("Spiega");
  await pasteLog();
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "a".repeat(5 * 1024 * 1024));
    document.getElementById("ask-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  check(await evaluate(`document.getElementById("ask-image-status").textContent.includes("5 MiB")`), "un secondo incolla oltre il limite avvisa e conserva il log precedente");
  await typeText(" la fine");
  check(await evaluate(`document.getElementById("ask-input").value === "Spiega la fine"`), "si può scrivere prima e dopo il log incollato");
  await press("Enter");
  check(await waitFor(`document.getElementById("ask-sections").hidden && document.getElementById("ask-input").value === ""`), "il log si libera dopo la conferma del ponte");
  const queuedLog = (await callTool("get_user_questions", {})).content[0].text;
  const logQuestion = JSON.parse(queuedLog.slice(queuedLog.indexOf("\n"))).find((q) => q.text === "Spiega la fine");
  check(logQuestion?.textBytes === Buffer.byteLength(log) &&
    (await callTool("read_question_text", { question_id: logQuestion.id, offset: logQuestion.textBytes - 100 })).content[0].text.includes("ULTIMO ERRORE 🪲"),
    "l’agente riceve la domanda e legge l’ultima riga del log");
  await viewport(1400, 900);

  // guida a destra: colonna a tutta altezza accanto al codice, divisore verticale, sul telefono torna sotto
  const rectOf = (sel: string) => evaluate<DOMRect>(`JSON.parse(JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect()))`);
  await click("#dialog-dock");
  await sleep(200);
  let ed = await rectOf(".editor-wrap");
  let dl = await rectOf("#dialog");
  check(
    (await evaluate<boolean>(`document.querySelector(".main").classList.contains("is-dialog-right")`)) && dl.left >= ed.right && dl.height > 500 && ed.height > 500,
    "il pulsante sposta la guida a destra del codice, a tutta altezza",
  );
  check(await waitFor(`document.getElementById("split-dialog").getAttribute("aria-orientation") === "vertical"`), "a destra il divisore della guida è verticale");
  await evaluate(`document.getElementById("split-dialog").focus()`);
  await press("ArrowLeft");
  check((await rectOf("#dialog")).width > dl.width + 10, "le frecce allargano la guida a destra");
  await ctrlBackquote();
  await waitFor(`!document.getElementById("term-panel").hidden`, 8000);
  const tp = await rectOf("#term-panel");
  check(tp.right <= (await rectOf("#dialog")).left && Math.abs(tp.bottom - (await rectOf(".editor-wrap")).bottom) < 2, "con la guida a destra i terminali coprono solo il fondo dell’editor");
  if (process.env.SCREENSHOT) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(process.env.SCREENSHOT, "guida-destra.png"), Buffer.from(shot.data, "base64"));
  }
  await ctrlBackquote();
  await viewport(390, 844);
  ed = await rectOf(".editor-wrap");
  dl = await rectOf("#dialog");
  check(dl.top >= ed.bottom - 1 && (await noOverflow()), "a 390 px la guida torna sotto il codice");
  await viewport(1400, 900);
  // il ponte ripropone la scena: dopo il ricaricamento il menu può non comparire
  await send("Page.navigate", { url: URL_GAME });
  check(await waitFor(`document.readyState === "complete" && document.querySelector(".main").classList.contains("is-dialog-right") && document.getElementById("dialog-dock").getAttribute("aria-pressed") === "true"`), "la guida a destra resta dopo il ricaricamento");
  await click("#dialog-dock");
  check(!(await evaluate<boolean>(`document.querySelector(".main").classList.contains("is-dialog-right")`)), "di nuovo il pulsante la riporta sotto");

  // uscita a clip dell'app su Linux: suoni calcolati in WAV e suonati da elementi <audio>
  await send("Page.navigate", { url: `${URL_GAME}?audio=clips` });
  await waitFor(`document.readyState === "complete"`);
  // un clic vero (Maiusc da solo non conta come gesto): sblocca l'audio
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: 2, y: 2, button: "left", clickCount: 1 });
  await evaluate(`(() => { const r = document.getElementById("opt-music-taverna"); r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  check(
    await waitFor(`(() => { const m = document.querySelector("audio.cd-music"); return !!m && m.src.startsWith("blob:") && !m.paused && m.duration > 5; })()`, 10000),
    "con ?audio=clips la musica è un WAV calcolato che suona in loop da un elemento <audio>",
  );

  check(errors.length === 0, `nessun errore JavaScript nella pagina${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} catch (e) {
  failures++;
  console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  ws.close();
  await cleanup();
}

console.log(failures === 0 ? "\nTutti i controlli passati." : `\n${failures} controlli falliti.`);
process.exit(failures === 0 ? 0 : 1);
