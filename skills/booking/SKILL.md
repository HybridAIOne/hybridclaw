---
name: booking
description: Booking.com hotel search / Hotels, Unterkunft, availability and nightly prices.
mini: true
metadata:
  hybridclaw:
    category: travel
---

Booking→browser_navigate https://www.booking.com/searchresults.html?ss={CITY}&checkin={IN}&checkout={OUT}&group_adults=2&no_rooms=1&selected_currency=EUR&nflt=ht_id%3D204%3Bclass%3D{STARS}%3Bprice%3DEUR-0-{MAX}-1; replace ALL {...}: encoded city, ISO dates, stars, nightly max. Keep -1. Adjust guests if given. No booking/payment.
Verify rendered city+dates+EUR+Hotels+stars+budget. Reset→dismiss consent/sign-in overlays; fresh refs: fill city→matching suggestion; calendar next months→arrival/departure via exact date text→close picker→Search. Retry once; browser_network reveals redirect/dest_id to reuse.
Read cards; scroll/snapshot until 3+ matching hotels or results exhausted. Check actual stars and total÷nights≤budget; first over-budget cards or truncation never prove no matches. Return names, scores, totals/nightly, tax/breakfast/member conditions, dated links. Generic city prices aren't availability. Repeated date-dropping redirects/challenges→report blocker; never invent offers.
