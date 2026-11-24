# Architettura di Code Dungeon

Questo file spiega come sono fatti i pezzi di Code Dungeon e come si parlano. Per la specifica e la roadmap c'è `docs/progetto.md`; per le regole di sviluppo `AGENTS.md`.

## L'idea in una frase

Code Dungeon **non ha un'intelligenza sua**. È un server MCP: l'agente che usi già (Claude Code, Codex, Gemini CLI…) lo comanda con degli strumenti, e il gioco nel browser mostra quello che l'agente fa.

## I tre attori

```
┌──────────────┐  stdio (MCP)   ┌────────────────────────────┐  HTTP + WebSocket  ┌──────────────────┐
│   Agente     │ ─────────────▶ │  Server Code Dungeon       │ ◀────────────────▶ │  Gioco           │
│ (Claude Code)│ ◀───────────── │  (Node, un processo)       │   127.0.0.1:7337   │  (browser o app) │
└──────────────┘  strumenti,    │                            │                    └──────────────────┘
                  domande       │  mcp.ts   ← parla all'agente│
                                │  bridge.ts← parla al gioco │
                                │  project.ts→ file progetto │──▶ cartella del progetto
                                │  store.ts → impostazioni   │      └─ .tour/ (tour, schemi,
                                │  terminal.ts → shell       │         conversazioni, lacune)
                                └────────────────────────────┘
```

1. **L'agente** ragiona sul codice e chiama gli strumenti (`open_file`, `show_dialog`, `create_tour`…).
2. **Il server** (`src/server/`) è un solo processo Node. Da un lato parla MCP con l'agente su stdin/stdout, dall'altro fa da *ponte* verso il gioco con HTTP e WebSocket.
3. **Il gioco** (`src/game/`) è una pagina web senza framework. Riceve comandi dal ponte (apri questo file, evidenzia queste righe, mostra questo fumetto) e rimanda le domande dell'utente.

Ogni agente avvia **il proprio** server, quindi più chat aperte vogliono dire più server, uno per porta (7337, 7338, … fino a 7356). Il gioco li trova interrogando `GET /session` su quelle porte (`sessions.ts`).

## Il percorso di un comando: dall'agente allo schermo

Esempio: l'agente vuole mostrare la riga 42 di `server.py`.

1. L'agente chiama lo strumento MCP `highlight_lines` con `path` e righe.
2. `mcp.ts` legge il file con `Project` (`project.ts`), che controlla con `resolveInside()` che il percorso stia dentro la cartella del progetto.
3. `mcp.ts` passa il risultato a `bridge.ts`, che manda al gioco un messaggio WebSocket `{ type: "highlight", path, content, start, end }`.
4. Nel gioco, `source.ts` riceve il messaggio e `app.ts` apre la scheda, colora il codice con `highlight.ts` ed evidenzia le righe.

Tutti i messaggi possibili sono scritti in un solo posto: `src/shared/types.ts` (`ServerMessage` dal server al gioco, `ClientMessage` dal gioco al server). Server e gioco importano gli stessi tipi, quindi un formato cambia sempre prima lì.

## Il percorso inverso: una domanda dell'utente

1. L'utente scrive nel gioco. Il gioco manda `{ type: "question", text, context }`. `context` dice cosa sta guardando: file aperto, righe, modalità, e in tutor il codice non salvato (`buffer`) e le righe cambiate.
2. Il ponte salva la domanda in `.tour/conversazioni/` con i metadati del buffer. Nella coda per il tutor include l’ultimo scambio e fino a 1600 caratteri di codice. Per altre righe, `read_tutor_buffer` legge una delle ultime 16 copie dell’editor conservate in memoria. Il codice arriva all’agente con il numero davanti a ogni riga (`numberLines` in `types.ts`), anche nelle selezioni di più righe: l’agente non deve contarle partendo da `startLine`.
3. La domanda arriva all'agente in due modi:
   - **canale** (Claude Code): il server manda una notifica `notifications/claude/channel` e la domanda compare da sola nella chat dell'agente;
   - **attesa**: l'agente chiama `wait_for_question`, che restituisce subito le domande già in coda e altrimenti resta aperto. Una notifica senza risposta resta disponibile anche ai client che iniziano ad ascoltare dopo l’invio.
4. L'agente risponde con `show_dialog`, che può evidenziare le righe insieme al fumetto, e il percorso dell'esempio precedente riparte.

La scheda Terminali e il pannello sotto l’editor mostrano le stesse istanze xterm.js. L’utente può allegare alla domanda la selezione o la cronologia disponibile della shell attiva. Il gioco mantiene una lista ordinata di estratti di codice, testo e output, ciascuno rimovibile. Per più sezioni prepara un unico allegato numerato con il file e le righe del codice o il nome della shell. Con `ask_with_text` il ponte salva il testo UTF-8 in `.tour/conversazioni/testi/<id>.txt` prima di confermare l’invio. La coda e la cronologia riportano `textBytes`, il canale riporta `text_bytes`. Lo strumento `read_question_text` legge fino a 8192 byte per volta. Il campo `nextOffset` indica da dove proseguire e si può chiedere direttamente la parte finale.

Per incollare un'immagine, il gioco usa `ask_with_images` sul WebSocket. Il ponte valida e salva gli allegati in `.tour/conversazioni/immagini/` prima di confermare l'invio. La domanda conserva il conteggio `imageCount`. `wait_for_question` e `get_user_questions` includono blocchi immagine entro il limite di una domanda. Le notifiche del canale Claude Code usano `image_count` e indicano `read_question_image`, che serve anche per recuperare un allegato dalla cronologia. [Formato delle notifiche del canale Claude Code](https://code.claude.com/docs/en/channels-reference#notification-format)

Per questo le istruzioni del server dicono all'agente di restare in ascolto: l'utente non deve mai tornare al terminale.

## Il server, file per file (`src/server/`)

| File | Cosa fa |
|---|---|
| `cli.ts` | Punto d'ingresso. Legge `--project` e `--port`, crea `Project`, `Store` e `Bridge`, poi avvia MCP su stdio. Due modi: `mcp` (con agente) e `play` (solo il gioco, per riprodurre tour salvati). |
| `mcp.ts` | Strumenti e prompt MCP, e le **istruzioni** che l'agente legge quando si collega. Qui si decide cosa l'agente può fare. |
| `bridge.ts` | Server HTTP (serve i file del gioco da `dist/game` e `GET /session`) e WebSocket verso il gioco. Tiene lo stato della sessione: domande in coda, titolo, ultima attività. Mentre il gioco è aperto ricontrolla i file ogni 1,5 s. |
| `project.ts` | Accesso ai file confinato nel progetto. In tutor il gioco può salvare e rinominare file, creare e spostare file e cartelle e usare il Cestino. L'albero include anche le cartelle vuote. Il progetto gestisce inoltre tour, schemi, conversazioni e lacune in `.tour/`. |
| `store.ts` | Impostazioni dell'utente (livello, lingua, guida…) in un database SQLite in `~/.local/share/code-dungeon/`. Valgono per tutti i progetti. |
| `chat-title.ts` | Titolo della chat dell'agente ("Cartelle e terminale nel TODO") per l'elenco delle sessioni. Claude Code non lo passa via MCP: il server lo legge da `~/.claude`, partendo dal processo che l'ha avviato. Solo lettura; con altri agenti non c'è. |
| `terminal.ts` | Terminali del gioco su `/term`: una shell vera nella cartella del progetto. È l'unico punto che avvia processi; l'agente non può usarli. |

**Strumenti MCP**, divisi per scopo:

- *mostrare codice*: `list_project_files`, `open_file`, `highlight_lines`, `mark_lines`;
- *parlare*: `show_dialog`, `name_session`;
- *ascoltare*: `wait_for_question`, `get_user_questions`, `read_question_image`, `read_question_text`, `get_conversation`, `get_game_state`;
- *tour*: `list_tours`, `get_tour`, `create_tour`, `add_step`, `set_step_text`, `set_step_diagram`, `play_tour`;
- *schemi*: `draw_diagram`, `reveal_diagram`;
- *tutor*: `record_gap`, `get_gaps`.

I due **prompt** MCP, `crea_tour` e `tutor`, sono le guide lunghe per l'agente (testo in `docs/come-fare-un-tour.md` e `docs/come-fare-il-tutor.md`).

## Il gioco, per aree (`src/game/`)

Non c'è un framework: `app.ts` costruisce e aggiorna il DOM direttamente; gli altri moduli sono pezzi che usa.

- **Cuore**: `app.ts` (interfaccia, schede, riproduzione dei tour, menu), `source.ts` (connessione WebSocket al ponte), `demo-source.ts` (finto ponte per la demo senza server), `sessions.ts` (scelta della sessione).
- **Editor e codice**: `highlight.ts` (colori della sintassi, senza librerie), `filetree.ts` (albero dei file), `follow.ts` (Ctrl+clic sugli import), `editing.ts` (editor scrivibile del tutor), `terminals.ts` (pannello dei terminali con xterm.js).
- **Guida e testi**: `richtext.ts` (fumetti con elenchi, codice, blocchi colorati), `reader.ts` (aiuti alla lettura, fumetto a pagine), `chat.ts` (modalità chat), `tutor.ts` (righe cambiate, segni di `mark_lines`), `diagram.ts` (lavagna degli schemi).
- **Aspetto**: `portrait.ts` e `guide.ts` (ritratti e scelta della guida), `pixelate.ts` (immagine → pixel art), `layout.ts` (divisori e pannelli), `fullscreen.ts`, `styles.css` (palette nei token CSS).
- **Contorno**: `settings.ts` (impostazioni, sincronizzate col server), `i18n.ts` (testi in inglese e italiano), `audio.ts` (musica ed effetti sintetizzati).

## Le due modalità

- **Flusso**: guida l'agente. Costruisce un tour (una lista di passi, ognuno con file, righe e testo) e lo avvia con `play_tour`; il gioco lo riproduce passo per passo. Il codice è in sola lettura.
- **Tutor**: guida l'utente. L'editor diventa scrivibile, l'agente aspetta le domande e aiuta senza scrivere la soluzione.

La modalità la sceglie l'utente nel menu del gioco, non l'agente. Se l'utente chiede solo di aprire Code Dungeon, l'agente non fa un tour: dà l'indirizzo e aspetta le domande.

## Dove stanno i dati

| Dove | Cosa | Chi lo scrive |
|---|---|---|
| `<progetto>/.tour/*.json` | tour | l'agente (`create_tour`, `add_step`) |
| `<progetto>/.tour/schemi/` | schemi della lavagna | l'agente (`draw_diagram`) |
| `<progetto>/.tour/conversazioni/` | domande e risposte | il ponte |
| `<progetto>/.tour/conversazioni/immagini/` | immagini incollate nelle domande | il ponte |
| `<progetto>/.tour/lacune.json` | concetti da ripassare | l'agente (`record_gap`), il gioco ("Capito") |
| `<progetto>/.tour/cestino/` | file cestinati e percorsi originali | il gioco in tutor |
| `~/.local/share/code-dungeon/` | impostazioni e questionario (SQLite) | `store.ts` |
| `localStorage` del browser | layout, schede, cartelle aperte, chat | il gioco |

## L'app desktop (`src-tauri/`)

È solo una finestra Tauri che mostra lo stesso gioco (`dist/game`). Non contiene un server: cerca le sessioni aperte dagli agenti sulle porte 7337-7356, come il browser. Su Linux i suoni passano da elementi `<audio>` perché Web Audio in WebKitGTK si guasta.

## Sorgenti e versioni compilate

Il codice è TypeScript, ma quello che gira è compilato in `dist/`:

- `npm run build:server` → `dist/server/` (è quello che lancia l'agente: `node dist/server/cli.js mcp`);
- `npm run build:game` → `dist/game/` (è quello che il ponte serve al browser).

Se cambi il server e non ricompili, gli agenti continuano a usare la versione vecchia anche dopo `/mcp`. Durante lo sviluppo si può invece usare `npm run dev` (gioco con ricarica) e `npm run mcp` / `npm run play` (server da sorgente con `tsx`).

## Sicurezza, in breve

- Il ponte ascolta solo su `127.0.0.1` e accetta WebSocket solo dalle pagine del gioco.
- Ogni file del progetto passa da `Project.resolveInside()`: l'agente non può leggere o scrivere fuori dalla cartella del progetto. Fuori ci sono solo il database delle impostazioni e la lettura del titolo della chat in `~/.claude`.
- I terminali sono dell'utente: nessuno strumento MCP li legge o ci scrive.

## Test

- `npm run test:mcp` avvia il server, si collega come un agente (con il protocollo 2025 e con il 2026) e prova gli strumenti.
- `npm run test:game` apre il gioco in Chromium headless e lo pilota come un utente, anche a 390 px di larghezza.
