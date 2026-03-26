#!/usr/bin/env python3
# ruff: noqa: INP001
"""Generate meme images from curated templates, imgflip templates, or custom images."""

from __future__ import annotations

import argparse
import json
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


class MemeTemplate(TypedDict):
    name: str
    best_for: str
    fields: list[TemplateField]
    pack: NotRequired[str]
    aliases: NotRequired[list[str]]
    tags: NotRequired[list[str]]
    people: NotRequired[list[str]]
    url: NotRequired[str]


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
    url: str | None


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
        'url': template.get('url'),
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


def generate_template_art(template: ResolvedTemplate) -> Image.Image:
    url = template.get('url')
    if not url:
        raise RuntimeError(f"Template {template['id']} is missing a remote image URL")
    return get_template_image(url)


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
    image = generate_template_art(template)
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
) -> int:
    template = resolve_template(identifier)
    if template is None:
        print(f"Unknown template: {identifier}", file=sys.stderr)
        return 1

    lines = [
        f"id: {template['id']}",
        f"name: {template['name']}",
        f"pack: {template['pack']}",
        f"source: {template['source']}",
        f"fields: {len(template['fields'])}",
        f"best_for: {template['best_for']}",
        f"tags: {', '.join(template['tags']) or '-'}",
        f"people: {', '.join(template['people']) or '-'}",
        f"url: {template.get('url') or '-'}",
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
    parser.add_argument('--image', metavar='PATH', help='Use a custom image instead of a meme template.')
    parser.add_argument('--bars', action='store_true', help='In custom image mode, place the first and last captions in black bars.')
    parser.add_argument('args', nargs='*')
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.info:
        return show_template_info(args.info)

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
    )
    print(f'Meme saved to: {result}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
