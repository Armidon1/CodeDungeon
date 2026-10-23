// Più sessioni aperte insieme: ogni agente con Code Dungeon apre un ponte sulla prima porta libera da 7337.
// Il gioco le trova con GET /session, le elenca e passa da una all'altra.

import { t } from "./i18n";
import { isDesktopApp } from "./source";
import type { SessionInfo } from "../shared/types";

/** Porte che il ponte prova in ordine (PORT_TRIES in bridge.ts). */
const BRIDGE_PORTS = Array.from({ length: 20 }, (_, i) => 7337 + i);
const PREF_KEY = "code-dungeon.session-port";
/** Ogni quanto l'elenco aperto si aggiorna, così compaiono le sessioni nuove. */
const RESCAN_MS = 2000;

export const bridgeUrl = (port: number): string => `ws://127.0.0.1:${port}/ws`;

/** Pagina servita da un ponte (http://127.0.0.1:7337 e successive), non dall'app né da `npm run dev`. */
export function servedByBridge(): boolean {
  return !isDesktopApp() && location.protocol.startsWith("http") && !!location.port && location.port !== "5173";
}

/** Sessioni che rispondono ora, dalla porta più bassa. */
export async function scanSessions(timeoutMs = 1200): Promise<SessionInfo[]> {
  const probe = async (port: number): Promise<SessionInfo | undefined> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      if (!res.ok) return undefined;
      const info = (await res.json()) as SessionInfo;
      return typeof info.project === "string" ? { ...info, port } : undefined;
    } catch {
      return undefined;
    }
  };
  const found = await Promise.all(BRIDGE_PORTS.map(probe));
  return found.filter((s): s is SessionInfo => s !== undefined);
}

/** Porta scelta in questa finestra: sopravvive al ricaricamento, non agli altri avvii. */
function preferredPort(): number | undefined {
  try {
    const v = Number(sessionStorage.getItem(PREF_KEY));
    return Number.isInteger(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function setPreferredPort(port: number): void {
  try {
    sessionStorage.setItem(PREF_KEY, String(port));
  } catch {
    // senza sessionStorage si sceglie di nuovo dopo un ricaricamento
  }
}

/**
 * Indirizzo del ponte a cui collegarsi, cercato a ogni tentativo (app desktop e `npm run dev`).
 * Resta sulla sessione scelta finché c'è; con una sola sessione la prende; con più chiede all'utente.
 */
export async function resolveBridge(): Promise<string | undefined> {
  const sessions = await scanSessions();
  if (sessions.length === 0) return undefined;
  const pref = preferredPort();
  const chosen =
    sessions.find((s) => s.port === pref) ?? (sessions.length === 1 ? sessions[0] : ((await pickSession(sessions)) ?? sessions[0]));
  setPreferredPort(chosen.port);
  return bridgeUrl(chosen.port);
}

/** Passa a un'altra sessione: la pagina si ricarica collegata a lei. */
export function switchSession(port: number): void {
  if (servedByBridge()) {
    location.href = `http://127.0.0.1:${port}/`;
    return;
  }
  setPreferredPort(port);
  const url = new URL(location.href);
  url.searchParams.delete("ponte");
  location.replace(url.toString());
}

/**
 * Mostra l'elenco delle sessioni e risolve con quella scelta (undefined se l'utente chiude).
 * initial: elenco già pronto; current: porta della sessione attuale, segnata nell'elenco.
 */
export function pickSession(initial?: SessionInfo[], current?: number): Promise<SessionInfo | undefined> {
  const dialog = document.getElementById("session-picker") as HTMLDialogElement;
  const list = document.getElementById("session-list") as HTMLUListElement;
  const msg = document.getElementById("session-msg") as HTMLParagraphElement;
  const closeBtn = document.getElementById("session-close") as HTMLButtonElement;

  return new Promise((resolve) => {
    let sessions = initial;
    let done = false;
    // finché l'elenco non arriva il fuoco sta su Chiudi; poi passa alla sessione attuale
    let focusFirst = !initial;
    const render = () => {
      if (!sessions) {
        msg.textContent = t().msg.sessionsLooking;
        list.replaceChildren();
        return;
      }
      msg.textContent = sessions.length ? t().msg.sessionsIntro : t().msg.sessionsNone;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.port : undefined;
      list.replaceChildren(
        ...sessions.map((s) => {
          const li = document.createElement("li");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "tour-item session-item";
          btn.dataset.port = String(s.port);
          if (s.port === current) btn.setAttribute("aria-current", "true");
          const title = document.createElement("span");
          title.className = "tour-title";
          title.textContent = s.project;
          const meta = document.createElement("span");
          meta.className = "tour-meta";
          meta.textContent = t().msg.sessionMeta(s.port, s.agent) + (s.port === current ? ` · ${t().msg.sessionCurrent}` : "");
          btn.append(title, meta);
          btn.addEventListener("click", () => finish(s));
          li.append(btn);
          return li;
        }),
      );
      if (focused) list.querySelector<HTMLElement>(`[data-port="${focused}"]`)?.focus();
      else if (focusFirst && sessions.length && document.activeElement === closeBtn) focusSession();
      focusFirst = false;
    };
    const focusSession = () =>
      (list.querySelector<HTMLElement>("[aria-current]") ?? list.querySelector<HTMLElement>("button") ?? closeBtn).focus();
    const rescan = async () => {
      sessions = await scanSessions();
      if (!done) render();
    };
    const timer = setInterval(() => void rescan(), RESCAN_MS);
    const finish = (s: SessionInfo | undefined) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      closeBtn.removeEventListener("click", onClose);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(s);
    };
    const onClose = () => finish(undefined);
    closeBtn.addEventListener("click", onClose);
    dialog.addEventListener("close", onClose);

    render();
    if (!initial) void rescan();
    if (!dialog.open) dialog.showModal();
    focusSession();
  });
}
