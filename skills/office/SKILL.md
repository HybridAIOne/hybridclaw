---
name: office
description: Internal shared OOXML helper scripts for DOCX, XLSX, and PPTX unpacking, validation, and repacking. Not a user-facing skill.
user-invocable: false
disable-model-invocation: true
---

# Office Helpers

This directory exists so shared OOXML helper scripts are synced into `/workspace/skills/office` inside the agent runtime.

`skills/office/soffice.cjs` is the shared LibreOffice wrapper for Office conversion and recalculation. When the runtime says `soffice` is unavailable, skip conversion-dependent QA steps and state that limitation instead of surfacing tool errors.

Do not invoke this skill directly. User-facing office workflows should use the `docx`, `xlsx`, or future `pptx` skills.
