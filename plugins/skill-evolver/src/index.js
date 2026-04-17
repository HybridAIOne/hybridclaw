import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyVariant } from './apply-variant.js';
import { pluginRoot, runPython, workspaceCacheDir } from './python-bridge.js';
import { findSkill, listAllSkills, loadSkill } from './skill-locator.js';
import { extractTraces, writeTraceDataset } from './trace-extractor.js';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), '..');

function resolveRepoRoot() {
  const envRoot = (process.env.HYBRIDCLAW_REPO_ROOT || '').trim();
  if (envRoot && path.isAbsolute(envRoot) && fs.existsSync(envRoot)) {
    return envRoot;
  }
  return path.resolve(PLUGIN_ROOT, '..', '..');
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[token.slice(2)] = next;
          i += 1;
        } else {
          flags[token.slice(2)] = 'true';
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function flagBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return fallback;
}

function usage() {
  return [
    'skill-evolver commands:',
    '  list                                  List skills ranked by observations',
    '  extract <skill>                       Extract traces to datasets/skills/<skill>/traces.json',
    '  evolve <skill> [--target ...] [...]   Run DSPy + GEPA optimization',
    '  preview <skill> [run-id]              Show diff + scores for a completed run',
    '  show <skill> [run-id]                 Rich-rendered report for a completed run',
    '  watch <skill> [run-id]                Live-refresh a running evolution',
    '  tui                                   Interactive skill browser',
    '',
    'Flags for evolve:',
    '  --target description|body|both        (required — no default)',
    '  --sources synthetic,golden,traces     default: synthetic,golden,traces',
    '  --iterations N                        default: 10',
    '  --open-pr                             push branch + gh pr create',
    '  --dry-run                             resolve config and exit',
  ].join('\n');
}

function resolveSkillOrFail(skillName, repoRoot) {
  const skillPath = findSkill(skillName, repoRoot);
  if (!skillPath) {
    throw new Error(
      `Skill '${skillName}' not found in skills/, community-skills/, or plugins/.`,
    );
  }
  return skillPath;
}

function datasetPathFor(repoRoot, config, skillName, filename) {
  return path.join(repoRoot, config.datasetsDir, skillName, filename);
}

async function handleList(repoRoot) {
  const skills = listAllSkills(repoRoot);

  const rows = skills
    .map((skill) => {
      let observations = [];
      try {
        const { observations: obs } = extractTraces({
          skillName: skill.name,
          repoRoot,
          limit: 500,
          includeOtherSkills: false,
          includeTranscripts: false,
        });
        observations = obs;
      } catch {
        observations = [];
      }
      const failures = observations.filter(
        (o) => o.outcome !== 'success',
      ).length;
      return {
        name: skill.name,
        bodyBytes: skill.bodyBytes,
        observations: observations.length,
        failures,
        failureRate:
          observations.length > 0 ? failures / observations.length : 0,
      };
    })
    .sort((a, b) => {
      if (b.failureRate !== a.failureRate) return b.failureRate - a.failureRate;
      return b.observations - a.observations;
    });

  return {
    ok: true,
    skills: rows,
  };
}

async function handleExtract(skillName, repoRoot, config) {
  const skillPath = resolveSkillOrFail(skillName, repoRoot);
  const skill = loadSkill(skillPath);
  const traces = extractTraces({
    skillName: skill.name,
    repoRoot,
    limit: 1000,
  });
  const outPath = datasetPathFor(repoRoot, config, skill.name, 'traces.json');
  writeTraceDataset(
    {
      skillName: skill.name,
      skillPath: path.relative(repoRoot, skillPath),
      extractedAt: new Date().toISOString(),
      ...traces,
    },
    outPath,
  );
  return {
    ok: true,
    skill: skill.name,
    datasetPath: outPath,
    observationCount: traces.observations.length,
    otherSkillObservationCount: traces.otherSkillObservations.length,
  };
}

async function handleEvolve(skillName, { flags }, repoRoot, config, api) {
  const target = flags.target;
  if (!target || !['description', 'body', 'both'].includes(target)) {
    throw new Error(
      `--target is required and must be one of: description, body, both`,
    );
  }
  const sources = (flags.sources || config.defaultSources)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const iterations = Number.parseInt(
    flags.iterations || config.defaultIterations,
    10,
  );
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error('--iterations must be a positive integer');
  }
  const openPr = flagBool(flags['open-pr'], false);
  const dryRun = flagBool(flags['dry-run'], false);

  const skillPath = resolveSkillOrFail(skillName, repoRoot);
  const skill = loadSkill(skillPath);

  let tracesDatasetPath = null;
  if (sources.includes('traces')) {
    const traces = extractTraces({
      skillName: skill.name,
      repoRoot,
      limit: 1000,
    });
    if (traces.observations.length < config.minTraceObservations) {
      api?.logger?.info(
        {
          skill: skill.name,
          observations: traces.observations.length,
          required: config.minTraceObservations,
        },
        'Not enough trace observations; dropping traces source.',
      );
      const index = sources.indexOf('traces');
      if (index >= 0) sources.splice(index, 1);
    } else {
      tracesDatasetPath = datasetPathFor(
        repoRoot,
        config,
        skill.name,
        'traces.json',
      );
      writeTraceDataset(
        {
          skillName: skill.name,
          skillPath: path.relative(repoRoot, skillPath),
          extractedAt: new Date().toISOString(),
          ...traces,
        },
        tracesDatasetPath,
      );
    }
  }

  const workDir = path.join(workspaceCacheDir(), `${skill.name}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const pythonArgs = [
    'evolve',
    '--skill-path',
    skillPath,
    '--skill-name',
    skill.name,
    '--target',
    target,
    '--iterations',
    String(iterations),
    '--optimizer-model',
    config.optimizerModel,
    '--eval-model',
    config.evalModel,
    '--max-body-bytes',
    String(config.maxSkillBodyBytes),
    '--max-description-chars',
    String(config.maxDescriptionChars),
    '--sources',
    sources.join(','),
    '--work-dir',
    workDir,
    '--repo-root',
    repoRoot,
    '--datasets-dir',
    path.join(repoRoot, config.datasetsDir),
  ];
  if (tracesDatasetPath) {
    pythonArgs.push('--traces-dataset', tracesDatasetPath);
  }
  if (dryRun) {
    pythonArgs.push('--dry-run');
  }

  const pythonResult = await runPython(pythonArgs, {
    onStdoutChunk: (chunk) => {
      api?.logger?.info({ skill: skill.name, chunk }, 'skill-evolver:stdout');
    },
    onStderrChunk: (chunk) => {
      api?.logger?.warn({ skill: skill.name, chunk }, 'skill-evolver:stderr');
    },
  });

  if (pythonResult.code !== 0) {
    return {
      ok: false,
      stage: 'evolve',
      stdout: pythonResult.stdout,
      stderr: pythonResult.stderr,
      exitCode: pythonResult.code,
    };
  }

  const resultPath = path.join(workDir, 'result.json');
  if (!fs.existsSync(resultPath)) {
    return {
      ok: false,
      stage: 'evolve',
      error: 'Python evolver did not produce result.json',
      stdout: pythonResult.stdout,
      stderr: pythonResult.stderr,
    };
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));

  if (dryRun || !result.bestVariantRaw) {
    return {
      ok: true,
      stage: 'dry-run',
      result,
    };
  }

  let applyResult = null;
  try {
    applyResult = applyVariant({
      repoRoot,
      skillPath,
      skillName: skill.name,
      variantRaw: result.bestVariantRaw,
      target,
      testCommand: config.testCommand,
      runTests: config.runTests,
      openPr,
      branchPrefix: config.workBranchPrefix,
      reportMarkdown: result.reportMarkdown || '',
    });
  } catch (err) {
    return {
      ok: false,
      stage: 'apply',
      error: err.message,
      result,
    };
  }

  return {
    ok: true,
    stage: 'applied',
    result,
    apply: applyResult,
  };
}

function resolveRunDir(skillName, runId) {
  const workRoot = workspaceCacheDir();
  if (!fs.existsSync(workRoot)) return null;
  const matches = fs
    .readdirSync(workRoot)
    .filter((d) => d.startsWith(`${skillName}-`))
    .sort()
    .reverse();
  for (const dir of matches) {
    const full = path.join(workRoot, dir);
    const p = path.join(full, 'result.json');
    if (!runId) {
      // Match either a finished (has result.json) run or fall back to most recent dir.
      if (fs.existsSync(p)) {
        return { dir: full, resultPath: p };
      }
      continue;
    }
    if (fs.existsSync(p)) {
      const result = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (result.runId === runId) return { dir: full, resultPath: p, result };
    }
  }
  // Fallback: if runId unset and nothing finished, return newest dir (for watch).
  if (!runId && matches.length > 0) {
    return { dir: path.join(workRoot, matches[0]), resultPath: null };
  }
  return null;
}

async function handlePreview(skillName, runId) {
  const match = resolveRunDir(skillName, runId);
  if (!match || !match.resultPath) {
    return { ok: false, error: `No evolution run found for ${skillName}.` };
  }
  const result = JSON.parse(fs.readFileSync(match.resultPath, 'utf-8'));
  return { ok: true, result, dir: match.dir };
}

async function handleShow(skillName, runId) {
  const match = resolveRunDir(skillName, runId);
  if (!match || !match.resultPath) {
    return { ok: false, error: `No evolution run found for ${skillName}.` };
  }
  const result = await runPython(['show', match.resultPath], {
    stdio: 'inherit',
  });
  return { ok: result.code === 0, exitCode: result.code };
}

async function handleWatch(skillName, runId) {
  const match = resolveRunDir(skillName, runId);
  if (!match) {
    return { ok: false, error: `No evolution run dir found for ${skillName}.` };
  }
  const result = await runPython(['watch', match.dir], { stdio: 'inherit' });
  return { ok: result.code === 0, exitCode: result.code };
}

async function handleTui(repoRoot, config) {
  const datasets = path.join(repoRoot, config.datasetsDir);
  const result = await runPython(
    ['tui', '--repo-root', repoRoot, '--datasets-dir', datasets],
    { stdio: 'inherit' },
  );
  return { ok: result.code === 0, exitCode: result.code };
}

function resolveConfig(api) {
  const raw = api?.pluginConfig || {};
  return {
    optimizerModel: raw.optimizerModel || 'openai/gpt-4.1',
    evalModel: raw.evalModel || 'openai/gpt-4.1-mini',
    maxSkillBodyBytes: Number(raw.maxSkillBodyBytes || 15360),
    maxDescriptionChars: Number(raw.maxDescriptionChars || 1024),
    defaultIterations: Number(raw.defaultIterations || 10),
    defaultSources: raw.defaultSources || 'synthetic,golden,traces',
    minTraceObservations: Number(raw.minTraceObservations || 10),
    datasetsDir: raw.datasetsDir || 'datasets/skills',
    workBranchPrefix: raw.workBranchPrefix || 'evolve/skill',
    runTests: raw.runTests !== false,
    testCommand: raw.testCommand || 'npm test --silent',
  };
}

async function dispatch(args, context, api) {
  const parsed = parseArgs(args);
  const [subcommand, ...rest] = parsed.positional;
  const repoRoot = context?.workspacePath || resolveRepoRoot();
  const config = resolveConfig(api);

  if (!subcommand || subcommand === 'help' || parsed.flags.help) {
    return { ok: true, usage: usage() };
  }

  switch (subcommand) {
    case 'list':
      return handleList(repoRoot);
    case 'extract': {
      const skillName = rest[0];
      if (!skillName) throw new Error('extract requires a <skill> argument');
      return handleExtract(skillName, repoRoot, config);
    }
    case 'evolve': {
      const skillName = rest[0];
      if (!skillName) throw new Error('evolve requires a <skill> argument');
      return handleEvolve(
        skillName,
        { flags: parsed.flags },
        repoRoot,
        config,
        api,
      );
    }
    case 'preview': {
      const [skillName, runId] = rest;
      if (!skillName) throw new Error('preview requires a <skill> argument');
      return handlePreview(skillName, runId);
    }
    case 'show': {
      const [skillName, runId] = rest;
      if (!skillName) throw new Error('show requires a <skill> argument');
      return handleShow(skillName, runId);
    }
    case 'watch': {
      const [skillName, runId] = rest;
      if (!skillName) throw new Error('watch requires a <skill> argument');
      return handleWatch(skillName, runId);
    }
    case 'tui':
      return handleTui(repoRoot, config);
    default:
      throw new Error(`Unknown subcommand: ${subcommand}\n\n${usage()}`);
  }
}

export default {
  id: 'skill-evolver',
  kind: 'tool',
  register(api) {
    api.registerCommand({
      name: 'skill-evolver',
      description:
        'Evolve SKILL.md descriptions and bodies via DSPy + GEPA (subcommands: list, extract, evolve, preview)',
      handler: async (args, context) => dispatch(args, context, api),
    });

    api.registerTool({
      name: 'skill_evolver_list',
      description:
        'List skills ranked by observation counts and failure rates, to identify candidates for evolution.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => handleList(resolveRepoRoot()),
    });

    api.registerTool({
      name: 'skill_evolver_extract',
      description:
        'Extract trace-based evaluation data for a skill from the HybridClaw database and session transcripts.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'Skill name (directory name or frontmatter name:).',
          },
        },
        required: ['skill'],
        additionalProperties: false,
      },
      handler: async ({ skill }) =>
        handleExtract(skill, resolveRepoRoot(), resolveConfig(api)),
    });

    api.logger?.info(
      { pluginRoot: pluginRoot() },
      'skill-evolver plugin registered',
    );
  },
};
