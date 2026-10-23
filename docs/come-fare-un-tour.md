# Come costruire un tour di Code Dungeon

Istruzioni per l'agente (Claude Code, Codex, Gemini CLI o altro) che usa gli strumenti MCP di Code Dungeon.

## Obiettivo

Un tour spiega il codice seguendo il **flusso reale di esecuzione**, non l'ordine dei file. Si parte dal punto d'ingresso (main, route, handler di eventi) e si segue il dato o la richiesta attraverso le funzioni che lo toccano, fino alla risposta.

## Procedura

1. Leggi il progetto con i tuoi strumenti (o `list_project_files`) e individua i punti d'ingresso.
2. Scegli **un** flusso da raccontare (es. "il viaggio di un pacchetto", "cosa succede al login"). Più flussi = più tour.
3. `create_tour` con un id breve in minuscolo con trattini e un titolo che descriva il flusso.
4. Per ogni punto del flusso chiama `add_step`, **nell'ordine in cui il programma lo esegue**:
   - `file` e righe: il blocco minimo che serve a capire il passo (di solito 3-15 righe).
   - `title`: 2-5 parole, come il nome di una stanza del dungeon.
   - `expression`: `felice` per l'inizio e le scelte ben fatte, `pensieroso` per i concetti da ragionare, `preoccupato` per bug e falle di sicurezza, `sorpreso` per comportamenti inattesi, `neutro` altrimenti.
   - `text`: una versione per livello (vedi sotto). In modalità **istantanea** scrivi tutti e quattro i livelli; in modalità **su richiesta** scrivi solo il livello richiesto.
   - `next`: dove il flusso si dirama (es. un handler per ogni tipo di messaggio) metti un collegamento per ramo con `when` leggibile, es. `type == LOGIN (0x02)`. Alla fine di ogni ramo collega il passo di chiusura comune. Sull'ultimo passo usa `next: []`.
5. Se trovi un problema (bug, falla, gestione errori mancante) dedicagli un passo a sé con espressione `preoccupato`.
6. `play_tour` per avviarlo. Se segnala collegamenti rotti, correggili.

## I quattro livelli

| Livello | Per chi | Come scrivere |
| --- | --- | --- |
| facile | chi non programma | metafore del dungeon, niente gergo, cosa fa e perché |
| medio | studente, junior | nomi di funzioni e concetti base, struttura e flusso |
| difficile | sviluppatore esperto | dettagli implementativi, complessità, scelte di design e alternative |
| arduo | esperto di sicurezza o basso livello | protocolli, flag, byte order, memoria, superfici d'attacco, fix concreti |

Ogni testo: 2-4 frasi, massimo ~70 parole, nella lingua dell'utente. Non ripetere il codice riga per riga: spiega cosa significa e perché conta.

## Durante la spiegazione dal vivo

- Controlla `get_user_questions` periodicamente, e sempre quando l'utente dice di aver fatto una domanda nel gioco.
- Ogni domanda arriva con il contesto (livello, file, righe, passo). Rispondi con `show_dialog` al livello dell'utente; se ti riferisci ad altro codice, prima `highlight_lines`.
- Per domande che richiedono fonti esterne (documentazione, RFC, CVE) usa i tuoi strumenti di ricerca e cita la fonte nel fumetto.
- Le richieste automatiche che iniziano con `[richiesta automatica]` chiedono di scrivere il testo di un livello mancante: usa `set_step_text`, poi `play_tour` con `from_step` sullo stesso passo.
