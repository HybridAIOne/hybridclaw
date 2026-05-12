---
title: "Collect Invoices And Receipts From Email And Web Platforms"
description: Build a monthly collector that pulls invoices and receipts from inboxes and vendor portals, extracts the fields your bookkeeper needs, and exports a clean spreadsheet.
sidebar_position: 18
---

# Collect Invoices And Receipts From Email And Web Platforms

Small business bookkeeping dies one missing PDF at a time. Stripe sends a
receipt, but it's buried in a thread titled *"Your receipt from Acme Corp
is ready"*. The AWS invoice is inside a portal behind SSO. The SaaS vendor
emails a link, not an attachment. By month-end, someone is searching the
inbox for the word "invoice" and losing an afternoon.

This tutorial builds a monthly collector with HybridClaw. You run it once
at month-end, it sweeps the inbox and the vendor portals you point it at,
extracts the fields your bookkeeper actually needs, and hands back a
single clean spreadsheet plus the raw files in one folder.

## What We're Building

1. On the first working day of the month, the collector runs against the
   previous month.
2. HybridClaw scans email for invoices and receipts, downloads PDFs and
   follows "view your receipt" links where it can.
3. It reads the vendor portal list you maintain and either opens the
   invoice or reminds you to pull it manually with a one-line checklist.
4. It extracts standard fields for each document: vendor, invoice number,
   issue date, due date, currency, net, VAT, gross, category, payment
   method, and a notes field.
5. It outputs one `.xlsx` file for your bookkeeper and a folder of the
   original PDFs named consistently.

This is a strong fit for freelancers, agencies, e-commerce operators,
and small SaaS teams — anyone juggling 20–150 invoices a month across a
long tail of vendors.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- the email channel configured for the mailbox that receives invoices;
  see [Email](../../channels/email.md)
- the bundled office tools available if you want `.xlsx` output; see
  [Office Dependencies](../office-dependencies.md)
- a short list of vendor portals that do **not** email PDFs (AWS, GCP,
  Azure, some telecoms, some SaaS)
- optional: web search configured so HybridClaw can follow public
  "view your receipt" links from transactional email

> 💡 **Security first.** The inbox you point at likely holds more than
> invoices. Use a dedicated `invoices@` forwarder, a label/folder scope,
> or a filter that only forwards invoice-like mail to a dedicated mailbox.
> Never point HybridClaw at a primary inbox without scoping.

## Step 1: Build The Vendor Map

Start by writing down what you are actually collecting. Keep it in a
text file you paste into the prompt each month — vendors churn, and the
map is where most collection failures hide.

For each vendor, note:

- **Name** — as it appears on the invoice
- **Source** — email (sender domain), portal (URL), or both
- **Cadence** — monthly, annual, usage-based, one-off
- **Category** — hosting, software, marketing, contractors, fees, travel
- **Amount hint** — expected range, so outliers surface
- **Access** — "attachment in email", "link in email", "portal, manual
  download required"

A small business usually has 15–40 vendors. Writing this list once takes
an hour and saves a day every month afterwards.

## Step 2: Test The Collector Manually

Open a local session:

```bash
hybridclaw tui
```

Paste your vendor map, then run the collector for a single past month
first. Ask for a spreadsheet, not a chat response — the goal is a file
your bookkeeper can open.

> 🎯 **Try it yourself**
>
> ```text
> You are my bookkeeping assistant. Collect all invoices and receipts from
> the previous calendar month and produce one clean spreadsheet for my
> bookkeeper.
>
> Month to collect: March 2026
> Currency for totals: EUR (convert using the invoice date exchange rate
> where the original is USD/GBP/other, and note the original amount)
>
> Sources to check, in order:
>
> 1. Email: scan the invoices mailbox for senders matching the vendor
>    map below. Include PDF attachments and emails whose body links to a
>    hosted receipt page.
> 2. Vendor portals from the map that do not email PDFs. For each, do
>    NOT attempt to log in. Instead, list them in a "Manual pulls"
>    section with the portal URL and the exact path to the invoice
>    ("Billing -> Invoices -> March 2026 -> Download PDF").
> 3. Transactional receipts from Stripe, PayPal, Amazon, Apple, and
>    Google Workspace if they appear in the inbox.
>
> Vendor map:
> <paste your vendor map here>
>
> For every invoice you can actually read, extract these fields:
> - vendor (as on invoice)
> - invoice_number
> - issue_date (YYYY-MM-DD)
> - due_date (YYYY-MM-DD, blank if already paid)
> - currency
> - net_amount
> - vat_amount
> - gross_amount
> - category (from map, or best guess if missing)
> - payment_method (card, SEPA, PayPal, bank transfer, unknown)
> - source (email subject + date, or portal URL)
> - notes (anomalies, missing fields, currency conversions)
>
> Output one .xlsx file with two sheets:
> - Sheet 1: "Invoices" — one row per invoice, columns above
> - Sheet 2: "Manual pulls" — vendors where I need to download myself,
>   with portal URL and exact path
>
> Also produce a short summary message with:
> - total count of invoices collected
> - total gross spend in EUR
> - top 3 vendors by spend
> - any vendor from the map that has NO invoice this month (so I can
>   verify it is genuinely missing vs. just lost)
>
> Do not invent fields. If a number is missing on the invoice, leave the
> cell blank and add a note.
> ```

The first run will surface messy cases: vendors who label invoices as
"Statement", receipts that arrive as images, vendors who changed their
sender domain. Fix the vendor map before you schedule.

## Step 3: Add The Original PDFs

The spreadsheet is half the job. For audits and tax filings you also
need the originals. Add this follow-up prompt after the collection run
succeeds:

> 🎯 **Try it yourself**
>
> ```text
> Now save every invoice PDF you were able to retrieve into a folder
> named "invoices-2026-03". Rename each file using the convention:
>
> YYYY-MM-DD__vendor-slug__invoice-number.pdf
>
> Use the issue_date, a lowercased hyphenated vendor slug, and the
> invoice number with slashes removed. If the invoice number is missing,
> use "no-number". Report the folder path and the list of filenames.
> ```

Consistent filenames mean the bookkeeper can match each row in the
spreadsheet back to the PDF in one search.

## Step 4: Schedule The Monthly Run

Once the manual run produces a spreadsheet you trust, automate it. The
cleanest schedule is the first working day of the month at 9 AM:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "0 9 1-3 * 1-5" Run my monthly invoice and receipt collector for the previous calendar month. Use the vendor map from our saved notes. Produce one .xlsx with two sheets (Invoices and Manual pulls), save originals to invoices-YYYY-MM with standard filenames, and send me a short summary: total count, total gross in EUR, top 3 vendors, and any mapped vendor with zero invoices this month.
> ```

The `1-3 * 1-5` pattern fires on whichever of the 1st, 2nd, or 3rd of
the month is a weekday — so you never collect on a bank holiday when
vendors haven't sent late invoices yet.

Consider a second, lighter schedule mid-month to catch anything that
arrived late:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "0 9 15 * *" Run a mid-month invoice sweep for the previous calendar month. Only return invoices that were NOT in the collection I already ran on day one. Flag these as late arrivals with a "late" note in the spreadsheet.
> ```

## The Rules That Matter

Three rules keep the collector trustworthy over time.

**Never invent numbers.** If the invoice is an image, a foreign language
PDF the extractor cannot read, or genuinely missing a field, leave the
cell blank and add a note. A blank cell is fixable in five minutes. A
wrong number is a tax problem.

**Treat the vendor map as the source of truth.** If a vendor is in the
map but produced no invoice this month, the collector must say so
explicitly. Silent absences are how subscriptions die unnoticed and how
double-billing starts.

**Keep the originals.** Always save the PDF. The spreadsheet is a
working view; the PDF is the legal record.

## Useful Variations

- **VAT-aware reports for multi-country operations.** Add a column for
  `vat_country` and ask for a second sheet grouped by country.
- **Client-rebillable expenses.** Add a `rebillable_to_client` column
  and a third sheet that filters to rebillable items, grouped by client.
- **Categorized P&L view.** Add a pivot sheet summing gross by category
  so you can sanity-check the month against budget before closing.
- **Reimbursement pack for contractors.** Use the same collector against
  a contractor's forwarded receipts mailbox and output one PDF per
  receipt plus a summary row.
- **Year-end pack.** On January 2nd, run the collector across all twelve
  months of the prior year and consolidate into one spreadsheet for the
  accountant.

## Production Tips

- Route all invoice email to a single dedicated mailbox or label. The
  collector is only as good as the input scope.
- Resist the temptation to store vendor portal passwords for HybridClaw
  to log in. The "Manual pulls" list is the right trade-off between
  automation and security.
- Re-check the vendor map every quarter. Sender domains change more
  often than you think.
- If a vendor keeps arriving as an image receipt, ask them to switch to
  PDF — every serious vendor has a setting for it.
- Archive each month's spreadsheet and PDF folder to the same place
  your accountant already uses. A clean trail beats a clever one.

## Going Further

- [Email](../../channels/email.md)
- [Office Dependencies](../office-dependencies.md)
- [Commands](../../reference/commands.md)
- [Web Search](../../reference/tools/web-search.md)
