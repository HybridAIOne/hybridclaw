import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import {
  resolveWorkspacePath,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';

export type DiagramAction = 'create' | 'update' | 'validate';
export type DiagramFormat = 'mermaid' | 'plantuml' | 'graphviz' | 'excalidraw';
export type DiagramRenderTarget = 'svg' | 'png' | 'pdf' | 'none';
export type MermaidDiagramType =
  | 'sequence'
  | 'flowchart'
  | 'state'
  | 'er'
  | 'class'
  | 'gantt'
  | 'git-graph'
  | 'mindmap'
  | 'pie';
export type DiagramType = MermaidDiagramType | 'auto';

interface DiagramArtifact {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'source' | 'rendered';
}

interface DiagramValidation {
  valid: boolean;
  errors: string[];
  suggested_fix?: string;
}

interface NormalizedDiagramRequest {
  description: string;
  instructions: string;
  type: MermaidDiagramType;
  requestedType: DiagramType;
  format: DiagramFormat;
  renderTo: DiagramRenderTarget;
  source: string;
  warnings: string[];
}

const OUTPUT_DIR = '.generated-diagrams';
const EXTERNAL_RENDER_TIMEOUT_MS = 60_000;
const PLANTUML_FETCH_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);
const SOURCE_EXTENSIONS: Record<DiagramFormat, string> = {
  mermaid: '.mmd',
  plantuml: '.puml',
  graphviz: '.dot',
  excalidraw: '.excalidraw.json',
};
const SOURCE_MIME_TYPES: Record<DiagramFormat, string> = {
  mermaid: 'text/vnd.mermaid',
  plantuml: 'text/vnd.plantuml',
  graphviz: 'text/vnd.graphviz',
  excalidraw: 'application/vnd.excalidraw+json',
};
const RENDER_MIME_TYPES: Record<
  Exclude<DiagramRenderTarget, 'none'>,
  string
> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  pdf: 'application/pdf',
};

const MERMAID_HEADERS: Record<MermaidDiagramType, RegExp> = {
  sequence: /^sequenceDiagram\b/i,
  flowchart: /^(flowchart|graph)\b/i,
  state: /^stateDiagram(?:-v2)?\b/i,
  er: /^erDiagram\b/i,
  class: /^classDiagram\b/i,
  gantt: /^gantt\b/i,
  'git-graph': /^gitGraph\b/i,
  mindmap: /^mindmap\b/i,
  pie: /^pie\b/i,
};

function readStringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readSourceValue(args: Record<string, unknown>): string {
  return readStringValue(args.source);
}

function normalizeFormat(value: unknown): DiagramFormat {
  const raw = readStringValue(value).toLowerCase();
  if (
    raw === 'plantuml' ||
    raw === 'graphviz' ||
    raw === 'excalidraw' ||
    raw === 'mermaid'
  ) {
    return raw;
  }
  return 'mermaid';
}

function normalizeRenderTarget(
  value: unknown,
  format: DiagramFormat,
): DiagramRenderTarget {
  const raw = readStringValue(value).toLowerCase();
  if (raw === 'png' || raw === 'pdf' || raw === 'none') return raw;
  if (raw === 'svg') return 'svg';
  return format === 'excalidraw' ? 'none' : 'svg';
}

function normalizeDiagramType(value: unknown, description = ''): DiagramType {
  const raw = readStringValue(value).toLowerCase().replace(/_/g, '-');
  if (
    raw === 'sequence' ||
    raw === 'flowchart' ||
    raw === 'state' ||
    raw === 'er' ||
    raw === 'class' ||
    raw === 'gantt' ||
    raw === 'git-graph' ||
    raw === 'mindmap' ||
    raw === 'pie'
  ) {
    return raw;
  }
  if (raw === 'auto' || !raw) return 'auto';
  return classifyDiagramType(description);
}

export function classifyDiagramType(description: string): MermaidDiagramType {
  const text = description.toLowerCase();
  if (
    /\b(sequence|message|call flow|handoff|conversation|request.*response|lifeline|actor)\b/.test(
      text,
    )
  ) {
    return 'sequence';
  }
  if (
    /\b(gantt|timeline|milestone|sprint|schedule|roadmap|deadline)\b/.test(text)
  ) {
    return 'gantt';
  }
  if (
    /\b(entity|relationship|erd|database schema|foreign key|table)\b/.test(text)
  ) {
    return 'er';
  }
  if (/\b(class|interface|inherit|method|property|uml class)\b/.test(text)) {
    return 'class';
  }
  if (/\b(state|fsm|lifecycle|transition|status machine)\b/.test(text)) {
    return 'state';
  }
  if (/\b(git|branch|commit|merge|rebase|release train)\b/.test(text)) {
    return 'git-graph';
  }
  if (/\b(mind ?map|brainstorm|taxonomy|concept map|outline)\b/.test(text)) {
    return 'mindmap';
  }
  if (/\b(pie|share|percentage|proportion|breakdown|split)\b/.test(text)) {
    return 'pie';
  }
  return 'flowchart';
}

function stripFence(source: string): string {
  const trimmed = source.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  return (match?.[1] || trimmed).trim();
}

function firstMeaningfulLine(source: string): string {
  return (
    stripFence(source)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('%%')) || ''
  );
}

function inferMermaidType(source: string): MermaidDiagramType | null {
  const first = firstMeaningfulLine(source);
  for (const [type, pattern] of Object.entries(MERMAID_HEADERS)) {
    if (pattern.test(first)) return type as MermaidDiagramType;
  }
  return null;
}

function hasBalancedDelimiters(source: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  for (const char of source) {
    if ((char === '"' || char === "'") && !escaped) {
      quote = quote === char ? null : quote || char;
      continue;
    }
    escaped = char === '\\' && !escaped;
    if (quote) continue;
    escaped = false;
    if (char === '(' || char === '[' || char === '{') stack.push(char);
    if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== pairs[char]) return false;
    }
  }
  return stack.length === 0 && quote === null;
}

function validateMermaid(
  source: string,
  type: MermaidDiagramType,
): DiagramValidation {
  const body = stripFence(source);
  const errors: string[] = [];
  const first = firstMeaningfulLine(body);
  if (!body) errors.push('Mermaid source is empty.');
  if (!MERMAID_HEADERS[type].test(first)) {
    errors.push(
      `Expected Mermaid ${type} source to start with the ${type} diagram header.`,
    );
  }
  const delimiterSource =
    type === 'er'
      ? body.replace(/[|o}]\{/g, 'oo').replace(/\}[|o]/g, 'oo')
      : body;
  if (!hasBalancedDelimiters(delimiterSource)) {
    errors.push(
      'Source has unbalanced brackets, braces, parentheses, or quotes.',
    );
  }

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'));
  const rest = lines.slice(1).join('\n');
  if (
    type === 'sequence' &&
    !/(?:-{1,2}|={1,2})>>?|participant\b|actor\b/i.test(rest)
  ) {
    errors.push(
      'Sequence diagrams need at least one participant/actor or message arrow.',
    );
  }
  if (type === 'flowchart' && !/(-->|---|==>|-.->|\bo--|\bx--)/.test(rest)) {
    errors.push('Flowcharts need at least one edge such as A --> B.');
  }
  if (type === 'state' && !/-->/.test(rest)) {
    errors.push('State diagrams need at least one transition using -->.');
  }
  if (
    type === 'er' &&
    !(/(?:\|\||\}\||\}o|o\{|o\|)--/.test(rest) || /\w+\s*\{/.test(rest))
  ) {
    errors.push(
      'ER diagrams need an entity block or relationship cardinality.',
    );
  }
  if (type === 'class' && !/\bclass\s+\w+|<\|--|--\*|--o/.test(rest)) {
    errors.push(
      'Class diagrams need at least one class declaration or relationship.',
    );
  }
  if (
    type === 'gantt' &&
    !(/\bdateFormat\b/i.test(rest) && /:\s*\w*,/.test(rest))
  ) {
    errors.push('Gantt diagrams need a dateFormat and at least one task line.');
  }
  if (
    type === 'git-graph' &&
    !/\b(commit|branch|checkout|merge)\b/i.test(rest)
  ) {
    errors.push(
      'Git graphs need at least one commit, branch, checkout, or merge statement.',
    );
  }
  if (type === 'mindmap' && !/\n\s+\S/.test(body)) {
    errors.push('Mindmaps need indented child nodes below the root.');
  }
  if (type === 'pie' && !/"?[^"\n:]+"?\s*:\s*\d+(?:\.\d+)?/.test(rest)) {
    errors.push('Pie charts need at least one "Label" : number entry.');
  }

  return {
    valid: errors.length === 0,
    errors,
    ...(errors.length > 0 ? { suggested_fix: buildMermaidSkeleton(type) } : {}),
  };
}

function validatePlantUml(source: string): DiagramValidation {
  const body = stripFence(source);
  const errors: string[] = [];
  if (!/^@startuml\b/im.test(body))
    errors.push('PlantUML source must include @startuml.');
  if (!/^@enduml\b/im.test(body))
    errors.push('PlantUML source must include @enduml.');
  return { valid: errors.length === 0, errors };
}

function validateGraphviz(source: string): DiagramValidation {
  const body = stripFence(source);
  const errors: string[] = [];
  if (!/^\s*(strict\s+)?(di)?graph\b/i.test(body)) {
    errors.push('Graphviz source must start with graph or digraph.');
  }
  if (!hasBalancedDelimiters(body))
    errors.push('Graphviz source has unbalanced delimiters.');
  if (!/->|--/.test(body))
    errors.push('Graphviz source should include at least one edge.');
  return { valid: errors.length === 0, errors };
}

function validateExcalidraw(source: string): DiagramValidation {
  const errors: string[] = [];
  try {
    const parsed = JSON.parse(stripFence(source)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('Excalidraw source must be a JSON object.');
    } else {
      const record = parsed as Record<string, unknown>;
      if (record.type !== 'excalidraw')
        errors.push('Excalidraw JSON must set type to "excalidraw".');
      if (!Array.isArray(record.elements))
        errors.push('Excalidraw JSON must include an elements array.');
    }
  } catch (err) {
    errors.push(
      `Excalidraw source is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { valid: errors.length === 0, errors };
}

function validateDiagramSource(
  source: string,
  format: DiagramFormat,
  type: MermaidDiagramType,
): DiagramValidation {
  if (format === 'plantuml') return validatePlantUml(source);
  if (format === 'graphviz') return validateGraphviz(source);
  if (format === 'excalidraw') return validateExcalidraw(source);
  return validateMermaid(source, type);
}

function safeLabel(value: string, fallback: string): string {
  const words = value
    .replace(/[`"'<>[\]{}|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');
  return words || fallback;
}

function buildMermaidSkeleton(
  type: MermaidDiagramType,
  description = '',
): string {
  const label = safeLabel(description, 'Diagram');
  switch (type) {
    case 'sequence':
      return `sequenceDiagram\n  participant User\n  participant System\n  User->>System: ${label}\n  System-->>User: Result`;
    case 'state':
      return `stateDiagram-v2\n  [*] --> Requested\n  Requested --> Processing: ${label}\n  Processing --> Done\n  Done --> [*]`;
    case 'er':
      return `erDiagram\n  USER ||--o{ TASK : owns\n  TASK {\n    string id\n    string title\n  }`;
    case 'class':
      return `classDiagram\n  class Request {\n    +string id\n    +run()\n  }\n  class Handler\n  Request --> Handler`;
    case 'gantt':
      return `gantt\n  title ${label}\n  dateFormat  YYYY-MM-DD\n  section Plan\n  Draft :a1, 2026-01-01, 2d\n  Review :after a1, 1d`;
    case 'git-graph':
      return 'gitGraph\n  commit id: "start"\n  branch feature\n  checkout feature\n  commit id: "work"\n  checkout main\n  merge feature';
    case 'mindmap':
      return `mindmap\n  root((${label}))\n    Context\n    Decision\n    Outcome`;
    case 'pie':
      return `pie title ${label}\n  "Primary" : 60\n  "Secondary" : 25\n  "Other" : 15`;
    case 'flowchart':
      return `flowchart TD\n  A[${label}] --> B{Ready?}\n  B -->|Yes| C[Deliver]\n  B -->|No| D[Revise]\n  D --> B`;
  }
}

function buildPlantUmlSource(
  type: MermaidDiagramType,
  description: string,
): string {
  const label = safeLabel(description, 'Diagram');
  if (type === 'sequence') {
    return `@startuml\nactor User\nparticipant System\nUser -> System: ${label}\nSystem --> User: Result\n@enduml`;
  }
  return `@startuml\ncomponent "Client" as Client\ncomponent "Service" as Service\ndatabase "Store" as Store\nClient --> Service : ${label}\nService --> Store : read/write\n@enduml`;
}

function buildGraphvizSource(description: string): string {
  const label = safeLabel(description, 'Diagram');
  return `digraph G {\n  rankdir=LR;\n  node [shape=box, style=rounded];\n  start [label="${label}"];\n  process [label="Process"];\n  done [label="Done"];\n  start -> process;\n  process -> done;\n}`;
}

function buildExcalidrawSource(description: string): string {
  const label = safeLabel(description, 'Diagram');
  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'hybridclaw',
      elements: [
        {
          id: 'diagram-label',
          type: 'text',
          x: 120,
          y: 120,
          width: 360,
          height: 32,
          text: label,
          originalText: label,
          fontSize: 24,
          fontFamily: 1,
          strokeColor: '#1e1e1e',
        },
      ],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    },
    null,
    2,
  );
}

function buildSource(
  format: DiagramFormat,
  type: MermaidDiagramType,
  description: string,
): string {
  if (format === 'plantuml') return buildPlantUmlSource(type, description);
  if (format === 'graphviz') return buildGraphvizSource(description);
  if (format === 'excalidraw') return buildExcalidrawSource(description);
  return buildMermaidSkeleton(type, description);
}

function loadArtifactSource(ref: string): string | null {
  const resolved = resolveWorkspacePath(ref);
  if (
    !resolved ||
    !fs.existsSync(resolved) ||
    !fs.statSync(resolved).isFile()
  ) {
    return null;
  }
  return fs.readFileSync(resolved, 'utf-8');
}

function annotatePlantUml(source: string, note: string): string {
  return source.replace(
    /@enduml\s*$/i,
    `note as UpdateNote\n  ${note}\nend note\n@enduml`,
  );
}

function annotateGraphviz(source: string, note: string): string {
  return source.replace(/\}\s*$/, `  update [label="${note}"];\n}`);
}

function annotateExcalidraw(source: string, note: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripFence(source)) as Record<string, unknown>;
  } catch {
    return source;
  }
  const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
  parsed.elements = [
    ...elements,
    {
      id: `update-${randomUUID().slice(0, 8)}`,
      type: 'text',
      x: 120,
      y: 240,
      width: 360,
      height: 24,
      text: note,
      originalText: note,
      fontSize: 18,
      fontFamily: 1,
      strokeColor: '#1e1e1e',
    },
  ];
  return JSON.stringify(parsed, null, 2);
}

function annotateMermaid(
  source: string,
  type: MermaidDiagramType,
  note: string,
): string {
  if (type === 'sequence') return `${source}\n  %% Update: ${note}`;
  if (type === 'mindmap') return `${source}\n    ${note}`;
  if (type === 'pie') return `${source}\n  "${note}" : 1`;
  if (type === 'gantt') return `${source}\n  ${note} : 1d`;
  if (type === 'git-graph') return `${source}\n  commit id: "${note}"`;
  return `${source}\n  %% Update: ${note}`;
}

function appendInstructionAnnotation(
  source: string,
  format: DiagramFormat,
  type: MermaidDiagramType,
  instructions: string,
): string {
  const note = safeLabel(instructions, 'Updated');
  if (!instructions) return source;
  if (format === 'plantuml') return annotatePlantUml(source, note);
  if (format === 'graphviz') return annotateGraphviz(source, note);
  if (format === 'excalidraw') return annotateExcalidraw(source, note);
  return annotateMermaid(source, type, note);
}

function readArtifactRef(args: Record<string, unknown>): string {
  return readStringValue(args.artifact_ref);
}

function resolveLoadedSource(
  sourceFromArgs: string,
  artifactRef: string,
): string {
  if (sourceFromArgs) return sourceFromArgs;
  if (!artifactRef) return '';
  const loaded = loadArtifactSource(artifactRef);
  if (loaded === null) {
    throw new Error(`artifact_ref not found or unreadable: ${artifactRef}`);
  }
  return loaded;
}

function resolveRequestType(params: {
  requestedType: DiagramType;
  format: DiagramFormat;
  source: string;
  description: string;
}): { type: MermaidDiagramType; sourceType: MermaidDiagramType | null } {
  const inferredType =
    params.format === 'mermaid' && params.source
      ? inferMermaidType(params.source)
      : null;
  if (params.requestedType === 'auto') {
    return {
      type:
        inferredType ||
        classifyDiagramType(params.description || params.source),
      sourceType: inferredType,
    };
  }
  return { type: params.requestedType, sourceType: inferredType };
}

function buildTypeOverrideWarning(
  format: DiagramFormat,
  source: string,
  type: MermaidDiagramType,
  sourceType: MermaidDiagramType | null,
): { type: MermaidDiagramType; warning: string | null } {
  if (format !== 'mermaid') return { type, warning: null };
  const resolvedSourceType = sourceType || inferMermaidType(source);
  if (!resolvedSourceType || resolvedSourceType === type) {
    return { type, warning: null };
  }
  return {
    type: resolvedSourceType,
    warning: `type "${type}" was overridden by Mermaid source header "${resolvedSourceType}".`,
  };
}

function normalizeRequest(
  args: Record<string, unknown>,
  action: DiagramAction,
): NormalizedDiagramRequest {
  const description = readStringValue(args.description);
  const instructions = readStringValue(args.instructions);
  const format = normalizeFormat(args.format);
  const sourceFromArgs = readSourceValue(args);
  const artifactRef = readArtifactRef(args);
  const loadedSource = resolveLoadedSource(sourceFromArgs, artifactRef);
  const requestedType = normalizeDiagramType(
    args.type,
    description || loadedSource,
  );
  const resolvedType = resolveRequestType({
    requestedType,
    format,
    source: loadedSource,
    description,
  });
  let type = resolvedType.type;
  const renderTo = normalizeRenderTarget(
    args.render_to ?? args.renderTo,
    format,
  );
  const warnings: string[] = [];
  let source = loadedSource || buildSource(format, type, description);
  if (action === 'update') {
    if (!source)
      throw new Error('diagram.update requires source or artifact_ref.');
    if (!sourceFromArgs && instructions) {
      source = appendInstructionAnnotation(source, format, type, instructions);
    }
  }
  const generatedSource = !loadedSource && source;
  const sourceType =
    generatedSource && format === 'mermaid'
      ? inferMermaidType(source)
      : resolvedType.sourceType;
  const override = buildTypeOverrideWarning(format, source, type, sourceType);
  type = override.type;
  if (override.warning) warnings.push(override.warning);
  return {
    description,
    instructions,
    type,
    requestedType,
    format,
    renderTo,
    source,
    warnings,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSourceSvg(source: string, title: string): Buffer {
  const lines = stripFence(source).split(/\r?\n/).slice(0, 28);
  const lineHeight = 22;
  const width = 960;
  const height = Math.max(260, 88 + lines.length * lineHeight);
  const text = lines
    .map(
      (line, index) =>
        `<text x="32" y="${92 + index * lineHeight}" font-family="Menlo, Consolas, monospace" font-size="14" fill="#1f2937">${escapeHtml(line)}</text>`,
    )
    .join('\n');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="8" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="32" y="56" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#0f172a">${escapeHtml(title)}</text>
  ${text}
</svg>`,
    'utf-8',
  );
}

interface ExternalRenderResult {
  data: Buffer | null;
  unavailable: boolean;
  detail: string;
}

async function runExternalRenderer(
  command: string,
  args: string[],
  inputPath: string,
  outputPath: string,
): Promise<ExternalRenderResult> {
  try {
    await execFileAsync(command, args, {
      cwd: path.dirname(inputPath),
      encoding: 'utf-8',
      timeout: EXTERNAL_RENDER_TIMEOUT_MS,
    });
  } catch (err) {
    const nodeError = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    return {
      data: null,
      unavailable: nodeError.code === 'ENOENT',
      detail:
        [nodeError.stderr, nodeError.stdout]
          .filter(Boolean)
          .join('\n')
          .trim() || nodeError.message,
    };
  }
  if (!fs.existsSync(outputPath)) {
    return {
      data: null,
      unavailable: false,
      detail: `${command} completed without creating ${path.basename(outputPath)}`,
    };
  }
  return {
    data: fs.readFileSync(outputPath),
    unavailable: false,
    detail: '',
  };
}

async function renderWithExternalCommand(params: {
  source: string;
  target: Exclude<DiagramRenderTarget, 'none'>;
  tempPrefix: string;
  inputExtension: string;
  command: string;
  args: (inputPath: string, outputPath: string) => string[];
  rendererName: string;
  fallbackLabel: string;
  missingMessage: string;
}): Promise<{ data: Buffer; warnings: string[] }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), params.tempPrefix));
  try {
    const inputPath = path.join(tempDir, `diagram.${params.inputExtension}`);
    const outputPath = path.join(tempDir, `diagram.${params.target}`);
    fs.writeFileSync(inputPath, stripFence(params.source), 'utf-8');
    const rendered = await runExternalRenderer(
      params.command,
      params.args(inputPath, outputPath),
      inputPath,
      outputPath,
    );
    if (rendered.data) return { data: rendered.data, warnings: [] };
    if (rendered.unavailable && params.target === 'svg') {
      return {
        data: renderSourceSvg(params.source, params.fallbackLabel),
        warnings: [
          `${params.rendererName} was unavailable; emitted source-backed SVG fallback.`,
        ],
      };
    }
    if (!rendered.unavailable) {
      throw new Error(
        `${params.rendererName} renderer failed: ${rendered.detail}`,
      );
    }
    throw new Error(params.missingMessage);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function renderMermaid(
  source: string,
  target: Exclude<DiagramRenderTarget, 'none'>,
): Promise<{ data: Buffer; warnings: string[] }> {
  return renderWithExternalCommand({
    source,
    target,
    tempPrefix: 'hybridclaw-diagram-',
    inputExtension: 'mmd',
    command: 'mmdc',
    args: (inputPath, outputPath) => [
      '-i',
      inputPath,
      '-o',
      outputPath,
      '--quiet',
      '-b',
      'transparent',
    ],
    rendererName: 'mmdc',
    fallbackLabel: 'Mermaid diagram source',
    missingMessage: `Mermaid ${target} rendering requires mmdc.`,
  });
}

function renderGraphviz(
  source: string,
  target: Exclude<DiagramRenderTarget, 'none'>,
): Promise<{ data: Buffer; warnings: string[] }> {
  return renderWithExternalCommand({
    source,
    target,
    tempPrefix: 'hybridclaw-dot-',
    inputExtension: 'dot',
    command: 'dot',
    args: (inputPath, outputPath) => [
      `-T${target}`,
      inputPath,
      '-o',
      outputPath,
    ],
    rendererName: 'Graphviz dot',
    fallbackLabel: 'Graphviz DOT source',
    missingMessage: `Graphviz ${target} rendering requires the dot binary.`,
  });
}

const PLANTUML_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

function encodePlantUml(source: string): string {
  const compressed = deflateRawSync(Buffer.from(stripFence(source), 'utf-8'));
  let encoded = '';
  for (let index = 0; index < compressed.length; index += 3) {
    const b1 = compressed[index] ?? 0;
    const b2 = compressed[index + 1] ?? 0;
    const b3 = compressed[index + 2] ?? 0;
    encoded += PLANTUML_ALPHABET[b1 >> 2];
    encoded += PLANTUML_ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)];
    encoded += PLANTUML_ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)];
    encoded += PLANTUML_ALPHABET[b3 & 0x3f];
  }
  return encoded;
}

async function renderPlantUml(
  source: string,
  target: Exclude<DiagramRenderTarget, 'none'>,
): Promise<{ data: Buffer; warnings: string[] }> {
  if (target !== 'svg' && target !== 'png') {
    throw new Error('PlantUML rendering supports svg or png.');
  }
  const baseUrl =
    readStringValue(process.env.HYBRIDCLAW_PLANTUML_SERVER_URL) ||
    readStringValue(process.env.PLANTUML_SERVER_URL);
  if (!baseUrl) {
    if (target === 'svg') {
      return {
        data: renderSourceSvg(source, 'PlantUML source'),
        warnings: [
          'No PlantUML server configured; emitted source-backed SVG fallback.',
        ],
      };
    }
    throw new Error(
      'PlantUML rendering requires HYBRIDCLAW_PLANTUML_SERVER_URL or PLANTUML_SERVER_URL.',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLANTUML_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/${target}/${encodePlantUml(source)}`,
      { signal: controller.signal },
    );
    if (!response.ok)
      throw new Error(`PlantUML server returned ${response.status}.`);
    return { data: Buffer.from(await response.arrayBuffer()), warnings: [] };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        `PlantUML server request timed out after ${PLANTUML_FETCH_TIMEOUT_MS}ms.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function renderDiagram(
  request: NormalizedDiagramRequest,
): Promise<{ data: Buffer; warnings: string[] }> {
  if (request.renderTo === 'none')
    return { data: Buffer.alloc(0), warnings: [] };
  const renderTo = request.renderTo;
  if (request.format === 'mermaid')
    return renderMermaid(request.source, renderTo);
  if (request.format === 'graphviz')
    return renderGraphviz(request.source, renderTo);
  if (request.format === 'plantuml')
    return renderPlantUml(request.source, renderTo);
  if (renderTo === 'svg') {
    return {
      data: renderSourceSvg(request.source, 'Excalidraw JSON source'),
      warnings: [
        'Excalidraw headless rendering is not configured; emitted source-backed SVG fallback.',
      ],
    };
  }
  throw new Error(
    'Excalidraw render_to supports none or svg in the built-in adapter.',
  );
}

function persistBuffer(
  buffer: Buffer,
  extension: string,
  mimeType: string,
  kind: DiagramArtifact['kind'],
): DiagramArtifact {
  const outputRoot = path.join(WORKSPACE_ROOT, OUTPUT_DIR);
  fs.mkdirSync(outputRoot, { recursive: true });
  const filename = `diagram-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
  const hostPath = path.join(outputRoot, filename);
  fs.writeFileSync(hostPath, buffer);
  return {
    path: `${WORKSPACE_ROOT_DISPLAY}/${OUTPUT_DIR}/${filename}`,
    filename,
    mimeType,
    sizeBytes: buffer.length,
    kind,
  };
}

export async function runDiagramTool(
  action: DiagramAction,
  args: Record<string, unknown>,
): Promise<string> {
  const request = normalizeRequest(args, action);
  const validation = validateDiagramSource(
    request.source,
    request.format,
    request.type,
  );

  if (action === 'validate') {
    return JSON.stringify(
      {
        success: true,
        valid: validation.valid,
        errors: validation.errors,
        suggested_fix: validation.suggested_fix,
        type: request.type,
        format: request.format,
      },
      null,
      2,
    );
  }

  const sourceArtifact = persistBuffer(
    Buffer.from(stripFence(request.source), 'utf-8'),
    SOURCE_EXTENSIONS[request.format],
    SOURCE_MIME_TYPES[request.format],
    'source',
  );

  if (!validation.valid) {
    return JSON.stringify(
      {
        success: false,
        valid: false,
        errors: validation.errors,
        suggested_fix: validation.suggested_fix,
        source: request.source,
        source_artifact_ref: sourceArtifact.path,
        source_artifact_valid: false,
        type: request.type,
        format: request.format,
        warnings: [
          ...request.warnings,
          'Source artifact was saved for debugging but did not validate.',
        ],
      },
      null,
      2,
    );
  }

  const artifacts: DiagramArtifact[] = [sourceArtifact];
  let renderedArtifact: DiagramArtifact | null = null;
  const renderWarnings: string[] = [];
  if (request.renderTo !== 'none') {
    const rendered = await renderDiagram(request);
    renderWarnings.push(...rendered.warnings);
    renderedArtifact = persistBuffer(
      rendered.data,
      `.${request.renderTo}`,
      RENDER_MIME_TYPES[request.renderTo],
      'rendered',
    );
    artifacts.push(renderedArtifact);
  }

  return JSON.stringify(
    {
      success: true,
      valid: true,
      source: stripFence(request.source),
      source_artifact_ref: sourceArtifact.path,
      rendered_artifact_ref: renderedArtifact?.path || null,
      type: request.type,
      requested_type: request.requestedType,
      format: request.format,
      render_to: request.renderTo,
      artifacts,
      warnings: [...request.warnings, ...renderWarnings],
      usage: { renders: request.renderTo === 'none' ? 0 : 1, llm_tokens: 0 },
      stakes: { f8: 'low', reason: 'operator-controlled file artifact' },
    },
    null,
    2,
  );
}
