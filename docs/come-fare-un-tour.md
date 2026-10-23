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

- Le domande possono arrivare da sole come evento `<channel source="code-dungeon" question_id="..." level="..." file="..." lines="..." step="...">` (Claude Code con il canale attivo). Rispondi subito con `show_dialog` passando `question_id`: l'utente legge nel gioco, non nel terminale.
- Altrimenti, dopo `play_tour` e dopo ogni risposta, chiama `wait_for_question` e resta in ascolto: rispondi a ogni domanda e richiamalo. L'utente non deve tornare al terminale per chiedertelo. Smetti solo se ti scrive nel terminale.
- Ogni domanda arriva con il contesto (livello, file, righe, passo). Rispondi con `show_dialog` al livello dell'utente; se ti riferisci ad altro codice, prima `highlight_lines`.
- Una risposta lunga può stare in più `show_dialog` di fila: il gioco li mette in coda e l'utente li legge con "Avanti".
- Per domande che richiedono fonti esterne (documentazione, RFC, CVE) usa i tuoi strumenti di ricerca e cita la fonte nel fumetto.
- Le richieste automatiche che iniziano con `[richiesta automatica]` chiedono di scrivere il testo di un livello mancante: usa `set_step_text`, poi `play_tour` con `from_step` sullo stesso passo.

## Schemi sulla lavagna

Uno schema aiuta a vedere il flusso intero mentre si legge un pezzo alla volta. Disegnane uno per tour, prima dei passi.

1. `draw_diagram` con un id, un titolo e un tipo:
   - `flusso`: nodi e archi, per il percorso del dato o della richiesta. I pezzi sono i nodi, nell'ordine dell'elenco.
   - `sequenza`: i nodi sono i partecipanti (client, server, database), gli archi i messaggi in ordine. I pezzi sono i messaggi.
2. Forme dei nodi: `stanza` (funzione o blocco, predefinita), `bivio` (scelta), `archivio` (dati, file, formato), `attore` (persona o programma esterno).
3. Metti `code` (file e righe) nei nodi che corrispondono a codice: nel gioco hanno una gemma e un clic apre quelle righe.
4. Archi: `label` breve, `style: "tratteggiato"` per legami non di esecuzione (formato, ritorno al ciclo).
5. Collega lo schema ai passi con `diagram: { id, upto }` in `add_step`, o con `set_step_diagram`. `upto` = quanti pezzi mostrare: cresce passo dopo passo, così lo schema si disegna mentre spieghi. Senza `upto` si vede tutto.
6. Durante una risposta dal vivo usa `reveal_diagram` per mostrare uno schema salvato.

Lo schema compare in una finestra a comparsa e resta disponibile come scheda dell'editor e nell'elenco "Schemi". Massimo 30 nodi e 60 archi: se serve di più, fai due schemi.
