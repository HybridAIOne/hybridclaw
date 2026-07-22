---
title: Optional Office Dependencies
description: Host-side installs for LibreOffice, Poppler, and Pandoc when you want richer office workflows outside the default container image.
sidebar_position: 7
---

# Optional Office Dependencies

The default container sandbox already includes the main office tooling. These
installs matter primarily for `--sandbox=host` workflows or when you want the
same capabilities on your local machine.

Packaged Linux runtimes include the spreadsheet-inspection baseline: Python 3,
pip, `openpyxl`, `unzip`, `file`, `@e965/xlsx` (available through the compatible
`xlsx` module name), and `xlsx-populate`. The standalone agent image also
includes Poppler, QPDF, and Pandoc; its full default target adds LibreOffice.
The gateway Docker image used for cloud host-sandbox execution carries the same
Python and XLSX baseline, so spreadsheet tasks do not depend on packages left
behind in the build stage.

What they unlock:

- Python `openpyxl` and Node XLSX libraries for workbook inspection, editing,
  and formula-preserving transformations
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

Inside a packaged Docker runtime, verify the spreadsheet baseline with:

```bash
python3 -c 'import openpyxl; print(openpyxl.__version__)'
node -e "console.log(require('xlsx').version)"
```

Verify optional host-side conversion tools with:

```bash
sh -lc 'command -v soffice >/dev/null 2>&1 || command -v libreoffice >/dev/null 2>&1 && echo soffice_ok'
sh -lc 'command -v pdftoppm >/dev/null 2>&1 && echo pdftoppm_ok'
sh -lc 'command -v pandoc >/dev/null 2>&1 && echo pandoc_ok'
```

Without these tools, the office skills still create and edit `.docx`, `.xlsx`,
and `.pptx` files, but some higher-quality QA and conversion paths are
skipped.
