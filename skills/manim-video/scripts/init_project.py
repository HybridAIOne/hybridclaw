#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from textwrap import dedent


DEFAULT_SCENES = ['Introduction', 'Core Concept', 'Wrap Up']


def to_scene_class(raw_name: str, index: int) -> str:
    parts = re.findall(r'[A-Za-z0-9]+', raw_name)
    suffix = ''.join(part[:1].upper() + part[1:] for part in parts) or f'Section{index}'
    if suffix and suffix[0].isdigit():
        suffix = f'Section{suffix}'
    return f'Scene{index}{suffix}'


def build_plan(title: str, scene_specs: list[tuple[str, str]]) -> str:
    lines = [
        f'# {title}',
        '',
        '## Goal',
        '',
        '- Audience:',
        '- Teaching objective:',
        '- Aha moment:',
        '- Requested output:',
        '',
        '## Visual System',
        '',
        '- Background:',
        '- Primary color:',
        '- Secondary color:',
        '- Accent color:',
        '- Typography:',
        '- Tempo:',
        '',
        '## Scene Order',
        '',
        ' -> '.join(scene_name for _, scene_name in scene_specs),
    ]

    for scene_title, scene_name in scene_specs:
        lines.extend(
            [
                '',
                f'## {scene_name}',
                '',
                f'- Human label: {scene_title}',
                '- Goal:',
                '- Visual hook:',
                '- Key motion:',
                '- On-screen text:',
                '- Narration or subtitle:',
                '- Exit condition:',
            ]
        )

    return '\n'.join(lines) + '\n'


def build_script(title: str, scene_specs: list[tuple[str, str]]) -> str:
    class_blocks: list[str] = []
    for index, (scene_title, scene_name) in enumerate(scene_specs, start=1):
        title_text = title if index == 1 else scene_title
        class_blocks.append(
            dedent(
                f'''
                class {scene_name}(Scene):
                    def construct(self) -> None:
                        self.camera.background_color = BG

                        title = Text(
                            "{title_text}",
                            font_size=48,
                            color=PRIMARY,
                            weight=BOLD,
                        )
                        subtitle = Text(
                            "TODO: replace with the key visual claim for this scene.",
                            font_size=26,
                            color=SECONDARY,
                        )
                        group = VGroup(title, subtitle).arrange(DOWN, buff=0.35)

                        self.play(Write(title), run_time=1.2)
                        self.wait(0.5)
                        self.play(FadeIn(subtitle, shift=UP * 0.2), run_time=0.8)
                        self.wait(1.0)
                        self.play(FadeOut(group), run_time=0.5)
                '''
            ).strip()
        )

    return (
        dedent(
            '''
            from manim import *

            BG = "#0F172A"
            PRIMARY = "#38BDF8"
            SECONDARY = "#F8FAFC"
            ACCENT = "#F59E0B"
            '''
        ).strip()
        + '\n\n'
        + '\n\n\n'.join(class_blocks)
        + '\n'
    )


def build_concat(scene_classes: list[str], quality_dir: str) -> str:
    return '\n'.join(
        f"file 'media/videos/script/{quality_dir}/{scene_name}.mp4'"
        for scene_name in scene_classes
    ) + '\n'


def write_text(path: Path, content: str, *, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f'{path} already exists')
    path.write_text(content, encoding='utf-8')


def main() -> int:
    parser = argparse.ArgumentParser(description='Initialize a Manim video project')
    parser.add_argument('project_dir', help='Directory to create or update')
    parser.add_argument('--title', help='Project title shown in plan.md and scene 1')
    parser.add_argument(
        '--scene',
        action='append',
        dest='scenes',
        help='Human-readable scene name. Repeat to add multiple scenes.',
    )
    parser.add_argument(
        '--quality-dir',
        default='480p15',
        help='Media quality directory used in concat.txt',
    )
    parser.add_argument(
        '--force',
        action='store_true',
        help='Overwrite plan.md, script.py, and concat.txt if they already exist',
    )
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    title = args.title or project_dir.name.replace('-', ' ').replace('_', ' ').title()
    raw_scenes = args.scenes or DEFAULT_SCENES
    scene_classes = [to_scene_class(name, index) for index, name in enumerate(raw_scenes, start=1)]
    scene_specs = list(zip(raw_scenes, scene_classes))

    project_dir.mkdir(parents=True, exist_ok=True)

    write_text(project_dir / 'plan.md', build_plan(title, scene_specs), force=args.force)
    write_text(project_dir / 'script.py', build_script(title, scene_specs), force=args.force)
    write_text(
        project_dir / 'concat.txt',
        build_concat(scene_classes, args.quality_dir),
        force=args.force,
    )

    payload = {
        'project_dir': str(project_dir),
        'title': title,
        'scene_classes': scene_classes,
        'files': [
            str(project_dir / 'plan.md'),
            str(project_dir / 'script.py'),
            str(project_dir / 'concat.txt'),
        ],
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
