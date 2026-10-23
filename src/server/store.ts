// Preferenze del giocatore in SQLite: impostazioni del gioco e risposte al questionario sull'accessibilità.
// Il file sta nella cartella dati dell'utente, non nel progetto: niente finisce su Git, e vale per tutti i progetti.
// È l'unico file fuori dal progetto che il server tocca (percorso fisso, nessun input dall'esterno).

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanReader, type StoredPrefs } from "../shared/types.js";
import { log } from "./log.js";

/** Limite delle impostazioni del gioco salvate (JSON). */
const MAX_SETTINGS = 4096;

/** Cartella dati: CODE_DUNGEON_DATA, altrimenti quella del sistema operativo. */
export function dataDir(): string {
  if (process.env.CODE_DUNGEON_DATA) return path.resolve(process.env.CODE_DUNGEON_DATA);
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "code-dungeon");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "code-dungeon");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "code-dungeon");
}

export class Store {
  private db: DatabaseSync | undefined;
  /** Se il database non si apre, le preferenze valgono finché il server resta acceso. */
  private memory = new Map<string, string>();
  readonly file: string;

  constructor(dir = dataDir()) {
    this.file = path.join(dir, "code-dungeon.db");
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(this.file);
      // più sessioni dell'agente possono scrivere insieme
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
      db.exec("CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
      this.db = db;
    } catch (e) {
      log(`preferenze non salvabili in ${this.file}: ${String(e)}`);
    }
  }

  private get(key: string): unknown {
    try {
      const raw = this.db
        ? (this.db.prepare("SELECT value FROM prefs WHERE key = ?").get(key) as { value: string } | undefined)?.value
        : this.memory.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private set(key: string, value: unknown): void {
    const raw = JSON.stringify(value);
    if (!this.db) {
      this.memory.set(key, raw);
      return;
    }
    this.db
      .prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, raw, new Date().toISOString());
  }

  load(): StoredPrefs {
    const settings = this.get("settings");
    const reader = this.get("reader");
    const out: StoredPrefs = {};
    if (settings && typeof settings === "object" && !Array.isArray(settings)) out.settings = settings as Record<string, unknown>;
    if (reader !== undefined) out.reader = cleanReader(reader);
    return out;
  }

  /** Salva solo le parti presenti; le impostazioni troppo grandi o non oggetto vengono ignorate. */
  save(prefs: StoredPrefs): StoredPrefs {
    const s = prefs.settings;
    if (s && typeof s === "object" && !Array.isArray(s) && JSON.stringify(s).length <= MAX_SETTINGS) this.set("settings", s);
    if (prefs.reader !== undefined) this.set("reader", cleanReader(prefs.reader));
    return this.load();
  }
}
