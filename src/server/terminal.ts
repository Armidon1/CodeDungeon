// Terminali del gioco: una shell vera nella cartella del progetto, per l'utente.
// L'agente non ha strumenti MCP per usarli: ciò che scrive arriva solo dal gioco, attraverso /term
// (stesso controllo dell'origine del ponte, solo su 127.0.0.1).
// Con @lydell/node-pty (dipendenza facoltativa, binari precompilati) la shell ha un terminale vero:
// colori, programmi interattivi, ridimensionamento. Senza, si ripiega su una shell con le pipe.
// È l'unico posto in cui il ponte avvia processi: la shell non passa da resolveInside(), è dell'utente come quella del suo terminale.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { WebSocket } from "ws";
import type { TermClientMessage, TermServerMessage } from "../shared/types.js";
import { log } from "./log.js";

/** Quanti terminali aperti insieme, tra tutte le finestre del gioco. */
export const TERMINALS_MAX = 8;

interface Pty {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): Pty };

let ptyModule: PtyModule | null | undefined;
function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = createRequire(import.meta.url)("@lydell/node-pty") as PtyModule;
  } catch (e) {
    log(`node-pty non disponibile, terminali con le pipe: ${e instanceof Error ? e.message : String(e)}`);
    ptyModule = null;
  }
  return ptyModule;
}

function shell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.COMSPEC || "powershell.exe", args: [] };
  return { file: process.env.SHELL || "/bin/bash", args: [] };
}

const clamp = (n: unknown, lo: number, hi: number, def: number) => (typeof n === "number" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def);

export class Terminals {
  private open = new Set<() => void>();

  constructor(private root: string) {}

  get count(): number {
    return this.open.size;
  }

  /** Un WebSocket di /term è un terminale: si chiude il socket, si chiude la shell (e viceversa). */
  attach(ws: WebSocket, cols0: number, rows0: number): void {
    const send = (m: TermServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    if (this.open.size >= TERMINALS_MAX) {
      send({ t: "x", code: -1, error: `Al massimo ${TERMINALS_MAX} terminali aperti.` });
      ws.close();
      return;
    }
    const { file, args } = shell();
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", CODE_DUNGEON_TERMINAL: "1" };
    const cols = clamp(cols0, 10, 500, 80);
    const rows = clamp(rows0, 3, 200, 24);
    const pty = loadPty();
    let write: (d: string) => void;
    let resize: (c: number, r: number) => void = () => {};
    let kill: () => void;
    let exited = false;
    const exit = (code: number) => {
      if (exited) return;
      exited = true;
      this.open.delete(kill);
      send({ t: "x", code });
      ws.close();
    };
    try {
      if (pty) {
        const p = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd: this.root, env });
        p.onData((d) => send({ t: "o", d }));
        p.onExit((e) => exit(e.exitCode));
        write = (d) => p.write(d);
        resize = (c, r) => p.resize(c, r);
        kill = () => p.kill();
      } else {
        // senza terminale vero: niente eco né prompt dalla shell, li fa il gioco (pipe: true)
        const p = spawn(file, args, { cwd: this.root, env, stdio: "pipe" });
        p.stdout.setEncoding("utf8").on("data", (d: string) => send({ t: "o", d: d.replace(/\r?\n/g, "\r\n") }));
        p.stderr.setEncoding("utf8").on("data", (d: string) => send({ t: "o", d: d.replace(/\r?\n/g, "\r\n") }));
        p.on("exit", (code) => exit(code ?? 0));
        p.on("error", (e) => {
          send({ t: "o", d: `${e.message}\r\n` });
          exit(-1);
        });
        write = (d) => p.stdin.write(d.replace(/\r/g, "\n"));
        kill = () => p.kill();
      }
    } catch (e) {
      send({ t: "x", code: -1, error: e instanceof Error ? e.message : String(e) });
      ws.close();
      return;
    }
    this.open.add(kill);
    send({ t: "ready", shell: file.split(/[\\/]/).pop()!, cwd: this.root, pipe: !pty });
    ws.on("message", (raw) => {
      let msg: TermClientMessage;
      try {
        msg = JSON.parse(String(raw)) as TermClientMessage;
      } catch {
        return;
      }
      if (msg.t === "i" && typeof msg.d === "string") write(msg.d);
      else if (msg.t === "r") resize(clamp(msg.cols, 10, 500, cols), clamp(msg.rows, 3, 200, rows));
    });
    ws.on("close", () => {
      if (exited) return;
      exited = true;
      this.open.delete(kill);
      kill();
    });
  }

  /** Chiude tutte le shell (uscita del server). */
  closeAll(): void {
    for (const kill of this.open) kill();
    this.open.clear();
  }
}
