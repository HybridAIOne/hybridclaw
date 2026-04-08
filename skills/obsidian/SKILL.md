---
name: obsidian
description: Read, search, organize, and create notes in the Obsidian vault.
user-invocable: true
metadata:
  hybridclaw:
    category: memory
    short_description: "Obsidian vault notes."
    tags:
      - obsidian
      - markdown
      - notes
      - vault
    related_skills:
      - notion
      - project-manager
      - write-blog-post
---
# Obsidian

Obsidian vaults are normal folders on disk. Notes are usually `*.md`. Do not
touch `.obsidian/`, `*.canvas` files, or plugin data unless the user explicitly
asks.

## Typical Vault Structure

- notes: `*.md`
- config: `.obsidian/`
- canvases: `*.canvas`
- attachments: images, PDFs, and other files in normal folders

## Vault Location

Resolve the vault path first. Use this order:

1. user-provided vault path
2. remembered vault path from `MEMORY.md`
3. `OBSIDIAN_VAULT_PATH`
4. `obsidian-cli print-default --path-only`
5. macOS config: `~/Library/Application Support/obsidian/obsidian.json`
   Use the vault with `"open": true`.
6. common defaults:
   - `~/Documents/Obsidian Vault`
   - `~/Documents/Obsidian`
   - `~/Library/Mobile Documents/iCloud~md~obsidian/Documents`

Do not treat the current workspace as the vault unless the user explicitly says
so, the workspace contains `.obsidian/`, or Obsidian's config points there.

If the resolved vault came from steps 3-6, tell the user which path you found
and ask for confirmation before making write changes. For read-only discovery or
search, you may proceed, but note the source of the vault path.

If you find a stable, unambiguous vault path, save a short fact to `MEMORY.md`,
for example `Obsidian vault: /absolute/path/to/vault`. Do not save ambiguous or
temporary vaults.

## Quick Start

Assume:

```bash
VAULT="/absolute/path/to/vault"
```

Prefer `obsidian-cli` when available for vault-aware search and safe moves.
Otherwise use the shell commands below.

Pick default vault:

```bash
obsidian-cli print-default --path-only
```

```bash
printenv OBSIDIAN_VAULT_PATH
cat "$HOME/Library/Application Support/obsidian/obsidian.json"
```

- Read:
  `sed -n '1,220p' "$VAULT/Folder/Note.md"`
  This is a bounded first read. If the note is longer than 220 lines, say so
  and continue with a wider or full read instead of pretending you saw the
  whole file.
- List:
  `rg --files "$VAULT" -g '*.md'`
- Search:
  `obsidian-cli search "keyword"`
  `obsidian-cli search-content "keyword"`
  Shell fallback:
  `rg --files "$VAULT" -g '*.md' | rg -i 'keyword'`
  `rg -n --glob '*.md' 'keyword' "$VAULT"`
- Create:
  `obsidian-cli create "Folder/New note" --content "# Title"`
  Shell fallback:
  `set -C && printf '# Title\n' > "$VAULT/Folder/New note.md"; set +C`
- Append:
  `printf '\nNew content\n' >> "$VAULT/Folder/Existing note.md"`
- Move / rename:
  `obsidian-cli move "Old Path/Note" "New Path/Note"`
  Shell fallback:
  `mv -n "$VAULT/Old Path/Note.md" "$VAULT/New Path/Note.md"`
  If you move manually, search for and fix stale links before finishing.
- Delete:
  `obsidian-cli delete "Path/Note"`
  Shell fallback:
  `rm "$VAULT/Path/Note.md"`

Wikilinks:

- prefer `[[Note Name]]` when nearby notes use wikilinks
- match the vault's existing frontmatter, heading, tag, and link style
- search before creating to avoid duplicate notes
- read before write; do not delete or overwrite notes unless the user asked
