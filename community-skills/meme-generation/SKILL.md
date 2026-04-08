---
name: meme-generation
description: Generate meme images from curated classic templates, dynamic imgflip templates, or a custom image. Produces real `.png` or `.jpg` artifacts in the workspace.
user-invocable: true
requires:
  bins:
    - python3
metadata:
  hybridclaw:
    short_description: Generate memes.
    category: creativity
    tags:
      - creative
      - memes
      - humor
      - images
    related_skills:
      - personality
---

# Meme Generation

Generate actual meme images from a topic. Pick a template, write captions, and render a real image file with text overlay.

## When to Use

- User asks you to make or generate a meme
- User wants a meme about a specific topic, situation, or frustration
- User says "meme this" or similar

## Available Templates

The script supports:

- curated classic templates backed by image URLs
- dynamic imgflip templates by name or ID
- custom images with optional top and bottom bars

Curated templates are grouped into packs and can be filtered with `--pack`.

Source strategy:

- Curated templates use meme-platform image URLs.
- Dynamic templates come from the imgflip API.

### Curated Templates

| ID | Name | Fields | Best for |
|----|------|--------|----------|
| `this-is-fine` | This is Fine | top, bottom | chaos, denial |
| `drake` | Drake Hotline Bling | reject, approve | rejecting or preferring |
| `distracted-boyfriend` | Distracted Boyfriend | distraction, current, person | temptation, shifting priorities |
| `two-buttons` | Two Buttons | left, right, person | impossible choice |
| `expanding-brain` | Expanding Brain | 4 levels | escalating irony |
| `change-my-mind` | Change My Mind | statement | hot takes |
| `woman-yelling-at-cat` | Woman Yelling at Cat | woman, cat | arguments |
| `one-does-not-simply` | One Does Not Simply | top, bottom | deceptively hard things |
| `grus-plan` | Gru's Plan | step1-3, realization | plans that backfire |
| `batman-slapping-robin` | Batman Slapping Robin | robin, batman | shutting down bad ideas |
### Dynamic Templates

Any template not in the curated list can still be used by name or imgflip ID. Curated search is metadata-aware and matches ids, aliases, tags, people, and pack names.

Examples:

```bash
python3 scripts/generate_meme.py --search "disaster"
python3 scripts/generate_meme.py --search "drake" --curated-only
python3 scripts/generate_meme.py --list --pack classic
python3 scripts/generate_meme.py --list --pack classic --show-source
python3 scripts/generate_meme.py --info drake
```

## Procedure

### Mode 1: Classic Template

1. Read the user's topic and identify the core meme structure: chaos, dilemma, preference, irony, or backfire.
2. Pick the template that best matches. Use the curated table above or search with `--search`.
3. Write short captions for each field. Prefer 8 to 12 words maximum per field.
4. Run the generator and write the output into the current workspace so HybridClaw can return it as an artifact:
   ```bash
   python3 scripts/generate_meme.py <template_id> ./meme.png "caption 1" "caption 2"
   ```
5. Return the generated image artifact.

For curated template discovery:

```bash
python3 scripts/generate_meme.py --list --pack classic
python3 scripts/generate_meme.py --search "boyfriend" --curated-only
python3 scripts/generate_meme.py --info this-is-fine
```

### Mode 2: Custom Image

Use this when no classic template fits, or when the user wants something original.

1. Write the captions first.
2. Generate or locate the source image.
3. Run the script with `--image` to overlay text:
   - Overlay mode:
     ```bash
     python3 scripts/generate_meme.py --image /path/to/scene.png ./meme.png "top text" "bottom text"
     ```
   - Bar mode:
     ```bash
     python3 scripts/generate_meme.py --image /path/to/scene.png --bars ./meme.png "top text" "bottom text"
     ```
4. Use `--bars` when the image is visually busy and direct overlay would hurt readability.
5. Return the generated image artifact.

## Examples

**"debugging production at 2 AM":**

```bash
python3 scripts/generate_meme.py this-is-fine ./meme.png "SERVERS ARE ON FIRE" "This is fine"
```

**"choosing between sleep and one more episode":**

```bash
python3 scripts/generate_meme.py drake ./meme.png "Getting 8 hours of sleep" "One more episode at 3 AM"
```

**"the stages of a Monday morning":**

```bash
python3 scripts/generate_meme.py expanding-brain ./meme.png "Setting an alarm" "Setting 5 alarms" "Sleeping through all alarms" "Working from bed"
```

**"everyone wants the repo moved":**

```bash
python3 scripts/generate_meme.py drake ./meme.png "Leaving the repo where it is" "Let's move the repository"
```

## Listing Templates

To see the curated templates:

```bash
python3 scripts/generate_meme.py --list
python3 scripts/generate_meme.py --list --pack classic
python3 scripts/generate_meme.py --list --pack classic --show-source
```

## Pitfalls

- Keep captions short. Long meme text usually looks bad.
- Match the number of text arguments to the template's field count.
- Pick the template that fits the joke structure, not just the topic.
- Do not generate hateful, abusive, or personally targeted content.
- Do not use the skill to target a real private individual. For public figures or celebrities, avoid harassment, defamation, or demeaning personal attacks.
- Template downloads and imgflip API data are cached in a per-user temp cache directory.
- Write output files into the current workspace, not `/tmp`, when you want HybridClaw to return the image automatically.

## Verification

The output is correct if:

- An image file was created at the output path
- Text is legible on the template or custom image
- The joke structure matches the chosen template
- The file is written inside the current workspace so artifact collection can pick it up
