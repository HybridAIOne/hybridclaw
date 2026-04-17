import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (status ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout || '').trim();
}

function runShell(cmd, cwd) {
  const command = String(cmd || '').trim();
  if (!command) throw new Error('Empty shell command');
  const result = spawnSync(command, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
    shell: true,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function computeSlug(skillName) {
  return (
    String(skillName)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  );
}

export function applyVariant(options) {
  const {
    repoRoot,
    skillPath,
    skillName,
    variantRaw,
    target,
    testCommand,
    runTests = true,
    openPr = false,
    branchPrefix = 'evolve/skill',
    reportMarkdown = '',
  } = options;

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill path does not exist: ${skillPath}`);
  }

  const baselineStatus = runGit(['status', '--porcelain'], repoRoot);
  if (baselineStatus) {
    throw new Error(
      `Working tree is not clean. Commit or stash changes before applying a variant.\n${baselineStatus}`,
    );
  }

  const baselineBranch = runGit(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoRoot,
  );
  const slug = computeSlug(skillName);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branchName = `${branchPrefix}/${slug}-${target}-${stamp}`;

  runGit(['checkout', '-b', branchName], repoRoot);

  fs.writeFileSync(skillPath, variantRaw, 'utf-8');
  const relPath = path.relative(repoRoot, skillPath);

  let testResult = { skipped: true };
  if (runTests) {
    const result = runShell(testCommand, repoRoot);
    testResult = result;
    if (result.status !== 0) {
      runGit(['checkout', '--', relPath], repoRoot);
      runGit(['checkout', baselineBranch], repoRoot);
      runGit(['branch', '-D', branchName], repoRoot);
      throw new Error(
        `Variant rejected: test command \`${testCommand}\` failed.\nstdout: ${result.stdout.slice(-800)}\nstderr: ${result.stderr.slice(-800)}`,
      );
    }
  }

  runGit(['add', relPath], repoRoot);
  const commitMessage = `chore(skills): evolve ${skillName} (${target})\n\nAutomated evolution via skill-evolver plugin (DSPy + GEPA).`;
  runGit(['commit', '-m', commitMessage], repoRoot);

  let prUrl = null;
  if (openPr) {
    const ghCheck = runShell('gh --version', repoRoot);
    if (ghCheck.status === 0) {
      runGit(['push', '-u', 'origin', branchName], repoRoot);
      const prBody =
        reportMarkdown ||
        `Automated evolution of \`${skillName}\` (${target}) via skill-evolver plugin.`;
      const pr = spawnSync(
        'gh',
        [
          'pr',
          'create',
          '--title',
          `evolve(${skillName}): ${target}`,
          '--body',
          prBody,
        ],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      if (pr.status === 0) {
        prUrl = (pr.stdout || '').trim();
      }
    }
  }

  return {
    branchName,
    baselineBranch,
    testResult,
    prUrl,
    commitMessage,
  };
}
