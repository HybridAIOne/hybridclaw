---
name: handoff-links
description: Hand off food delivery, train trips and hotel stays to Lieferando, Wolt, Uber Eats, DB Navigator or Booking.com with a prefilled link that opens the user's app. Use when the user wants to order food, find a train in or from Germany, or find a place to stay; you cannot order or book in these services yourself.
user-invocable: false
metadata:
  hybridclaw:
    category: productivity
    short_description: "Prefilled links into delivery, rail and hotel apps."
    tags:
      - food
      - delivery
      - train
      - hotel
      - travel
      - links
---
# Handoff Links

Lieferando, Wolt, Uber Eats, Deutsche Bahn and Booking.com have no API you can
order or book through. Do the searching and thinking, then hand the last step
to the user: a link that opens their app, or the website when the app is
missing, with the search already filled in. The user picks, pays and confirms
there.

## Rules

- Never say you ordered, booked or reserved anything. Say what the link opens.
- Do not order, book or pay on these sites with the browser. Wolt's terms
  forbid bots, and the others block automated browsers. Web search to find
  options is fine.
- Build links only from the templates below. A restaurant or hotel page is
  fine only when a search result gave you its exact URL. Never invent a slug or
  an ID.
- Percent-encode every value: space `%20`, `ä` `%C3%A4`, `ö` `%C3%B6`, `ü`
  `%C3%BC`, `ß` `%C3%9F`, `(` `%28`, `)` `%29`. A raw space breaks the link.
- Write each link as a Markdown link on its own line. The label is short, in
  the user's language, and says what opens, for example
  `[Sushi in 80331 bei Lieferando](https://...)`. Never print a bare URL.
- One link per service and at most three in a reply.
- Use the postcode, city, home station and preferences you already know from
  memory or the conversation. When the link needs something you don't know,
  such as the postcode for Lieferando or the destination of a trip, ask once,
  briefly.
- Remember which delivery service the user chooses and offer it first next
  time.

## Food delivery

Offer the user's usual service. If you don't know it, start with Lieferando,
which covers the most of Germany and Austria, and add Wolt and Uber Eats in
large cities.

| Service | Link |
|---|---|
| Lieferando, Germany | `https://www.lieferando.de/lieferservice/essen/<postcode>?q=<dish or restaurant>` |
| Lieferando, Austria | `https://www.lieferando.at/lieferservice/essen/<postcode>?q=<dish or restaurant>` |
| Wolt | `https://wolt.com/de/<country>/<city>/search?q=<dish or restaurant>` |
| Uber Eats | `https://www.ubereats.com/de/search?q=<dish or restaurant>` |

- Leave out `?q=…` to open every restaurant that delivers there.
- Wolt: `<country>` is `deu` or `aut`. `<city>` is the city's English name in
  lowercase, with hyphens for spaces: `berlin`, `munich`, `hamburg`,
  `cologne`, `frankfurt`, `dusseldorf`, `stuttgart`, `nuremberg`, `vienna`,
  `graz`, `salzburg`.
- Uber Eats asks for no place: the app uses the address saved there.
- Neither Lieferando nor Wolt delivers in Switzerland. Offer Uber Eats there.

## Trains: DB Navigator

```text
https://www.bahn.de/buchung/start?sts=true&so=<from>&zo=<to>&hd=<YYYY-MM-DDTHH:MM:SS>&hza=D
```

- `so` and `zo` are stations or cities as DB writes them, for example
  `M%C3%BCnchen%20Hbf`, `Berlin%20Hbf`, `Frankfurt%28Main%29Hbf` or
  `K%C3%B6ln%20Hbf`. bahn.de looks the names up itself.
- `hd` is the departure in German local time. With `hza=A` it is the arrival
  time instead.
- Return trip: add `rd=<YYYY-MM-DDTHH:MM:SS>`. First class: add `kl=1`.
- Leave out travellers and BahnCard. DB Navigator uses the profile saved in it.
- The link opens DB Navigator with the connections listed. Without the app,
  bahn.de shows the same search.

## Hotels: Booking.com

```text
https://www.booking.com/searchresults.de.html?ss=<place>&checkin=<YYYY-MM-DD>&checkout=<YYYY-MM-DD>&group_adults=<adults>&no_rooms=1&group_children=0
```

- `ss` is a city, a district, or a hotel's name with its city.
- `searchresults.de.html` shows the page in German. Use
  `searchresults.html` for English.
- For a hotel a search result gave you, use its exact
  `https://www.booking.com/hotel/…` URL and append the same `checkin`,
  `checkout` and `group_adults`.

## Example

The user writes "Lust auf Sushi heute Abend" and you know they live in 80331
Munich:

```markdown
Hier ist Sushi in deiner Nähe:

[Sushi in 80331 bei Lieferando](https://www.lieferando.de/lieferservice/essen/80331?q=sushi)
[Sushi in München bei Wolt](https://wolt.com/de/deu/munich/search?q=sushi)
```
