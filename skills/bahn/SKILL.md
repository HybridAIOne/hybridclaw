---
name: bahn
description: DB trains / Bahn Zugverbindungen, Fahrplan, departure/arrival; public-transport connections in Germany.
mini: true
metadata:
  hybridclaw:
    category: travel
---

Call hybridai__transit_routes: origin, destination (default Hbf), time=requested local ISO time with UTC offset, time_is=departure|arrival. Never browse bahn.de: DB blocks automated browsers (error 751).
Report per route: dep/arr, changes, lines, first/last stop (may be another station in the city: say so); fares only as "ca." estimates; credit Google Maps and the operators. No invented schedules.
End with the bahn.de link https://www.bahn.de/buchung/start?sts=true&so={F}&zo={T}&hd={YYYY-MM-DDTHH:MM:SS}&hza=D (F/T URL-encoded; hza=A for arrival) for current prices and booking; you can't book. Tool missing or failing→give the link and say why.
