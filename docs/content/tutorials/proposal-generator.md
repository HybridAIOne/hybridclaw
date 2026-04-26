---
title: "Proposal Generator From Discovery Notes"
description: Convert raw meeting notes into a polished proposal with editable and PDF-friendly outputs.
sidebar_position: 9
---

# Proposal Generator From Discovery Notes

In this tutorial, you'll turn rough discovery notes into a clean proposal
workflow. HybridClaw takes your raw notes, structures the offer, writes the
document, and can save it as an editable `.docx` plus a client-friendly PDF.

## What We're Building

Here's the flow:

1. you paste notes, a transcript, or a discovery summary
2. HybridClaw extracts scope, pain points, deliverables, timeline, and pricing
3. it drafts a proposal in a business-ready structure
4. it saves the result as a document you can review and send

This works well for agencies, consultants, MSPs, freelancers, and other
service businesses.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- your notes, transcript, or workshop summary
- optional office tooling if you want better PDF export paths

See:

- [Office Skills](../skills/office.md)
- [Optional Office Dependencies](../office-dependencies.md)

## Step 1: Bring The Discovery Notes In

Paste a short note block or upload a transcript. A rough input is fine:

> 🎯 **Try it yourself**
>
> ```text
> Client: Horizon Dental Group
> Locations: 4
> Need: replace manual reporting, unify appointment analytics, and improve recall campaigns
> Main pain:
> - no single dashboard
> - front desk staff exporting CSVs by hand
> - owner wants weekly visibility by location
> 
> Timeline:
> - wants rollout before September
> 
> Budget:
> - likely 18k to 25k setup plus monthly support
> ```

## Step 2: Draft The Proposal

Ask HybridClaw:

> 🎯 **Try it yourself**
>
> ```text
> Draft a client proposal for this discovery summary.
> Use these sections:
> 1. Executive Summary
> 2. Current Situation
> 3. Proposed Solution
> 4. Scope
> 5. Implementation Timeline
> 6. Investment
> 7. Next Steps
> 
> Keep the tone clear and commercial, not academic.
> Call out assumptions where information is missing.
> ```

## Step 3: Generate The Files

Once the structure looks right, ask for deliverables:

> 🎯 **Try it yourself**
>
> ```text
> Create:
> - a polished docx proposal
> - a shorter one-page executive summary in PDF
> 
> Use the same pricing and timeline from the draft unless explicitly marked as an assumption.
> ```

If you have a standard proposal template, attach it and tell HybridClaw to
reuse that tone and structure.

## Step 4: Tighten Before Sending

Good last-mile edits:

- replace assumptions with confirmed numbers
- shorten the scope if the first draft feels too broad
- add a named project owner or kickoff date
- ask for a version with and without pricing if you sell in stages

## Best-Practice Notes

- **The executive summary does the selling.** Surveys of B2B buyers
  consistently find that most stakeholders read only the first page
  of a proposal. Build it so the exec summary alone could win the
  deal — everything after is for the technical evaluator.
- **Transparent pricing beats discounted pricing.** Breaking the
  investment into labor, software, and contingency — with a short
  reason for each line — closes more deals than a single headline
  number, even when the total is identical. Vagueness invites
  procurement to haggle the whole figure down.
- **Scope creep is written in, not negotiated out.** If the proposal
  implicitly assumes five out-of-scope things (data migration, user
  training, a legacy integration), name them explicitly as exclusions.
  Clear exclusions protect margin far better than a generous scope
  statement ever will.

## Production Tips

- a strong proposal starts with cleaner notes, not better phrasing
- tell HybridClaw what you do not want, such as buzzwords or inflated promises
- save your best prompt and reuse it for future deals
- keep the executive summary, scope, timeline, investment, and next steps near
  the front; move long credentials into an appendix
- use plain language and call out assumptions and exclusions explicitly
- use the [Office Skills](../skills/office.md) to produce a matching
  `.docx` plus a client-ready `.pdf` from the same source so the
  document version you send and the version you store are identical

## Going Further

- [Office Skills](../skills/office.md)
- [Optional Office Dependencies](../office-dependencies.md)
