---
title: Apple Skills
description: Apple Calendar, Apple Music, and macOS Passwords integration for HybridClaw.
sidebar_position: 5
---

# Apple Skills

> These skills require **macOS** and use `osascript` / native apps.

## apple-calendar

View Apple Calendar schedules, draft or import `.ics` files, and coordinate
calendar actions on macOS.

**Prerequisites** — macOS with Calendar.app. Optionally `icalBuddy`
(`brew install ical-buddy`) for CLI calendar queries.

> 💡 **Tips & Tricks**
>
> The skill generates portable `.ics` files by default — they work with any calendar app, not just Apple Calendar.
>
> Always confirm event details (time, timezone, attendees) before creating.
>
> For recurring events, describe the pattern in natural language — the skill handles RRULE generation.

> 🎯 **Try it yourself**
>
> `What's on my calendar for tomorrow?`
>
> `Create an ICS file for a team standup every weekday at 9:30am PST`
>
> `Show me all meetings this week with "Design" in the title`
>
> `Check my calendar for next week, find all meetings longer than 1 hour, and create an ICS file with 15-minute prep blocks before each one`

**Troubleshooting**

- **No events returned** — `icalBuddy` may not be installed, or Calendar.app
  has no accounts configured. Check with `icalBuddy -n eventsToday`.

---

## apple-music

Control Apple Music playback, inspect now playing, start playlists, and automate
the macOS Music app.

**Prerequisites** — macOS with Music.app.

> 💡 **Tips & Tricks**
>
> Transport commands (play, pause, skip) work instantly via `osascript`.
>
> For specific songs or playlists, the skill uses bundled helper scripts (`play-url.sh`, `search.sh`).
>
> Use the Music URL workflow (`music://`) for direct deep links.

> 🎯 **Try it yourself**
>
> `What song is playing right now?`
>
> `Skip to the next track`
>
> `Play my "Focus" playlist`
>
> `Search Apple Music for "Beethoven Symphony No. 9", play the top result, and tell me the performer and album name`

---

## apple-passwords

Open macOS Passwords or Keychain entries, locate saved logins, and read specific
credentials safely.

**Prerequisites** — macOS with Passwords.app (Sequoia+) or Keychain Access.

> 💡 **Tips & Tricks**
>
> The skill prioritizes metadata lookup before revealing any secret.
>
> Passwords are never printed unless you explicitly ask.
>
> Use the GUI (Passwords.app) when multiple matches exist for easier selection.

> 🎯 **Try it yourself**
>
> `Open the Passwords app`
>
> `Find my saved login for github.com`
>
> `What accounts do I have stored in Keychain for "aws"?`
>
> `Find all saved logins for AWS services, list the account names and usernames without passwords, and flag any that were last updated more than a year ago`
