# Local Assets

This directory is for optional curated image assets that you pin locally after importing the skill.

Use it when you want a curated template to use a stable local portrait instead of generated fallback art or a remote source URL.

Current expected filenames:

- `andrej-karpathy.png`
- `ilya-sutskever.jpg`
- `yann-lecun.jpg`
- `elon-musk.jpg`

The meme generator prefers a matching local asset automatically when it exists.

To inspect which local asset path a template expects:

```bash
python3 scripts/generate_meme.py --info karpathy-vibe-check
```
