---
title: Optional Office Dependencies
description: Host-side installs for LibreOffice, Poppler, and Pandoc when you want richer office workflows outside the default container image.
sidebar_position: 7
---

# Optional Office Dependencies

The default container sandbox already includes the main office tooling. These
installs matter primarily for `--sandbox=host` workflows or when you want the
same capabilities on your local machine.

What they unlock:

- LibreOffice (`soffice`) for Office-to-PDF export, PPTX visual QA, and XLSX
  recalculation
- Poppler (`pdftoppm`) for slide and page thumbnail rendering
- Pandoc for higher-quality document conversion paths

## macOS

```bash
brew install --cask libreoffice
brew install poppler pandoc
```

## Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y libreoffice poppler-utils pandoc
```

## Fedora

```bash
sudo dnf install -y libreoffice poppler-utils pandoc
```

## Verify Availability

```bash
sh -lc 'command -v soffice >/dev/null 2>&1 || command -v libreoffice >/dev/null 2>&1 && echo soffice_ok'
sh -lc 'command -v pdftoppm >/dev/null 2>&1 && echo pdftoppm_ok'
sh -lc 'command -v pandoc >/dev/null 2>&1 && echo pandoc_ok'
```

Without these tools, the office skills still create and edit `.docx`, `.xlsx`,
and `.pptx` files, but some higher-quality QA and conversion paths are
skipped.
