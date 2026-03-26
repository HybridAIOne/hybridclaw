#!/usr/bin/env python3
# ruff: noqa: INP001
"""Generate meme images from curated templates, imgflip templates, or custom images."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.request
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any, NotRequired, TypedDict, cast

try:
    import requests as _requests
except ImportError:
    _requests = None

from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATES_FILE = SCRIPT_DIR / 'templates.json'
CACHE_DIR = Path('/tmp/.meme-cache')
IMGFLIP_API = 'https://api.imgflip.com/get_memes'
IMGFLIP_CACHE_FILE = CACHE_DIR / 'imgflip_memes.json'
IMGFLIP_CACHE_MAX_AGE = 86_400
DEFAULT_TIMEOUT_SECONDS = 15
HTTP_HEADERS = {
    'User-Agent': 'HybridClaw Meme Skill/2.0',
    'Accept': '*/*',
}
FONT_CANDIDATES = (
    '/usr/share/fonts/truetype/msttcorefonts/Impact.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu-sans/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/SFCompact.ttf',
)
MEASURE_DRAW = ImageDraw.Draw(Image.new('RGB', (1, 1)))


class TemplateField(TypedDict):
    name: str
    x_pct: float
    y_pct: float
    w_pct: float
    align: str


class TemplateAsset(TypedDict):
    local_path: NotRequired[str]
    remote_url: NotRequired[str]
    source_page: NotRequired[str]
    license: NotRequired[str]
    attribution: NotRequired[str]
    notes: NotRequired[str]


class MemeTemplate(TypedDict):
    name: str
    best_for: str
    fields: list[TemplateField]
    pack: NotRequired[str]
    aliases: NotRequired[list[str]]
    tags: NotRequired[list[str]]
    people: NotRequired[list[str]]
    generator: NotRequired[str]
    url: NotRequired[str]
    asset: NotRequired[TemplateAsset]


class ResolvedTemplate(TypedDict):
    id: str
    name: str
    best_for: str
    fields: list[TemplateField]
    source: str
    pack: str
    aliases: list[str]
    tags: list[str]
    people: list[str]
    generator: str | None
    url: str | None
    asset: TemplateAsset | None


def _fetch_url(url: str, timeout: int = DEFAULT_TIMEOUT_SECONDS) -> bytes:
    if _requests is not None:
        response = _requests.get(url, timeout=timeout, headers=HTTP_HEADERS)
        response.raise_for_status()
        return response.content

    try:
        request = urllib.request.Request(url, headers=HTTP_HEADERS)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f'Failed to fetch {url}') from exc


def load_curated_templates() -> dict[str, MemeTemplate]:
    with TEMPLATES_FILE.open(encoding='utf-8') as handle:
        raw = json.load(handle)
    return cast(dict[str, MemeTemplate], raw)


def _default_fields(box_count: int) -> list[TemplateField]:
    if box_count <= 0:
        box_count = 2

    if box_count == 1:
        return [
            {
                'name': 'text',
                'x_pct': 0.5,
                'y_pct': 0.5,
                'w_pct': 0.90,
                'align': 'center',
            }
        ]

    if box_count == 2:
        return [
            {
                'name': 'top',
                'x_pct': 0.5,
                'y_pct': 0.08,
                'w_pct': 0.95,
                'align': 'center',
            },
            {
                'name': 'bottom',
                'x_pct': 0.5,
                'y_pct': 0.92,
                'w_pct': 0.95,
                'align': 'center',
            },
        ]

    fields: list[TemplateField] = []
    for index in range(box_count):
        y_pct = 0.08 + (0.84 * index / (box_count - 1))
        fields.append(
            {
                'name': f'text{index + 1}',
                'x_pct': 0.5,
                'y_pct': round(y_pct, 2),
                'w_pct': 0.90,
                'align': 'center',
            }
        )
    return fields


def fetch_imgflip_templates() -> list[dict[str, Any]]:
    import time

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if IMGFLIP_CACHE_FILE.exists():
        age = time.time() - IMGFLIP_CACHE_FILE.stat().st_mtime
        if age < IMGFLIP_CACHE_MAX_AGE:
            with IMGFLIP_CACHE_FILE.open(encoding='utf-8') as handle:
                return cast(list[dict[str, Any]], json.load(handle))

    try:
        payload = json.loads(_fetch_url(IMGFLIP_API))
        memes = cast(list[dict[str, Any]], payload.get('data', {}).get('memes', []))
        with IMGFLIP_CACHE_FILE.open('w', encoding='utf-8') as handle:
            json.dump(memes, handle)
        return memes
    except Exception as exc:
        if IMGFLIP_CACHE_FILE.exists():
            with IMGFLIP_CACHE_FILE.open(encoding='utf-8') as handle:
                return cast(list[dict[str, Any]], json.load(handle))
        print(f'Warning: could not fetch imgflip templates: {exc}', file=sys.stderr)
        return []


def _slugify(name: str) -> str:
    slug = []
    for char in name.lower():
        if char.isalnum():
            slug.append(char)
        elif slug and slug[-1] != '-':
            slug.append('-')
    return ''.join(slug).strip('-')


def _searchable_terms(template_id: str, template: MemeTemplate) -> set[str]:
    values = [
        template_id,
        template.get('name', ''),
        template.get('best_for', ''),
        template.get('pack', ''),
        *template.get('aliases', []),
        *template.get('tags', []),
        *template.get('people', []),
    ]
    terms: set[str] = set()
    for value in values:
        normalized = str(value).strip().lower()
        if not normalized:
            continue
        terms.add(normalized)
        terms.add(_slugify(normalized))
    return terms


def _normalize_template(template_id: str, template: MemeTemplate, source: str) -> ResolvedTemplate:
    return {
        'id': template_id,
        'name': template['name'],
        'best_for': template['best_for'],
        'fields': template['fields'],
        'source': source,
        'pack': template.get('pack', 'classic'),
        'aliases': template.get('aliases', []),
        'tags': template.get('tags', []),
        'people': template.get('people', []),
        'generator': template.get('generator'),
        'url': template.get('url'),
        'asset': template.get('asset'),
    }


def _matches_filters(
    template_id: str,
    template: MemeTemplate,
    *,
    query: str | None = None,
    pack: str | None = None,
    tag: str | None = None,
    person: str | None = None,
) -> bool:
    if pack and template.get('pack', 'classic') != pack:
        return False

    tags = [entry.lower() for entry in template.get('tags', [])]
    if tag and tag.lower() not in tags:
        return False

    people = [entry.lower() for entry in template.get('people', [])]
    if person and person.lower() not in people:
        return False

    if query:
        query_slug = _slugify(query)
        query_lower = query.lower().strip()
        haystack = ' '.join(sorted(_searchable_terms(template_id, template)))
        return query_lower in haystack or query_slug in haystack

    return True


def _resolve_asset_path(local_path: str) -> Path:
    asset_path = Path(local_path)
    if asset_path.is_absolute():
        return asset_path
    return (SCRIPT_DIR / asset_path).resolve()


def load_local_asset_image(asset: TemplateAsset | None) -> Image.Image | None:
    if not asset:
        return None
    local_path = asset.get('local_path')
    if not local_path:
        return None
    resolved = _resolve_asset_path(local_path)
    if not resolved.exists():
        return None
    return Image.open(resolved).convert('RGBA')


def resolve_template(identifier: str) -> ResolvedTemplate | None:
    curated = load_curated_templates()
    slug = _slugify(identifier)
    normalized = identifier.strip().lower()

    if identifier in curated:
        return _normalize_template(identifier, curated[identifier], 'curated')

    for template_id, template in curated.items():
        if slug in _searchable_terms(template_id, template):
            return _normalize_template(template_id, template, 'curated')

    for meme in fetch_imgflip_templates():
        meme_name = str(meme.get('name', ''))
        meme_slug = _slugify(meme_name)
        if (
            meme_slug == slug
            or str(meme.get('id', '')) == identifier.strip()
            or normalized in meme_name.lower()
        ):
            box_count_raw = meme.get('box_count', 2)
            box_count = box_count_raw if isinstance(box_count_raw, int) else 2
            dynamic_template: MemeTemplate = {
                'name': meme_name,
                'best_for': 'dynamic imgflip template',
                'fields': _default_fields(box_count),
                'pack': 'dynamic',
                'tags': ['imgflip', 'classic'],
                'url': str(meme.get('url', '')),
            }
            return _normalize_template(meme_slug or str(meme.get('id', '')), dynamic_template, 'imgflip')

    return None


def _interpolate_color(start: tuple[int, int, int], end: tuple[int, int, int], ratio: float) -> tuple[int, int, int]:
    return (
        int(start[0] + ((end[0] - start[0]) * ratio)),
        int(start[1] + ((end[1] - start[1]) * ratio)),
        int(start[2] + ((end[2] - start[2]) * ratio)),
    )


def _vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    image = Image.new('RGBA', size)
    draw = ImageDraw.Draw(image)
    for y_pos in range(height):
        ratio = y_pos / max(1, height - 1)
        color = _interpolate_color(top, bottom, ratio) + (255,)
        draw.line((0, y_pos, width, y_pos), fill=color)
    return image


def _draw_glow(draw: ImageDraw.ImageDraw, center: tuple[int, int], radius: int, color: tuple[int, int, int]) -> None:
    cx, cy = center
    for step in range(5, 0, -1):
        current = radius + (step * 10)
        alpha = max(20, 60 - (step * 8))
        draw.ellipse(
            (cx - current, cy - current, cx + current, cy + current),
            fill=color + (alpha,),
        )


def _draw_label(draw: ImageDraw.ImageDraw, text: str, box: tuple[int, int, int, int], fill: tuple[int, int, int], text_fill: tuple[int, int, int]) -> None:
    x1, y1, x2, y2 = box
    draw.rounded_rectangle(box, radius=20, fill=fill)
    font = find_font(max(18, (y2 - y1) // 2))
    text_bbox = draw.textbbox((0, 0), text, font=font)
    text_width = text_bbox[2] - text_bbox[0]
    text_height = text_bbox[3] - text_bbox[1]
    draw.text(
        (x1 + ((x2 - x1 - text_width) // 2), y1 + ((y2 - y1 - text_height) // 2) - 2),
        text,
        font=font,
        fill=text_fill,
    )


def _draw_lobster(draw: ImageDraw.ImageDraw, center: tuple[int, int], scale: float, color: tuple[int, int, int]) -> None:
    cx, cy = center
    body_w = int(120 * scale)
    body_h = int(180 * scale)
    claw_w = int(70 * scale)
    claw_h = int(90 * scale)
    leg_len = int(80 * scale)
    shell = color + (255,)
    dark = tuple(max(0, channel - 50) for channel in color) + (255,)

    draw.ellipse((cx - body_w // 2, cy - body_h // 2, cx + body_w // 2, cy + body_h // 2), fill=shell)
    draw.ellipse((cx - body_w // 3, cy - body_h // 2 - 25, cx + body_w // 3, cy - body_h // 6), fill=dark)
    draw.polygon(
        [
            (cx - body_w // 2, cy - body_h // 4),
            (cx - body_w // 2 - claw_w, cy - body_h // 3 - claw_h // 3),
            (cx - body_w // 2 - claw_w // 2, cy - body_h // 8),
        ],
        fill=shell,
    )
    draw.polygon(
        [
            (cx + body_w // 2, cy - body_h // 4),
            (cx + body_w // 2 + claw_w, cy - body_h // 3 - claw_h // 3),
            (cx + body_w // 2 + claw_w // 2, cy - body_h // 8),
        ],
        fill=shell,
    )
    draw.ellipse(
        (
            cx - body_w // 2 - claw_w - 20,
            cy - body_h // 3 - claw_h,
            cx - body_w // 2 - 10,
            cy - body_h // 3,
        ),
        fill=shell,
    )
    draw.ellipse(
        (
            cx + body_w // 2 + 10,
            cy - body_h // 3 - claw_h,
            cx + body_w // 2 + claw_w + 20,
            cy - body_h // 3,
        ),
        fill=shell,
    )
    for leg_offset in (-2, -1, 1, 2):
        y_pos = cy + (leg_offset * 18)
        draw.line((cx - body_w // 2, y_pos, cx - body_w // 2 - leg_len, y_pos + 24), fill=dark, width=max(4, int(6 * scale)))
        draw.line((cx + body_w // 2, y_pos, cx + body_w // 2 + leg_len, y_pos + 24), fill=dark, width=max(4, int(6 * scale)))
    for antenna_offset in (-1, 1):
        draw.line((cx + (antenna_offset * 16), cy - body_h // 2 - 6, cx + (antenna_offset * 80), cy - body_h // 2 - 90), fill=dark, width=max(3, int(4 * scale)))
    draw.ellipse((cx - 18, cy - body_h // 2 - 6, cx - 6, cy - body_h // 2 + 8), fill=(255, 255, 255, 255))
    draw.ellipse((cx + 6, cy - body_h // 2 - 6, cx + 18, cy - body_h // 2 + 8), fill=(255, 255, 255, 255))


def _draw_jellyfish(draw: ImageDraw.ImageDraw, center: tuple[int, int], scale: float, color: tuple[int, int, int]) -> None:
    cx, cy = center
    bell_w = int(170 * scale)
    bell_h = int(120 * scale)
    main = color + (190,)
    bright = tuple(min(255, channel + 40) for channel in color)

    _draw_glow(draw, center, int(80 * scale), bright)
    draw.ellipse((cx - bell_w // 2, cy - bell_h // 2, cx + bell_w // 2, cy + bell_h // 2), fill=main)
    draw.rectangle((cx - bell_w // 2, cy, cx + bell_w // 2, cy + bell_h // 3), fill=main)
    for index in range(7):
        x_pos = cx - bell_w // 2 + int((index + 0.5) * bell_w / 7)
        points = []
        for step in range(8):
            y_pos = cy + bell_h // 4 + (step * int(24 * scale))
            wave = math.sin(step + index) * (12 * scale)
            points.append((x_pos + wave, y_pos))
        draw.line(points, fill=bright + (220,), width=max(3, int(4 * scale)))


def _draw_terminal(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], accent: tuple[int, int, int]) -> None:
    x1, y1, x2, y2 = box
    draw.rounded_rectangle(box, radius=24, fill=(12, 18, 26, 230), outline=accent + (255,), width=4)
    draw.rectangle((x1, y1, x2, y1 + 36), fill=(26, 36, 52, 230))
    for index, color in enumerate(((255, 96, 92), (255, 189, 68), (39, 201, 63))):
        cx = x1 + 24 + (index * 22)
        draw.ellipse((cx - 7, y1 + 11, cx + 7, y1 + 25), fill=color + (255,))
    font = find_font(24)
    lines = ['> fine_tune --dataset vibes.jsonl', '> eval --leaderboard', '> ship --quietly']
    for idx, line in enumerate(lines):
        draw.text((x1 + 28, y1 + 56 + (idx * 38)), line, font=font, fill=(170, 255, 210, 255))


def _draw_rocket(draw: ImageDraw.ImageDraw, center: tuple[int, int], scale: float) -> None:
    cx, cy = center
    width = int(70 * scale)
    height = int(200 * scale)
    draw.polygon(
        [
            (cx, cy - height // 2),
            (cx - width // 2, cy + height // 4),
            (cx + width // 2, cy + height // 4),
        ],
        fill=(240, 240, 245, 255),
    )
    draw.rounded_rectangle(
        (cx - width // 2, cy - height // 5, cx + width // 2, cy + height // 3),
        radius=24,
        fill=(235, 235, 240, 255),
    )
    draw.ellipse((cx - 18, cy - 20, cx + 18, cy + 16), fill=(76, 180, 255, 255))
    draw.polygon(
        [(cx - width // 2, cy + 36), (cx - width, cy + 88), (cx - width // 3, cy + 78)],
        fill=(220, 64, 64, 255),
    )
    draw.polygon(
        [(cx + width // 2, cy + 36), (cx + width, cy + 88), (cx + width // 3, cy + 78)],
        fill=(220, 64, 64, 255),
    )
    draw.polygon(
        [(cx - 18, cy + height // 3), (cx, cy + height // 2), (cx + 18, cy + height // 3)],
        fill=(255, 134, 46, 255),
    )


def _draw_lightning(draw: ImageDraw.ImageDraw, points: list[tuple[int, int]], color: tuple[int, int, int]) -> None:
    draw.line(points, fill=color + (255,), width=10)
    for point in points:
        _draw_glow(draw, point, 12, color)


def _draw_badge(draw: ImageDraw.ImageDraw, text: str, position: tuple[int, int], fill: tuple[int, int, int]) -> None:
    font = find_font(26)
    bbox = draw.textbbox((0, 0), text, font=font)
    width = bbox[2] - bbox[0] + 28
    height = bbox[3] - bbox[1] + 18
    x_pos, y_pos = position
    draw.rounded_rectangle((x_pos, y_pos, x_pos + width, y_pos + height), radius=18, fill=fill + (225,))
    draw.text((x_pos + 14, y_pos + 8), text, font=font, fill=(255, 255, 255, 255))


def _brand_title(draw: ImageDraw.ImageDraw, text: str, position: tuple[int, int], size: int = 44) -> None:
    font = find_font(size)
    draw.text(position, text, font=font, fill=(245, 248, 255, 255), stroke_width=2, stroke_fill=(18, 24, 36, 255))


def generate_template_art(
    template: ResolvedTemplate,
    *,
    prefer_remote_curated: bool = False,
) -> Image.Image:
    asset = template.get('asset')
    local_image = load_local_asset_image(asset)
    if local_image is not None:
        return local_image

    if prefer_remote_curated and asset and asset.get('remote_url'):
        return get_template_image(asset['remote_url'])

    generator = template.get('generator')
    if generator is None:
        url = template.get('url')
        if not url:
            if asset and asset.get('remote_url'):
                return get_template_image(asset['remote_url'])
            raise RuntimeError(
                f"Template {template['id']} is missing generator, local asset, and remote image"
            )
        return get_template_image(url)

    size = (1280, 1280)
    if generator.startswith('openclaw'):
        image = _vertical_gradient(size, (31, 18, 36), (246, 115, 59))
    elif generator.startswith('hybridclaw'):
        image = _vertical_gradient(size, (10, 28, 58), (24, 172, 196))
    elif generator.startswith('ai'):
        image = _vertical_gradient(size, (24, 24, 34), (76, 84, 144))
    else:
        image = _vertical_gradient(size, (28, 28, 28), (96, 96, 96))

    draw = ImageDraw.Draw(image, 'RGBA')

    if generator == 'openclaw-lobster-hotseat':
        _brand_title(draw, 'OPENCLAW HOTSEAT', (70, 54))
        _draw_label(draw, 'PR FIRE', (915, 70, 1160, 140), (111, 28, 34, 220), (255, 234, 222))
        _draw_lobster(draw, (315, 700), 1.4, (238, 94, 53))
        _draw_terminal(draw, (625, 400, 1160, 760), (255, 181, 122))
        for x_pos in range(0, 1280, 120):
            draw.arc((x_pos - 60, 990, x_pos + 180, 1200), start=0, end=180, fill=(255, 210, 180, 90), width=3)
    elif generator == 'openclaw-lobster-choices':
        _brand_title(draw, 'OPENCLAW DECISION ENGINE', (72, 54))
        draw.rounded_rectangle((90, 260, 580, 1080), radius=42, fill=(94, 28, 36, 110))
        draw.rounded_rectangle((700, 260, 1190, 1080), radius=42, fill=(255, 212, 188, 85))
        _draw_lobster(draw, (355, 760), 1.18, (224, 82, 45))
        _draw_lobster(draw, (935, 760), 1.18, (255, 156, 112))
        _draw_label(draw, 'LEFT CLAW', (196, 292, 474, 362), (111, 29, 44, 220), (255, 239, 232))
        _draw_label(draw, 'RIGHT CLAW', (780, 292, 1080, 362), (255, 173, 120, 220), (58, 28, 18))
    elif generator == 'openclaw-lobster-review':
        _brand_title(draw, 'OPENCLAW REVIEW BOARD', (72, 54))
        _draw_terminal(draw, (270, 360, 1010, 790), (255, 155, 103))
        _draw_lobster(draw, (210, 970), 0.78, (236, 86, 50))
        _draw_lobster(draw, (1065, 970), 0.78, (255, 145, 98))
        _draw_label(draw, 'MERGE?', (972, 104, 1166, 168), (128, 28, 36, 220), (255, 232, 225))
    elif generator == 'hybridclaw-jellyfish-drift':
        _brand_title(draw, 'HYBRIDCLAW DRIFT', (72, 54))
        _draw_jellyfish(draw, (320, 760), 1.4, (119, 228, 255))
        _draw_jellyfish(draw, (945, 560), 1.1, (173, 110, 255))
        for x_pos in range(80, 1240, 110):
            draw.line((x_pos, 1080, x_pos + 24, 1250), fill=(179, 255, 249, 90), width=3)
    elif generator == 'hybridclaw-jellyfish-swarm':
        _brand_title(draw, 'HYBRIDCLAW SWARM', (72, 54))
        centers = [(250, 460), (530, 760), (790, 520), (1040, 840)]
        colors = [(96, 224, 255), (178, 112, 255), (124, 245, 211), (255, 138, 220)]
        for center, color in zip(centers, colors, strict=False):
            _draw_jellyfish(draw, center, 0.92, color)
    elif generator == 'hybridclaw-jellyfish-ascension':
        _brand_title(draw, 'HYBRIDCLAW ASCENSION', (72, 54))
        levels = [
            ((980, 220), 0.44, (80, 206, 255)),
            ((980, 470), 0.58, (120, 225, 255)),
            ((980, 740), 0.74, (164, 198, 255)),
            ((980, 1010), 0.92, (212, 146, 255)),
        ]
        for center, scale, color in levels:
            _draw_jellyfish(draw, center, scale, color)
    elif generator == 'ai-karpathy-vibe-check':
        _brand_title(draw, 'KARPATHY VIBE CHECK', (72, 54))
        _draw_badge(draw, 'karpathy', (960, 68), (108, 84, 218))
        _draw_terminal(draw, (150, 270, 1130, 840), (118, 140, 255))
        for y_pos in range(900, 1180, 40):
            draw.line((120, y_pos, 1160, y_pos), fill=(170, 180, 255, 40), width=2)
    elif generator == 'ai-sutskever-breakthrough':
        _brand_title(draw, 'SUTSKEVER BREAKTHROUGH', (72, 54))
        _draw_badge(draw, 'sutskever', (930, 68), (72, 110, 232))
        _draw_lightning(draw, [(280, 340), (520, 510), (430, 720), (760, 880), (620, 1080)], (122, 184, 255))
        draw.rounded_rectangle((820, 290, 1150, 980), radius=34, fill=(245, 247, 255, 160))
        for row in range(6):
            y_pos = 350 + (row * 90)
            draw.line((860, y_pos, 1110, y_pos), fill=(55, 76, 122, 150), width=8)
    elif generator == 'ai-what-did-ilya-see':
        _brand_title(draw, 'WHAT DID ILYA SEE', (72, 54))
        _draw_badge(draw, 'ilya', (1060, 68), (70, 102, 224))
        _draw_glow(draw, (930, 420), 170, (144, 210, 255))
        _draw_lightning(
            draw,
            [(800, 320), (690, 470), (860, 620), (760, 760), (940, 930)],
            (166, 225, 255),
        )
        draw.rounded_rectangle(
            (110, 280, 500, 1030),
            radius=42,
            fill=(16, 24, 40, 155),
            outline=(118, 170, 255, 180),
            width=4,
        )
        font = find_font(34)
        for index, line in enumerate(
            ('loss curves flatten', 'alignment notes blink', 'the weights whisper')
        ):
            draw.text(
                (150, 420 + (index * 150)),
                line,
                font=font,
                fill=(212, 226, 255, 255),
            )
    elif generator == 'ai-yann-lecun-reality-check':
        _brand_title(draw, 'YANN LeCUN REALITY CHECK', (72, 54))
        _draw_badge(draw, 'yann lecun', (915, 68), (48, 148, 180))
        draw.rounded_rectangle((120, 260, 1160, 980), radius=42, fill=(15, 26, 46, 150), outline=(122, 238, 255, 180), width=4)
        for index in range(5):
            x_pos = 210 + (index * 180)
            draw.line((x_pos, 360, x_pos, 920), fill=(100, 210, 220, 90), width=3)
        for index in range(4):
            y_pos = 420 + (index * 130)
            draw.line((160, y_pos, 1120, y_pos), fill=(100, 210, 220, 90), width=3)
    elif generator == 'ai-elon-ship-it':
        _brand_title(draw, 'ELON SHIP IT', (72, 54))
        _draw_badge(draw, 'elon', (1030, 68), (48, 48, 56))
        _draw_rocket(draw, (970, 725), 1.25)
        draw.rounded_rectangle((108, 280, 650, 900), radius=42, fill=(14, 14, 20, 140))
        font = find_font(34)
        for index, line in enumerate(('roadmap_v27', 'launch_now', 'fix_in_prod')):
            draw.text((170, 390 + (index * 120)), line, font=font, fill=(201, 211, 255, 255))
    else:
        raise RuntimeError(f"Unsupported template generator: {generator}")

    return image


def get_template_image(url: str) -> Image.Image:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = (CACHE_DIR / url.split('/')[-1]).with_suffix('.png')
    if cache_path.exists():
        return Image.open(cache_path).convert('RGBA')

    image = Image.open(BytesIO(_fetch_url(url))).convert('RGBA')
    image.save(cache_path, 'PNG')
    return image


@lru_cache(maxsize=1)
def _resolve_font_path() -> str | None:
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return None


@lru_cache(maxsize=32)
def find_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    font_path = _resolve_font_path()
    if font_path:
        try:
            return ImageFont.truetype(font_path, size)
        except (OSError, IOError):
            pass

    try:
        return ImageFont.truetype('DejaVuSans-Bold', size)
    except (OSError, IOError):
        return ImageFont.load_default()


def _wrap_text(
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    max_width: int,
) -> str:
    words = text.split()
    if not words:
        return text

    lines: list[str] = []
    current_line = words[0]
    for word in words[1:]:
        candidate = f'{current_line} {word}'
        if font.getlength(candidate) <= max_width:
            current_line = candidate
            continue
        lines.append(current_line)
        current_line = word

    lines.append(current_line)
    return '\n'.join(lines)


def draw_outlined_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    x_pos: int,
    y_pos: int,
    font_size: int,
    max_width: int,
    align: str = 'center',
) -> None:
    size = font_size
    wrapped = text
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont = find_font(size)

    while size > 12:
        font = find_font(size)
        wrapped = _wrap_text(text, font, max_width)
        bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align=align)
        text_width = bbox[2] - bbox[0]
        line_count = wrapped.count('\n') + 1
        if text_width <= max_width * 1.05 and line_count <= 4:
            break
        size -= 2
    else:
        font = find_font(size)
        wrapped = _wrap_text(text, font, max_width)

    bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align=align)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    text_x = x_pos - text_width // 2
    text_y = y_pos - text_height // 2
    outline = max(2, size // 18)
    draw.multiline_text(
        (text_x, text_y),
        wrapped,
        font=font,
        fill='white',
        align=align,
        stroke_width=outline,
        stroke_fill='black',
    )


def _overlay_on_image(image: Image.Image, texts: list[str], fields: list[TemplateField]) -> Image.Image:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    base_font_size = max(18, min(width, height) // 11)
    for index, field in enumerate(fields):
        if index >= len(texts):
            break
        text = texts[index].strip()
        if not text:
            continue
        draw_outlined_text(
            draw,
            text,
            int(field['x_pct'] * width),
            int(field['y_pct'] * height),
            base_font_size,
            int(field['w_pct'] * width),
            field.get('align', 'center'),
        )
    return image


def _measure_bar(
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    max_width: int,
    padding: int,
) -> tuple[int, str]:
    if not text:
        return 0, ''
    wrapped = _wrap_text(text, font, max_width)
    bbox = MEASURE_DRAW.multiline_textbbox((0, 0), wrapped, font=font, align='center')
    return (bbox[3] - bbox[1]) + (padding * 2), wrapped


def _add_bars(image: Image.Image, texts: list[str]) -> Image.Image:
    width, height = image.size
    font_size = max(20, width // 16)
    font = find_font(font_size)
    padding = font_size // 2
    max_width = int(width * 0.92)

    top_text = texts[0].strip() if texts else ''
    bottom_text = texts[-1].strip() if len(texts) > 1 else ''
    middle_texts = [text.strip() for text in texts[1:-1]] if len(texts) > 2 else []

    top_height, wrapped_top = _measure_bar(top_text, font, max_width, padding)
    bottom_height, wrapped_bottom = _measure_bar(bottom_text, font, max_width, padding)
    canvas_height = height + top_height + bottom_height

    canvas = Image.new('RGB', (width, canvas_height), (0, 0, 0))
    canvas.paste(image.convert('RGB'), (0, top_height))
    draw = ImageDraw.Draw(canvas)

    if wrapped_top:
        bbox = draw.multiline_textbbox((0, 0), wrapped_top, font=font, align='center')
        draw.multiline_text(
            ((width - (bbox[2] - bbox[0])) // 2, (top_height - (bbox[3] - bbox[1])) // 2),
            wrapped_top,
            font=font,
            fill='white',
            align='center',
        )

    if wrapped_bottom:
        bbox = draw.multiline_textbbox((0, 0), wrapped_bottom, font=font, align='center')
        draw.multiline_text(
            (
                (width - (bbox[2] - bbox[0])) // 2,
                top_height + height + ((bottom_height - (bbox[3] - bbox[1])) // 2),
            ),
            wrapped_bottom,
            font=font,
            fill='white',
            align='center',
        )

    if middle_texts:
        fields = _default_fields(len(middle_texts))
        shifted_fields: list[TemplateField] = []
        for field in fields:
            shifted_fields.append(
                {
                    **field,
                    'y_pct': (top_height + (field['y_pct'] * height)) / canvas_height,
                    'w_pct': 0.90,
                }
            )
        _overlay_on_image(canvas, middle_texts, shifted_fields)

    return canvas


def _prepare_output_path(output_path: str) -> Path:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    return output


def generate_meme(
    template_id: str,
    texts: list[str],
    output_path: str,
    *,
    prefer_remote_curated: bool = False,
) -> str:
    template = resolve_template(template_id)
    if template is None:
        print(f'Unknown template: {template_id}', file=sys.stderr)
        print('Use --list to browse curated templates or --search to discover more.', file=sys.stderr)
        raise SystemExit(1)

    print(
        f"Using template: {template['name']} ({template['source']}, pack={template['pack']}, {len(template['fields'])} fields)",
        file=sys.stderr,
    )
    image = generate_template_art(
        template,
        prefer_remote_curated=prefer_remote_curated,
    )
    result = _overlay_on_image(image, texts, template['fields'])
    output = _prepare_output_path(output_path)
    if output.suffix.lower() in ('.jpg', '.jpeg'):
        result = result.convert('RGB')
    result.save(output, quality=95)
    return str(output)


def generate_from_image(
    image_path: str,
    texts: list[str],
    output_path: str,
    use_bars: bool = False,
) -> str:
    image = Image.open(image_path).convert('RGBA')
    print(
        f"Custom image: {image.size[0]}x{image.size[1]}, {len(texts)} text(s), mode={'bars' if use_bars else 'overlay'}",
        file=sys.stderr,
    )
    result = _add_bars(image, texts) if use_bars else _overlay_on_image(image, texts, _default_fields(len(texts)))
    output = _prepare_output_path(output_path)
    if output.suffix.lower() in ('.jpg', '.jpeg'):
        result = result.convert('RGB')
    result.save(output, quality=95)
    return str(output)


def _template_source_label(template: MemeTemplate) -> str:
    asset = template.get('asset')
    if asset and asset.get('local_path'):
        return 'asset+fallback'
    if template.get('generator'):
        return 'generated'
    if template.get('url'):
        return 'remote'
    return 'unknown'


def list_templates(
    pack: str | None = None,
    *,
    tag: str | None = None,
    person: str | None = None,
    show_source: bool = False,
) -> None:
    templates = load_curated_templates()
    rows: list[tuple[str, str, str, int, str, str]] = []
    for template_id, template in sorted(templates.items()):
        template_pack = template.get('pack', 'classic')
        if not _matches_filters(
            template_id,
            template,
            pack=pack,
            tag=tag,
            person=person,
        ):
            continue
        tags = ','.join(template.get('tags', [])[:3])
        source_label = _template_source_label(template)
        rows.append(
            (
                template_id,
                template['name'],
                template_pack,
                len(template['fields']),
                tags,
                source_label,
            )
        )

    if show_source:
        print(f"{'ID':<28} {'Name':<30} {'Pack':<12} {'Fields':<8} {'Source':<16} Tags")
        print('-' * 122)
        for template_id, name, template_pack, field_count, tags, source_label in rows:
            print(
                f'{template_id:<28} {name:<30} {template_pack:<12} {field_count:<8} {source_label:<16} {tags}'
            )
    else:
        print(f"{'ID':<28} {'Name':<30} {'Pack':<12} {'Fields':<8} Tags")
        print('-' * 104)
        for template_id, name, template_pack, field_count, tags, _source_label in rows:
            print(f'{template_id:<28} {name:<30} {template_pack:<12} {field_count:<8} {tags}')
    print(f'\n{len(rows)} curated templates available.')


def search_templates(
    query: str,
    pack: str | None = None,
    *,
    tag: str | None = None,
    person: str | None = None,
    curated_only: bool = False,
    show_source: bool = False,
) -> None:
    curated = load_curated_templates()

    curated_matches: list[tuple[str, MemeTemplate]] = []
    for template_id, template in curated.items():
        if _matches_filters(
            template_id,
            template,
            query=query,
            pack=pack,
            tag=tag,
            person=person,
        ):
            curated_matches.append((template_id, template))

    if curated_matches:
        print('Curated templates')
        if show_source:
            print(
                f"{'ID':<28} {'Pack':<12} {'Fields':<8} {'People':<22} {'Source':<16} Best for"
            )
            print('-' * 138)
        else:
            print(f"{'ID':<28} {'Pack':<12} {'Fields':<8} {'People':<22} Best for")
            print('-' * 120)
        for template_id, template in curated_matches:
            people = ', '.join(template.get('people', [])[:2])
            source_label = _template_source_label(template)
            if show_source:
                print(
                    f"{template_id:<28} {template.get('pack', 'classic'):<12} {len(template['fields']):<8} {people:<22} {source_label:<16} {template['best_for']}"
                )
            else:
                print(
                    f"{template_id:<28} {template.get('pack', 'classic'):<12} {len(template['fields']):<8} {people:<22} {template['best_for']}"
                )

    if curated_only:
        if not curated_matches:
            print(f"No curated templates found matching '{query}'")
        return

    imgflip_matches: list[tuple[str, str, int]] = []
    query_lower = query.lower().strip()
    for meme in fetch_imgflip_templates():
        name = str(meme.get('name', ''))
        if query_lower not in name.lower():
            continue
        box_count_raw = meme.get('box_count', 2)
        box_count = box_count_raw if isinstance(box_count_raw, int) else 2
        imgflip_matches.append((name, str(meme.get('id', '')), box_count))

    if curated_matches and imgflip_matches:
        print()

    if imgflip_matches:
        print('Imgflip templates')
        print(f"{'Name':<40} {'ID':<12} {'Fields':<8}")
        print('-' * 68)
        for name, template_id, field_count in imgflip_matches:
            print(f'{name:<40} {template_id:<12} {field_count:<8}')

    if not curated_matches and not imgflip_matches:
        print(f"No templates found matching '{query}'")
        return

    print(
        f"\n{len(curated_matches)} curated match(es), {len(imgflip_matches)} imgflip match(es). Use the template ID or name as the first argument."
    )


def show_template_info(
    identifier: str,
    *,
    prefer_remote_curated: bool = False,
) -> int:
    template = resolve_template(identifier)
    if template is None:
        print(f"Unknown template: {identifier}", file=sys.stderr)
        return 1

    asset = template.get('asset') or {}
    local_path = asset.get('local_path')
    local_status = 'n/a'
    if local_path:
        local_status = 'present' if _resolve_asset_path(local_path).exists() else 'missing'

    lines = [
        f"id: {template['id']}",
        f"name: {template['name']}",
        f"pack: {template['pack']}",
        f"source: {template['source']}",
        f"fields: {len(template['fields'])}",
        f"best_for: {template['best_for']}",
        f"tags: {', '.join(template['tags']) or '-'}",
        f"people: {', '.join(template['people']) or '-'}",
        f"generator: {template.get('generator') or '-'}",
        f"url: {template.get('url') or '-'}",
        f"asset.local_path: {local_path or '-'}",
        f"asset.local_status: {local_status}",
        f"asset.remote_url: {asset.get('remote_url', '-')}",
        f"asset.source_page: {asset.get('source_page', '-')}",
        f"asset.license: {asset.get('license', '-')}",
        f"asset.attribution: {asset.get('attribution', '-')}",
        f"prefer_remote_curated: {'yes' if prefer_remote_curated else 'no'}",
    ]
    print('\n'.join(lines))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Generate meme images with Pillow.')
    parser.add_argument('--list', action='store_true', help='List curated templates.')
    parser.add_argument('--search', metavar='QUERY', help='Search curated metadata and imgflip names.')
    parser.add_argument('--info', metavar='TEMPLATE', help='Show detailed metadata for a curated template.')
    parser.add_argument('--pack', metavar='PACK', help='Filter curated templates by pack, such as classic.')
    parser.add_argument('--tag', metavar='TAG', help='Filter curated templates by tag.')
    parser.add_argument('--person', metavar='PERSON', help='Filter curated templates by person metadata.')
    parser.add_argument('--show-source', action='store_true', help='Show source strategy in list and search output.')
    parser.add_argument('--curated-only', action='store_true', help='Only search curated templates and skip imgflip.')
    parser.add_argument(
        '--prefer-remote-curated',
        action='store_true',
        help='For curated templates with local-asset metadata, prefer the researched remote image before generated fallback art.',
    )
    parser.add_argument('--image', metavar='PATH', help='Use a custom image instead of a meme template.')
    parser.add_argument('--bars', action='store_true', help='In custom image mode, place the first and last captions in black bars.')
    parser.add_argument('args', nargs='*')
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.info:
        return show_template_info(
            args.info,
            prefer_remote_curated=args.prefer_remote_curated,
        )

    if args.list:
        list_templates(
            pack=args.pack,
            tag=args.tag,
            person=args.person,
            show_source=args.show_source,
        )
        return 0

    if args.search:
        search_templates(
            args.search,
            pack=args.pack,
            tag=args.tag,
            person=args.person,
            curated_only=args.curated_only,
            show_source=args.show_source,
        )
        return 0

    if args.image:
        if len(args.args) < 2:
            print(
                'Usage: generate_meme.py --image <image_path> [--bars] <output_path> <text1> [text2] ...',
                file=sys.stderr,
            )
            return 1
        output_path = args.args[0]
        texts = args.args[1:]
        result = generate_from_image(args.image, texts, output_path, use_bars=args.bars)
        print(f'Meme saved to: {result}')
        return 0

    if len(args.args) < 3:
        print(
            'Usage: generate_meme.py <template_id_or_name> <output_path> <text1> [text2] [text3] [text4]',
            file=sys.stderr,
        )
        print('       generate_meme.py --list [--pack PACK]', file=sys.stderr)
        print('       generate_meme.py --search <query> [--pack PACK] [--curated-only]', file=sys.stderr)
        print(
            '       generate_meme.py --image <path> [--bars] <output_path> <text1> [text2] ...',
            file=sys.stderr,
        )
        return 1

    template_id = args.args[0]
    output_path = args.args[1]
    texts = args.args[2:]
    result = generate_meme(
        template_id,
        texts,
        output_path,
        prefer_remote_curated=args.prefer_remote_curated,
    )
    print(f'Meme saved to: {result}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
