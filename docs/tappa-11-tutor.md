# Tappa 11 · Modalità Tutor (piano di lavoro)

Documento di passaggio: contiene tutto quello che serve a un'altra sessione per implementare la tappa senza altro contesto. Prima di iniziare leggi `AGENTS.md` (regole del repo) e `docs/progetto.md` (specifica e roadmap).

## Perché

Oggi Code Dungeon è uno strumento per **capire il flusso** di codice scritto da altri: l'agente costruisce un tour, l'utente legge e fa domande. L'utente (studente, sta imparando CTF e reversing) vuole anche usarlo per **scrivere codice da solo**, con la guida che fa da insegnante: dà indicazioni e corregge **solo quando le viene chiesto**, senza scrivere la soluzione al suo posto.

Esempio concreto: l'utente apre `solve.py` per una challenge di reversing e traduce in Python un ciclo C `for (i = 5; i <= 29; ++i)`. Scrive `range(5, 29)`, chiede "è giusto?". La guida sottolinea la riga e chiede "fino a quale valore arriva `i` nel C? E `range` include l'estremo finale?", invece di correggere la riga da sola.

## Le due modalità

Scelta all'avvio o dal menu, salvata con le altre impostazioni (`settings.ts`, `StoredPrefs`).

| | **Flusso** (comportamento attuale, predefinito) | **Tutor** (nuovo) |
|---|---|---|
| Editor | sola lettura | modificabile, con salvataggio su file |
| Chi guida | l'agente, con il tour | l'utente; l'agente interviene solo su richiesta |
| Domande tipiche | "cosa fa questo codice?" | "perché non funziona?", "come continuo?", "è giusto?" |
| Risposta | spiegazione del flusso | aiuti graduali, correzioni puntate sulle righe, mai la soluzione completa se non chiesta esplicitamente |

Tour, lavagna, conversazioni salvate e domande dal vivo restano disponibili in entrambe le modalità.

## Piano a passi

Implementa un passo alla volta. Alla fine di ognuno: `npm run typecheck`, `npm run test:mcp`, `npm run build:game && npm run test:game`. Dopo i passi 1 e 2 fermati e fai provare all'utente prima di continuare.

### Passo 1 · Editor modificabile e selettore di modalità

- `src/shared/types.ts`:
  - `export type Mode = "flusso" | "tutor"`; campo `mode` in `StoredPrefs` (predefinito `"flusso"`) e `mode?: Mode` in `GameContext`.
  - nuova richiesta `{ type: "request"; reqId; op: "write_file"; path: string; content: string }` in `ClientMessage`.
- `src/server/project.ts`: metodo `writeFile(relPath, content)`.
  - Passa **sempre** da `resolveInside()` (regola di `AGENTS.md`); scrittura atomica come `saveTour` (file `.tmp` + rename).
  - Solo file di testo (rifiuta contenuto con byte nulli), dimensione massima ragionevole (es. 1 MB), niente scrittura dentro `.tour/`.
  - È la prima scrittura dal gioco ai file del progetto: documentalo nel commento in testa al file.
- `src/server/bridge.ts`: gestisci `op === "write_file"` accanto a `read_file` (riga ~361). Il ponte resta su 127.0.0.1 col controllo dell'origine.
- Gioco:
  - in modalità tutor l'editor diventa modificabile. Approccio consigliato senza framework: `<textarea>` trasparente sopra il `<pre>` evidenziato (stessa font, stesse misure, scroll sincronizzato), ri-evidenziazione con `highlight.ts` a ogni input (con debounce). Tab inserisce l'indentazione, Invio mantiene quella della riga sopra.
  - Ctrl+S / pulsante "Salva": `write_file`. Indicatore "modifiche non salvate". Se il file è cambiato su disco nel frattempo, chiedi prima di sovrascrivere.
  - possibilità di creare un nuovo file (nome nella radice del progetto).
  - le scorciatoie globali (es. tasto M dell'audio, riga ~1928 di `app.ts`) non devono scattare mentre si scrive: c'è già il controllo `closest("input, textarea")`, verifica che copra l'editor.
  - selettore Flusso/Tutor nel menu; testi in `i18n.ts` in inglese e italiano (stesse chiavi).
- `test:game`: controllo che in tutor si possa scrivere, salvare e che il layout regga a 390 px.

### Passo 2 · Domande con il codice allegato e prompt `tutor`

- In tutor, ogni domanda (`ClientMessage` `question`) porta nel `GameContext`:
  - `mode: "tutor"`;
  - `buffer?: { file: string; content: string; dirty: boolean }` con il contenuto **attuale** dell'editor (anche non salvato), troncato con un limite (`BUFFER_MAX`, es. 20 000 caratteri, come `SELECTION_MAX`);
  - `changed?: [number, number][]`: righe modificate dall'ultima domanda (diff semplice riga per riga).
- Pulsante "Chiedi alla guida" con tre scelte rapide che precompilano la domanda: *Dammi un indizio*, *Controlla il mio codice*, *Spiegami l'errore* (quest'ultima con un campo per incollare l'output del terminale).
- Nuovo prompt MCP `tutor` in `src/server/mcp.ts` (accanto a `crea_tour`, riga ~569), e una sezione in `docs/come-fare-un-tour.md` o un nuovo `docs/come-fare-il-tutor.md`. Regole per l'agente:
  1. Non scrivere la soluzione. Aiuti a livelli, uno per richiesta: **domanda guida** → **concetto** (cosa ripassare) → **frammento** minimo → soluzione completa **solo** se l'utente la chiede esplicitamente.
  2. Correggere indicando la riga (`highlight_lines` o `mark_lines`) e spiegando il *perché*, non solo il cosa.
  3. Se il codice è giusto, dirlo chiaramente e brevemente; suggerire al massimo un miglioramento.
  4. Rispettare `reader` e `lang` come nelle altre risposte; frasi brevi.
  5. Non modificare mai i file dell'utente (nessuno strumento lo permette, ma va detto).
- Anche le istruzioni del server MCP (testo che il client mostra all'agente) devono menzionare la modalità tutor: quando `context.mode === "tutor"` si applica il prompt `tutor`.
- `test:mcp`: verifica che il prompt esista in tutti e due gli standard MCP (stateless 2026 e 2025, vedi `AGENTS.md`).

### Passo 3 · Strumento `mark_lines`

- Nuovo strumento MCP `mark_lines({ path, marks: [{ line, endLine?, kind: "error" | "warning" | "hint", message }] , question_id? })`: sottolinea le righe nell'editor con un'ondina nei colori della palette (token CSS, niente colori letterali) e un commento a margine al passaggio del mouse/tocco. **Non** modifica il testo.
- Nuovo `ServerMessage` `{ type: "marks"; path; marks }`; i segni spariscono quando l'utente modifica quelle righe o con un pulsante "Pulisci".
- Salvali nella conversazione (`ConversationTurn`) così riaprendo una domanda si rivedono.
- Rispetta il movimento ridotto (`reducedMotion()`), nessuna animazione obbligatoria.

### Passo 4 · Registro delle lacune

- File `.tour/lacune.json` (via `Project`, come conversazioni e schemi): `{ version: 1, items: [{ id, concept, example, firstSeen, lastSeen, count, resolved }] }`.
- Strumenti MCP:
  - `record_gap({ concept, example })`: l'agente annota un concetto su cui l'utente è inciampato (es. "range esclude l'estremo finale", "maschera & 0xFF per l'overflow", "precedenza: - prima di ^"). Se esiste già, incrementa `count`.
  - `get_gaps()`: elenco, da leggere a inizio sessione per non rispiegare ciò che è già stato capito e per insistere su ciò che si ripete.
- Gioco: elenco "Da ripassare" (come l'elenco "Domande"), con la possibilità di segnare una lacuna come risolta o di chiedere alla guida un esercizio su quella.
- Il prompt `tutor` dice all'agente quando registrarle (errore concettuale, non refuso).

## Fuori da questa tappa

- **Eseguire il codice dal gioco**: richiederebbe una sandbox; per ora l'utente esegue nel terminale e incolla l'errore ("Spiegami l'errore").
- **Correzioni automatiche mentre si scrive**: la guida interviene solo su richiesta, per scelta di design.
- Completamento automatico del codice.

## Chiusura

- Aggiorna la roadmap in `docs/progetto.md` aggiungendo la tappa 11 con lo stato (✅ base / da fare).
- Aggiorna la sezione Struttura di `AGENTS.md` per i nuovi file/strumenti.
- Commit solo se l'utente lo chiede.
