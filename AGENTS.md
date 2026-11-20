# Istruzioni per gli agenti che sviluppano Code Dungeon

Questo file è per chi lavora **sul codice di Code Dungeon**. Le istruzioni per costruire un tour in un altro progetto sono in `docs/come-fare-un-tour.md` (esposte anche come prompt MCP `crea_tour`); le regole della modalità tutor sono in `docs/come-fare-il-tutor.md` (prompt MCP `tutor`).

## Contesto

Leggi `docs/architettura.md` (come sono fatti i pezzi e come si parlano) e `docs/progetto.md`: specifica completa e roadmap a tappe. Lavora una tappa alla volta e aggiorna la roadmap quando ne chiudi una.

## Struttura

- `src/shared/types.ts`: tipi del tour e protocollo WebSocket, condivisi da server e gioco. Si parte sempre da qui quando cambia un formato.
- `src/server/`: `cli.ts` (modi `mcp` e `play`), `mcp.ts` (strumenti e prompt), `bridge.ts` (HTTP + WebSocket su 127.0.0.1; mentre il gioco è aperto ricontrolla i file del progetto ogni 1,5 s e manda `files` se cambiano), `terminal.ts` (terminali del gioco su `/term`: shell nella cartella del progetto, node-pty facoltativo), `project.ts` (accesso ai file confinato nella radice; tour, schemi, conversazioni e registro delle lacune `lacune.json` in `.tour/`), `store.ts` (impostazioni e questionario in SQLite nella cartella dati dell'utente), `chat-title.ts` (titolo della chat di Claude Code per l'elenco delle sessioni).
- `src/game/`: gioco nel browser senza framework. `app.ts` (UI, riproduzione dei tour, schede dei file con stato per scheda), `i18n.ts` (testi dell'interfaccia in inglese e italiano), `portrait.ts` (ritratti 32×32 delle guide e immagine dell'utente), `guide.ts` (scelta della guida nel menu), `filetree.ts` (albero dei file della barra laterale: cartelle chiuse di partenza, aperte salvate per progetto in localStorage, aperte da sole per il file mostrato), `terminals.ts` (pannello dei terminali sotto l'editor con xterm.js caricato al bisogno, Ctrl+`), `follow.ts` (Ctrl+clic su `#include`, `import` e `require`: dalla riga al file del progetto, solo tra i file elencati dal ponte), `chat.ts` (modalità chat: storico dei fumetti con schede di codice, salvato in localStorage per progetto), `editing.ts` (editor modificabile della modalità tutor: textarea trasparente sopra le righe evidenziate, Tab e Invio con indentazione), `tutor.ts` (tutor: righe cambiate dall'ultima domanda, buffer allegato, scelte rapide, segni di `mark_lines` che seguono le righe; il pannello "Da ripassare" delle lacune di `record_gap` è in `app.ts`), `reader.ts` (aiuti alla lettura: classi CSS, movimento ridotto, fumetto a pagine), `richtext.ts` (formattazione minima dei testi della guida con nodi DOM: paragrafi, elenchi, codice, blocchi ```linguaggio colorati da `highlight.ts` con pulsante Copia, grassetto, link), `settings.ts` (impostazioni e sincronizzazione col ponte), `pixelate.ts` (immagine → pixel art), `diagram.ts` (lavagna degli schemi), `audio.ts` (musiche, effetti e voce della guida; nell'app su Linux i suoni si calcolano in WAV e suonano da elementi `<audio>`, perché l'uscita di Web Audio di WebKitGTK si guasta; `?audio=clips` la prova nel browser), `highlight.ts` (sintassi senza librerie: tokenizzatore generico configurato per linguaggio, lexer propri per assembly, HTML/XML con `<script>` e `<style>`, CSS, Markdown; colori nei token `--tk-*`), `source.ts` e `demo-source.ts` (ponte o demo incorporata), `sessions.ts` (sessioni aperte su 7337-7356 via `GET /session`, scelta e cambio), `layout.ts` (divisori, anche quello dei terminali, guida sotto o a destra dell'editor con la sua larghezza, anche quelli della modalità chat con misure proprie, finestra della lavagna e finestra classica ridimensionabili, pannello laterale scelto, tutto in localStorage), `fullscreen.ts` (schermo intero: Fullscreen API nel browser, finestra Tauri nell'app).
- `src-tauri/`: app desktop Tauri 2. Solo una finestra su `dist/game`, senza comandi nativi (unici permessi: schermo intero della finestra); il gioco cerca le sessioni aperte con `resolveBridge()` di `sessions.ts`. Il server resta in Node.
- `examples/packet-server/`: progetto d'esempio con tour in `.tour/` e schemi in `.tour/schemi/`. Tieni allineati i numeri di riga del tour se modifichi i file Python.

## Comandi

- `npm run typecheck`, `npm run test:mcp` e, se tocchi il gioco, `npm run build:game && npm run test:game` prima di considerare finito un cambiamento. La CI (`.github/workflows/ci.yml`) li esegue a ogni push.
- `test:game` pilota Chromium headless via DevTools Protocol (senza dipendenze): quando aggiungi una funzione del gioco, aggiungi lì un controllo, anche a 390 px.
- `npm run dev` + `npm run play -- --project examples/packet-server` per lavorare sul gioco.
- `npm run app:build` compila l'app desktop (serve Rust); `npm run app:dev` la apre su `npm run dev`.
- `npm run build:demo` produce `dist/demo/index.html`, un file unico senza ponte.

## Regole

- In modalità MCP lo stdout è del protocollo: log solo con `log()` (stderr).
- MCP a doppio standard: `serveStdio` serve il protocollo 2026-07-28 (stateless) e ricade sul 2025 per i client che aprono con `initialize`. Ogni strumento deve funzionare in tutte e due: niente stato legato alla connessione, niente richieste dal server al client (sampling, elicitation, roots). `npm run test:mcp` li prova entrambi.
- Ogni accesso a file del progetto passa da `Project.resolveInside()`. Non aggiungere letture o scritture fuori da lì. Le uniche eccezioni sono il database di `store.ts`, a percorso fisso, e `chat-title.ts`, che legge in sola lettura il titolo della chat da `~/.claude` (sessione del processo padre).
- Il ponte resta su 127.0.0.1 con controllo dell'origine dei WebSocket.
- `terminal.ts` è l'unico posto che avvia processi: la shell è dell'utente e non passa da `resolveInside()`. Nessuno strumento MCP legge o scrive nei terminali; `/term` accetta solo il gioco del ponte (`isTerminalOrigin`).
- Testi dell'interfaccia in `src/game/i18n.ts`, in inglese e in italiano (stesse chiavi, niente testo letterale nei componenti: `t()` in TS, `data-i18n` in HTML). Messaggi degli strumenti MCP in italiano. Sempre frasi brevi e concrete.
- Rispetta il movimento ridotto per ogni nuova animazione (`reducedMotion()` di `reader.ts` in TS, regole `prefers-reduced-motion` e `.meno-movimento` in CSS) e verifica il layout a 390 px di larghezza.
- Audio: tutto sintetizzato con Web Audio in `audio.ts`, niente file audio né musiche altrui. Ogni nuovo suono passa dai bus musica/effetti, così volumi e tasto M valgono anche per lui.
- Grafica: pixel nitidi (`image-rendering: pixelated`), palette nei token CSS di `styles.css`, niente colori letterali nei componenti.
