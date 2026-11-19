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
const KEYS: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27 };
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
    await waitFor(`document.getElementById("edit-error").hidden && !document.getElementById("ask-output").hidden && document.activeElement?.id === "ask-input"`),
    "l'output resta allegato sopra il campo della domanda",
  );
  await press("Enter");
  await waitFor(`window.__questions.length === 2`);
  q = await lastQuestion();
  check(/NameError/.test(q?.context.output) && !q.context.changed && (await evaluate(`document.getElementById("ask-output").hidden`)), "l'output parte con la domanda, senza righe cambiate se il codice è lo stesso");
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
  await click(`#file-list .dir[data-dir="lib"] .dir-btn`);
  check(
    (await visible(`#file-list .file[data-path="lib/util.py"]`)) && !(await visible(`#file-list .file[data-path="lib/deep/inner.py"]`)) &&
      (await evaluate(`document.querySelector('#file-list .dir[data-dir="lib"] .dir-btn').getAttribute("aria-expanded") === "true"`)),
    "il clic apre la cartella, quelle dentro restano chiuse",
  );

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

  // risposte formattate (dopo l'ultimo ricaricamento: il ponte rimanda l'ultimo fumetto e chiuderebbe il menu): paragrafi, elenchi, codice e link, senza apici inversi visibili
  const RICH = "Due fonti:\n\n- Indice: https://docs.pwntools.com.\n- Classe `ELF(\"./vuln\")`, vedi [la pagina](https://docs.pwntools.com/en/stable/elf/elf.html)\n\n1. Web\n2. **Offline**";
  await callTool("show_dialog", { text: RICH });
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

  check(await noOverflow(), "a 390 px elenchi e indirizzi lunghi vanno a capo senza scorrimento orizzontale");

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
    (await waitFor(`!document.getElementById("ask-quote").hidden && /2.*4/.test(document.getElementById("ask-quote-label").textContent)`)) &&
      (await evaluate<number>(`document.querySelectorAll("#editor .line.is-picked").length`)) === 0,
    "Chiedi a <guida> cita le righe scelte",
  );
  await click("#ask-quote-clear");
  // tutor: la selezione dentro la textarea
  await evaluate(`(() => { const ta = document.getElementById("code-input"); ta.focus(); ta.setSelectionRange(0, ta.value.indexOf("\\n", 40)); })()`);
  await sleep(300); // la focus fa scorrere l'editor, e lo scorrimento nasconde il pulsante
  await press("Shift");
  check(await waitFor(`!document.getElementById("ask-sel").hidden`), "anche la selezione nell'editor del tutor mostra Chiedi a <guida>");
  await click("#ask-sel");
  check(await waitFor(`!document.getElementById("ask-quote").hidden && /protocol\\.py/.test(document.getElementById("ask-quote-label").textContent)`), "la selezione del tutor diventa la citazione della domanda");
  await click("#ask-quote-clear");

  // terminali: Ctrl+` apre il pannello sotto il codice con una shell vera nella cartella del progetto
  const ctrlBackquote = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: "`", code: "Backquote", windowsVirtualKeyCode: 192, modifiers: 2 });
    }
    await sleep(150);
  };
  const termRows = `[...document.querySelectorAll("#term-body .term-view:not([hidden]) .xterm-rows > div")].map((d) => d.textContent).join(" ")`;
  check(await waitFor(`!document.getElementById("term-btn").hidden`), "la barra di stato offre i terminali");
  await ctrlBackquote();
  check(
    await waitFor(`!document.getElementById("term-panel").hidden && document.querySelectorAll("#term-tabs .term-tab").length === 1 && document.querySelector("#term-body .xterm-rows")`, 8000),
    "Ctrl+` apre il pannello dei terminali con un terminale",
  );
  check(await evaluate<boolean>(`document.querySelector(".editor-wrap").getBoundingClientRect().height >= 120`), "con i terminali aperti il codice resta visibile");
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
  await click("#term-new");
  check(await waitFor(`document.querySelectorAll("#term-tabs .term-tab").length === 2 && document.querySelectorAll("#term-body .term-view:not([hidden])").length === 1`, 8000), "+ apre un secondo terminale in una scheda nuova");
  await click("#term-tabs .term-tab:last-child .tab-close");
  check(await waitFor(`document.querySelectorAll("#term-tabs .term-tab").length === 1 && document.querySelectorAll("#term-body .term-view").length === 1`), "× chiude il terminale");
  const termH = await evaluate<number>(`document.getElementById("term-panel").getBoundingClientRect().height`);
  await evaluate(`document.getElementById("split-term").focus()`);
  await press("ArrowUp");
  check(
    (await evaluate<number>(`document.getElementById("term-panel").getBoundingClientRect().height`)) > termH + 10 &&
      typeof (await evaluate<any>(`JSON.parse(localStorage.getItem("code-dungeon:layout")).term`)) === "number",
    "il divisore allarga i terminali e la misura resta salvata",
  );
  await viewport(390, 844);
  check(await noOverflow(), "a 390 px i terminali non allargano la pagina");
  check(await evaluate<boolean>(`document.querySelector(".editor-wrap").getBoundingClientRect().height >= 100`), "a 390 px con i terminali il codice resta visibile");
  await viewport(1400, 900);
  await ctrlBackquote();
  check(await waitFor(`document.getElementById("term-panel").hidden && document.getElementById("term-btn").getAttribute("aria-pressed") === "false"`), "Ctrl+` richiude il pannello");
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
  await press("Enter");
  check(await waitFor(`document.getElementById("ask-input").value === ""`), "Invio manda la domanda");
  check((await askH()) < h1 + 4, "mandata la domanda il campo torna di una riga");
  await viewport(390, 844);
  check(await noOverflow(), "a 390 px il campo della domanda non allarga la pagina");
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
  check(tp.right <= (await rectOf("#dialog")).left && tp.top >= (await rectOf(".editor-wrap")).bottom - 1, "i terminali stanno sotto il codice, accanto alla guida");
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
