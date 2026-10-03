---
name: bahn
description: DB trains / Bahn Zugverbindungen, Fahrplan, departure/arrival.
mini: true
metadata:
  hybridclaw:
    category: travel
---

DB→browser_navigate https://www.bahn.de/buchung/fahrplan/suche#sts=true&so={F}&zo={T}&soid=O%3D{F}&zoid=O%3D{T}&hd={DT}&hza=D; F/T=URL-encoded stations, default Hbf; DT=requested local YYYY-MM-DDTHH:mm:ss; skip web_search.
Read snapshot; verify route+date; dep/arr+changes+shown fares; 751/access error→stop+report, no invented schedules/booking.
Blank→https://www.bahn.de/; fresh refs: type→click station suggestions; Hinfahrt ändern→set→Übernehmen→Suchen; browser_click via tool_catalog(action=call) if hidden; no Tab loops/button typing.
