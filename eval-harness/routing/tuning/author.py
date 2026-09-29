"""Author a fresh paired routing test before any candidate inference.
These are synthetic rubric labels, not claims about downstream model quality.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAIRS = {
    'basic': '''Compute 11 plus 8.|Berechne 11 plus 8.
What is 72 minus 19?|Was ergibt 72 minus 19?
9 times 8, please.|9 mal 8, bitte.
Divide 156 by 12.|Teile 156 durch 12.
How much is one quarter of 60?|Wie viel ist ein Viertel von 60?
Round 6.782 to two decimal places.|Runde 6,782 auf zwei Nachkommastellen.
Write 0.125 as a fraction.|Schreibe 0,125 als Bruch.
Is 101 an odd or an even number?|Ist 101 eine gerade oder eine ungerade Zahl?
How many centimeters are in 4 meters?|Wie viele Zentimeter sind 4 Meter?
Convert 240 seconds to minutes.|Rechne 240 Sekunden in Minuten um.
Which month comes immediately after April?|Welcher Monat kommt direkt nach April?
How many sides does a nonagon have?|Wie viele Seiten hat ein Neuneck?
What is the chemical symbol for gold?|Was ist das chemische Symbol für Gold?
Name the largest planet in our solar system.|Nenne den größten Planeten unseres Sonnensystems.
What is the capital city of Portugal?|Wie heißt die Hauptstadt Portugals?
In which continent is Kenya?|Auf welchem Kontinent liegt Kenia?
Expand the abbreviation CPU in one phrase.|Schreibe die Abkürzung CPU in einer Wortgruppe aus.
What HTTP status code means Not Found?|Welcher HTTP-Statuscode bedeutet Not Found?
Does the word apple start with a vowel?|Beginnt das Wort Apfel mit einem Vokal?
Give the plural of child.|Nenne die Mehrzahl des englischen Wortes child.
Spell the number 42 in English.|Schreibe die Zahl 42 auf Englisch aus.
What's the opposite of north?|Was ist das Gegenteil von Norden?
What color do you get by mixing blue and yellow paint?|Welche Farbe entsteht beim Mischen von blauer und gelber Farbe?
Compute 2 to the power of 6.|Berechne 2 hoch 6.
Name the author of Pride and Prejudice.|Nenne die Autorin von Pride and Prejudice.''',
    'economy': '''Make this friendlier: Send the invoice today.|Formuliere freundlicher: Schick die Rechnung heute.
Write a short thank-you text for someone who watered my plants.|Schreibe eine kurze Dankesnachricht an jemanden, der meine Pflanzen gegossen hat.
Translate into Spanish: The museum closes at six.|Übersetze ins Spanische: Das Museum schließt um sechs.
Give me three subject lines for a team lunch invitation.|Gib mir drei Betreffzeilen für eine Einladung zum Team-Mittagessen.
Summarize this in one sentence: The bus was late. I walked instead. I arrived on time.|Fasse in einem Satz zusammen: Der Bus hatte Verspätung. Ich bin stattdessen gelaufen. Ich kam pünktlich an.
Draft a polite request to reschedule my haircut.|Entwirf eine höfliche Bitte, meinen Friseurtermin zu verschieben.
Suggest five names for a neighborhood gardening club.|Schlage fünf Namen für einen Gartenverein im Viertel vor.
Make a simple packing checklist for one night at a friend's house.|Erstelle eine einfache Packliste für eine Übernachtung bei einem Freund.
Rewrite this without jargon: Our distributed consensus subsystem achieved quorum.|Formuliere ohne Fachsprache: Unser verteiltes Konsenssystem hat das Quorum erreicht.
Write a two-sentence announcement that our database maintenance is finished.|Schreibe eine Mitteilung in zwei Sätzen, dass unsere Datenbankwartung abgeschlossen ist.
Turn this into a bullet list: Buy bread, wash towels, call the dentist.|Mache daraus eine Aufzählung: Brot kaufen, Handtücher waschen, Zahnarzt anrufen.
Suggest a vegetarian lunch using chickpeas and spinach.|Schlage ein vegetarisches Mittagessen mit Kichererbsen und Spinat vor.
Write a cheerful caption for a photo of a muddy dog.|Schreibe eine fröhliche Bildunterschrift für ein Foto eines schlammigen Hundes.
Shorten this: Due to the fact that it is raining, we will postpone the picnic.|Kürze: Aufgrund der Tatsache, dass es regnet, werden wir das Picknick verschieben.
Draft a birthday message for a colleague I don't know well.|Entwirf eine Geburtstagsnachricht für einen Kollegen, den ich kaum kenne.
Translate into German: Please leave the package at reception.|Übersetze ins Englische: Bitte lassen Sie das Paket am Empfang.
Give me a simple agenda for a twenty-minute weekly team check-in.|Gib mir eine einfache Agenda für eine zwanzigminütige wöchentliche Teambesprechung.
Write a friendly reminder to return a borrowed book.|Schreibe eine freundliche Erinnerung, ein ausgeliehenes Buch zurückzugeben.
Suggest four rainy-day activities for two adults at home.|Schlage vier Aktivitäten für zwei Erwachsene zu Hause an einem Regentag vor.
Fix the grammar: She don't like waiting in lines.|Korrigiere die Grammatik: Er haben keine Zeit.
Write a short apology for missing a friend's call.|Schreibe eine kurze Entschuldigung für einen verpassten Anruf eines Freundes.
Make a grocery list for a basic pasta dinner for four.|Erstelle eine Einkaufsliste für ein einfaches Nudelgericht für vier Personen.
Rephrase this announcement in plain language: TLS certificate rotation completed successfully.|Formuliere diese Mitteilung allgemeinverständlich: Die Rotation des TLS-Zertifikats wurde erfolgreich abgeschlossen.
Brainstorm three icebreaker questions for a book club.|Sammle drei Einstiegsfragen für einen Buchclub.
Write a one-paragraph description of a cozy lakeside cabin for a rental listing.|Schreibe eine Beschreibung in einem Absatz für eine gemütliche Hütte am See in einer Ferienanzeige.''',
    'general': '''Write a Python function that finds the longest word in a list.|Schreibe eine Python-Funktion, die das längste Wort in einer Liste findet.
In SQL, select customers who placed at least three orders this month.|Wähle in SQL Kunden aus, die diesen Monat mindestens drei Bestellungen aufgegeben haben.
Why does my React component rerender when its parent state changes? Show a minimal fix.|Warum wird meine React-Komponente bei einer Zustandsänderung des Elternteils neu gerendert? Zeige eine minimale Lösung.
Debug this JavaScript: const result = [1,2,3].map(async x => x*2); I expected numbers.|Debugge diesen JavaScript-Code: const result = [1,2,3].map(async x => x*2); Ich habe Zahlen erwartet.
Explain how a binary search differs from a linear search, including their time complexity.|Erkläre den Unterschied zwischen binärer und linearer Suche einschließlich der Laufzeitkomplexität.
Write a shell command to find files larger than 50 MB in the current directory tree.|Schreibe einen Shell-Befehl, der Dateien über 50 MB im aktuellen Verzeichnisbaum findet.
My Docker container cannot resolve a service name on another network. Explain how to diagnose it.|Mein Docker-Container kann einen Dienstnamen in einem anderen Netzwerk nicht auflösen. Erkläre die Diagnose.
Implement a debounced search input in TypeScript.|Implementiere ein Sucheingabefeld mit Debouncing in TypeScript.
Explain why a SQL LEFT JOIN can become an inner join when filtering in WHERE.|Erkläre, warum ein SQL-LEFT-JOIN beim Filtern in WHERE zu einem Inner Join werden kann.
Write a unit test for a function that rejects malformed date strings.|Schreibe einen Unit-Test für eine Funktion, die ungültige Datumszeichenfolgen ablehnt.
My Python loop skips items when I remove elements from the list. Fix the pattern.|Meine Python-Schleife überspringt Einträge, wenn ich Elemente aus der Liste entferne. Korrigiere das Muster.
Compare mutexes and semaphores with a practical example.|Vergleiche Mutexe und Semaphore anhand eines praktischen Beispiels.
Write a PostgreSQL query for the running total of sales ordered by date.|Schreibe eine PostgreSQL-Abfrage für die kumulierte Verkaufssumme nach Datum.
Show how to parse a CSV file and group rows by category in Python.|Zeige, wie man in Python eine CSV-Datei liest und Zeilen nach Kategorie gruppiert.
Explain why using an array index as a React key breaks reordered lists.|Erkläre, warum ein Array-Index als React-Key bei umgeordneten Listen Probleme macht.
Fix a Git merge conflict between two edits to the same configuration setting.|Löse einen Git-Merge-Konflikt zwischen zwei Änderungen an derselben Konfigurationseinstellung.
Write a Rust function returning the first duplicate integer in a slice.|Schreibe eine Rust-Funktion, die die erste doppelte Ganzzahl in einem Slice zurückgibt.
How do I diagnose a memory leak in a small Node.js service?|Wie diagnostiziere ich ein Speicherleck in einem kleinen Node.js-Dienst?
Explain transaction isolation levels and show a phantom read example.|Erkläre Transaktionsisolationsstufen und zeige ein Beispiel für einen Phantom Read.
Implement pagination for a REST endpoint using a cursor rather than an offset.|Implementiere die Paginierung eines REST-Endpunkts mit einem Cursor statt eines Offsets.
Write a regex and tests for matching a simple version string like 1.2.3.|Schreibe einen regulären Ausdruck und Tests für einfache Versionszeichenfolgen wie 1.2.3.
My CSS grid overflows because one child contains a long URL. Find a fix.|Mein CSS-Grid läuft über, weil ein Kindelement eine lange URL enthält. Finde eine Lösung.
Show how to cancel a fetch request when a component unmounts.|Zeige, wie man eine Fetch-Anfrage beim Entfernen einer Komponente abbricht.
Explain when a composite database index can serve a query on only its second column.|Erkläre, wann ein zusammengesetzter Datenbankindex eine Abfrage nur auf seiner zweiten Spalte bedienen kann.
Write a migration that adds a nullable column and backfills it in small batches.|Schreibe eine Migration, die eine nullable Spalte hinzufügt und sie in kleinen Batches befüllt.''',
    'advanced': '''Derive the impossibility boundary for Byzantine consensus with partial synchrony and justify each assumption.|Leite die Unmöglichkeitsgrenze für byzantinischen Konsens bei partieller Synchronität her und begründe jede Annahme.
Prove the spectral theorem for compact self-adjoint operators on a Hilbert space.|Beweise den Spektralsatz für kompakte selbstadjungierte Operatoren auf einem Hilbertraum.
Design a globally replicated ledger with strict serializability, regional outages, and a quantified latency budget.|Entwirf ein global repliziertes Ledger mit strikter Serialisierbarkeit, regionalen Ausfällen und einem quantifizierten Latenzbudget.
Establish a regret bound for a contextual bandit with delayed feedback and state the necessary concentration inequalities.|Leite eine Regret-Schranke für einen kontextuellen Banditen mit verzögertem Feedback her und nenne die nötigen Konzentrationsungleichungen.
Prove the max-flow min-cut theorem using residual networks and justify termination for rational capacities.|Beweise den Max-Flow-Min-Cut-Satz mit Residualnetzwerken und begründe die Terminierung bei rationalen Kapazitäten.
Analyze a distributed garbage collector under partitions, crash recovery, and concurrent reference creation, with a safety proof.|Analysiere einen verteilten Garbage Collector bei Partitionen, Wiederanlauf und nebenläufiger Referenzerzeugung mit einem Sicherheitsbeweis.
Derive the Euler-Lagrange equations for a constrained variational problem and examine second-order sufficiency.|Leite die Euler-Lagrange-Gleichungen für ein Variationsproblem mit Nebenbedingungen her und untersuche hinreichende Bedingungen zweiter Ordnung.
Design an experiment that separates causal mediation from confounding when the mediator is measured with error.|Entwirf ein Experiment, das kausale Mediation von Confounding trennt, wenn der Mediator fehlerhaft gemessen wird.
Prove a convergence theorem for stochastic gradient descent with nonconvex smooth objectives and noisy gradients.|Beweise einen Konvergenzsatz für stochastischen Gradientenabstieg bei glatten nichtkonvexen Zielfunktionen und verrauschten Gradienten.
Develop a model checking strategy for a lock-free reclamation scheme and explain the ABA counterexample space.|Entwickle eine Model-Checking-Strategie für ein lockfreies Speicherfreigabeverfahren und erläutere den Raum möglicher ABA-Gegenbeispiele.
Derive the asymptotic distribution of a maximum likelihood estimator under model misspecification.|Leite die asymptotische Verteilung eines Maximum-Likelihood-Schätzers bei Modellfehlspezifikation her.
Prove the Hahn-Banach extension theorem in the real normed-space case.|Beweise den Hahn-Banach-Fortsetzungssatz für reelle normierte Räume.
Design a multi-region key rotation protocol with offline clients, forward secrecy, rollback protection, and formal invariants.|Entwirf ein regionsübergreifendes Schlüsselrotationsprotokoll mit Offline-Clients, Forward Secrecy, Rollback-Schutz und formalen Invarianten.
Analyze whether a proposed asynchronous consensus protocol contradicts FLP; construct the admissible failure schedule.|Untersuche, ob ein vorgeschlagenes asynchrones Konsensprotokoll FLP widerspricht; konstruiere den zulässigen Ausfallablauf.
Derive a lower bound on communication for distributed exact distinct counting and justify the reduction.|Leite eine Kommunikationsuntergrenze für verteilte exakte Zählung unterschiedlicher Elemente her und begründe die Reduktion.
Prove strong duality for convex optimization under Slater's condition, including the role of separating hyperplanes.|Beweise starke Dualität bei konvexer Optimierung unter der Slater-Bedingung einschließlich der Rolle trennender Hyperebenen.
Develop a rigorous threat model and architecture for confidential multi-party analytics with malicious participants.|Entwickle ein rigoroses Bedrohungsmodell und eine Architektur für vertrauliche Mehrparteienanalysen mit bösartigen Teilnehmern.
Prove tight amortized bounds for union-find with path compression and union by rank.|Beweise scharfe amortisierte Schranken für Union-Find mit Pfadkompression und Vereinigung nach Rang.
Design a distributed scheduler with fairness, heterogeneous accelerators, preemption, and a proof of starvation freedom.|Entwirf einen verteilten Scheduler mit Fairness, heterogenen Beschleunigern, Präemption und einem Beweis für Verhungerungsfreiheit.
Derive a statistically valid sequential test for an adaptive online experiment without inflating type-I error.|Leite einen statistisch gültigen sequenziellen Test für ein adaptives Online-Experiment ohne erhöhte Fehlerwahrscheinlichkeit erster Art her.
Analyze identifiability in a latent-variable causal model with selection bias and give an explicit non-identifiable pair.|Analysiere Identifizierbarkeit in einem kausalen Modell mit latenten Variablen und Selektionsbias und gib ein explizites nichtidentifizierbares Paar an.
Prove the completeness of resolution for first-order logic using Herbrand's theorem.|Beweise die Vollständigkeit der Resolution für Prädikatenlogik erster Stufe mithilfe des Satzes von Herbrand.
Design a storage architecture supporting atomic snapshots across shards under correlated regional failures.|Entwirf eine Speicherarchitektur für atomare Snapshots über mehrere Shards bei korrelierten regionalen Ausfällen.
Derive an information-theoretic lower bound for private heavy-hitter detection under local differential privacy.|Leite eine informationstheoretische Untergrenze für die Erkennung häufiger Elemente unter lokaler Differential Privacy her.
Prove the correctness of a concurrent work-stealing deque under a weak memory model, specifying linearization points.|Beweise die Korrektheit einer nebenläufigen Work-Stealing-Deque unter einem schwachen Speichermodell und benenne die Linearisierungspunkte.''',
}


def main():
    old = set()
    for source in ['dataset.json', 'calibration/test.json', 'prompting/validation.json', 'alternatives/holdout.json']:
        old.update(c['text'].strip().casefold() for c in json.loads((ROOT.parent/source).read_text())['cases'])
    cases = []
    for tier, lines in PAIRS.items():
        pairs = [line.split('|') for line in lines.splitlines()]
        assert len(pairs) == 25 and all(len(pair) == 2 for pair in pairs)
        for ordinal, pair in enumerate(pairs):
            for language, text in zip(['en', 'de'], pair):
                assert text.strip().casefold() not in old
                cases.append({'id': f'tuning-{len(cases)+1:03}', 'scenario': f'{tier}-{ordinal+1}',
                              'language': language, 'expected': tier, 'text': text})
    assert len(cases) == 200 and len({c['text'] for c in cases}) == 200
    candidate = ROOT/'candidate.json'
    dataset = {'description': 'Fresh authored synthetic rubric cases; paired EN/DE, no session text; candidate frozen before authoring.',
               'candidate_sha256': hashlib.sha256(candidate.read_bytes()).hexdigest(), 'cases': cases}
    with (ROOT/'test.json').open('x') as f:
        f.write(json.dumps(dataset, ensure_ascii=False, indent=2)+'\n')


if __name__ == '__main__':
    main()
