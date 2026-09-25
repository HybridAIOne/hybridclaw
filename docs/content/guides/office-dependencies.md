---
title: Optional Office Dependencies
description: Host-side installs for LibreOffice, Poppler, and Pandoc when you want richer office workflows outside the default container image.
sidebar_position: 7
---

# Optional Office Dependencies

The default container sandbox already includes the main office tooling. These
installs matter primarily for `--sandbox=host` workflows or when you want the
same capabilities on your local machine.

Packaged Linux runtimes share one lockfile-backed tool manifest, declared in
`container/tools/` (`package.json` plus `package-lock.json` for Node,
`requirements.in` plus the hashed `requirements.txt` for Python) and
installed into `/opt/hybridclaw-tools` by both the standalone agent image and
the gateway image: Python 3, pip, `openpyxl`, `pypdf`, `pdfplumber`,
`pdf2image`, `reportlab`, `pillow`, plus the Node libraries `docx`,
`pptxgenjs`, `csv-parse`, `iconv-lite`, `@e965/xlsx` (available through the
compatible `xlsx` module name), and `xlsx-populate`, alongside `unzip` and
`file`. The gateway Docker image is what cloud host-sandbox execution runs
skills in, so it carries the same inventory rather than a subset of it. The
standalone agent image additionally includes Poppler, QPDF, and Pandoc; its
full default target adds LibreOffice.

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

Inside a packaged Docker runtime, verify the shared inventory with:

```bash
python3 -c 'import openpyxl, reportlab; print(openpyxl.__version__)'
node -e "console.log(require('xlsx').version)"
node -e "require('pptxgenjs'); console.log('pptxgenjs ok')"
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
