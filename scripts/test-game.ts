// Prova del gioco nel browser: avvia il ponte in modalità play sul progetto d'esempio, apre Chromium headless
// e lo pilota via DevTools Protocol (menu, tour, modalità chat e storico salvato, divisori, layout a 1400 e a 390 px).
//   npm run build:game && npm run test:game
// Il browser si sceglie con CHROME_PATH; altrimenti si cerca chromium o google-chrome nel PATH.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const PORT = 7400 + Math.floor(Math.random() * 500);
const project = path.resolve("examples/packet-server");
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

const server = spawn("npx", ["tsx", "src/server/cli.ts", "play", "--project", project, "--port", String(PORT)], {
  env: { ...process.env, CODE_DUNGEON_DATA: path.join(tmp, "data") },
  stdio: ["ignore", "ignore", "pipe"],
});
children.push(server);
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
ws.on("message", (d) => {
  const msg = JSON.parse(String(d));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
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
const press = async (key: string) => {
  const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
  const text = key.length === 1 ? key : undefined;
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, windowsVirtualKeyCode: code, text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code });
  await sleep(120);
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
