---
title: "Tutorial: Campaign Pulse Digest From CSV Exports"
description: Turn raw ad-platform exports into a daily or weekly marketing digest with clear actions.
sidebar_position: 7
---

# Tutorial: Campaign Pulse Digest From CSV Exports

In this tutorial, you'll turn messy marketing exports into a digest that a
small team can actually use. Instead of staring at Meta Ads, Google Ads, or
LinkedIn dashboards, you drop the exports into HybridClaw and get a concise
performance readout plus next moves.

## What We're Building

Here's the flow:

1. export CSV files from your ad platforms
2. upload them in web chat or paste them from the TUI
3. HybridClaw compares the channels, explains the changes, and flags issues
4. it optionally creates a cleaned spreadsheet for the next review

This is ideal for owner-operators and lean marketing teams who have data but no
analyst.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- recent CSV exports from one or more ad platforms
- optional office tooling if you want recalculated `.xlsx` outputs; see
  [Optional Office Dependencies](../office-dependencies.md)

## Step 1: Gather The Right Exports

Start with one time window and a small metric set. Good defaults:

- date
- campaign
- spend
- clicks
- leads or conversions
- cost per lead
- impressions

Avoid a twenty-tab export on day one. Smaller inputs usually produce better
advice.

## Step 2: Ask For A Digest

Upload the CSV files in web chat or use `/paste` in the TUI, then ask:

> 🎯 **Try it yourself**
>
> ```text
> Review the attached campaign exports for a small B2B services company.
> Compare channel performance and tell me:
> 1. what improved
> 2. what got worse
> 3. which campaigns are wasting spend
> 4. where I should shift budget this week
> 
> Return:
> - a one-screen executive summary
> - a bullet list of actions
> - a table with the most important metrics by campaign
> 
> If the data is messy, normalize it first before summarizing.
> ```

If you want a spreadsheet output too:

> 🎯 **Try it yourself**
>
> ```text
> After the summary, create a cleaned xlsx file with one sheet per channel and a
> final summary sheet with spend, leads, cost per lead, and recommended action.
> ```

## Step 3: Make The Output More Useful

After the first run, tighten the prompt based on how you actually manage
campaigns. Good additions:

- your actual target CPL
- which channels matter most
- whether brand campaigns should be treated differently
- whether awareness spend should be excluded from hard-performance judgments

Example:

> 🎯 **Try it yourself**
>
> ```text
> Treat anything above 120 EUR CPL as a problem unless lead quality is clearly
> higher. Protect branded search before cutting spend elsewhere.
> ```

## Step 4: Add A Recurring Review Cadence

If you run the same review every Monday, save a reusable prompt and schedule a
reminder:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "0 9 * * 1" Remind me to upload the latest Meta Ads, Google Ads, and LinkedIn CSV exports for the weekly campaign pulse review.
> ```

The reminder is usually better than a fully automated digest when your data
still comes from manual exports.

## Production Tips

- compare like with like; keep the same date range across channels
- tell HybridClaw what a good lead looks like
- ask for fewer metrics if the first result feels noisy
- include week-over-week changes and one clear next action per channel

## Going Further

- [Office Skills](../skills/office.md)
- [Optional Office Dependencies](../office-dependencies.md)
- [Commands](../../reference/commands.md)
