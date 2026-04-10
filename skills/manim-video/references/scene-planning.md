# Scene Planning

Use this reference when the user knows the topic but not the structure of the animation yet.

## Planning Order

1. Define the teaching objective in one sentence.
2. Identify the viewer's likely confusion or misconception.
3. Decide the single "aha" transition the animation must land.
4. Pick the narrative arc: setup -> mechanism -> payoff -> recap.
5. Break the story into 2-5 scenes with one dominant idea each.
6. Pick one palette, one font family, and one timing vocabulary for the whole script.
7. Decide where subtitles are mandatory and where silence is visually clearer.

## Questions To Answer In `plan.md`

- Who is the audience: beginner, intermediate, or expert?
- What misconception or hard idea does the animation resolve?
- What is the narrative arc from opening confusion to final takeaway?
- Which objects must move, morph, or be highlighted?
- Which parts are better shown geometrically before symbols appear?
- Which scenes need narration, subtitle text, or no text at all?
- What artifact is expected: draft scene clips, a stitched MP4, or only the script?
- Which beats need spoken narration, subtitle text, or no words at all?

## Per-Scene Requirements

For each scene, capture:

- the dominant idea
- target duration
- dominant color
- layout choice
- entry animation
- text budget
- subtitle or narration beat
- exit condition

## Shared Constants To Decide Up Front

Before coding, lock these once for the whole project:

- `BG`, `PRIMARY`, `SECONDARY`, `ACCENT`, `HIGHLIGHT`, `SUBTLE`
- `MONO`
- title, body, label, and caption sizes
- reveal and exit timing constants
- opacity bands for primary, context, and structure

## Good Scene Shape

Each scene should have:

- one clear claim
- one main visual focus
- one dominant color from the shared palette
- one layout that differs from at least one neighboring scene
- a clean entry
- a short pause after the key reveal
- a clean exit before the next scene starts
- a text budget that fits the chosen layout

## Scene Template

```md
## Scene2CoreConcept

- Goal: show why the midpoint test removes half the search space
- Duration: 10-14 seconds
- Dominant color: PRIMARY
- Layout: LEFT_RIGHT
- Entry animation: Create number line, then FadeIn labels
- Visual hook: a highlighted interval on a number line
- Key motion: shrink the interval after each comparison
- On-screen text: short labels only
- Text budget: title plus at most 2 small labels at once
- Narration or subtitle: "Each comparison cuts the remaining candidates in half."
- Exit condition: leave only the final candidate interval on screen
```

## Pacing Guidance

- Intro/title scene: 5-8 seconds
- Core concept scene: 8-20 seconds
- Dense derivation scene: split into multiple shorter scenes instead of one long block
- Final recap: 4-8 seconds
- Give the main reveal the longest pause in the scene.

## Beat Timing Table

| Beat | Animation time | Pause after |
|------|----------------|-------------|
| Intro title | `1.2-1.8s` | `0.8-1.2s` |
| Supporting label | `0.6-1.0s` | `0.3-0.6s` |
| Core mechanism reveal | `1.5-2.2s` | `1.5-2.5s` |
| Aha transition | `2.0-2.8s` | `2.0-3.0s` |
| Scene exit | `0.4-0.7s` | `0.2-0.4s` |

## Variation Audit

Before coding, check that adjacent scenes do not all share the same:

- dominant color
- layout
- entry animation
- pacing

The video should feel cohesive, not repetitive.

## Text Budget Heuristics

- `FULL_CENTER`: title plus one subtitle or one note
- `LEFT_RIGHT`: one text block per side, optional small caption
- `TOP_BOTTOM`: headline plus one supporting block below
- `GRID`: prefer labels over paragraphs

If a scene needs 3 or more centered text blocks, the layout is wrong or the scene should be split.

## Failure Modes

- Too much text on screen at once
- Three or more centered text blocks stacked vertically
- Dense scenes keeping large body text instead of shrinking to `20-24`
- Scene order that starts with formulas before intuition
- Different palettes or font scales per scene
- Every scene using the same centered layout and same entry animation
- Trying to teach multiple new ideas in one clip
- No pause after the main reveal
