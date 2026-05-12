#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const APPLY_FLAG = '--apply';

function usage() {
  console.log(`Usage: node scripts/backfill-usage-costs.mjs [--apply]

Backfills zero-cost usage_events rows for HybridAI and xAI models using the
currently discovered model pricing. Defaults to dry-run mode. Use --apply to
create a SQLite backup and update the live database.`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  return {
    apply: argv.includes(APPLY_FLAG),
  };
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const { getRuntimeConfig } = await import('../dist/config/runtime-config.js');
  const { refreshModelCatalogMetadata } = await import(
    '../dist/providers/model-catalog.js'
  );
  const { estimateModelUsageCostUsd } = await import(
    '../dist/usage/model-cost.js'
  );

  const dbPath = getRuntimeConfig().ops?.dbPath;
  if (!dbPath) {
    throw new Error('Runtime config does not define ops.dbPath.');
  }

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT
           id,
           model,
           input_tokens AS inputTokens,
           output_tokens AS outputTokens
         FROM usage_events
         WHERE cost_usd = 0
           AND (input_tokens > 0 OR output_tokens > 0)
           AND (model LIKE 'hybridai/%' OR model LIKE 'xai/%')`,
      )
      .all();

    const uniqueModels = [...new Set(rows.map((row) => row.model))];
    for (const model of uniqueModels) {
      await refreshModelCatalogMetadata(model);
    }

    const updates = [];
    const missingPricing = new Map();
    const byModel = new Map();
    for (const row of rows) {
      const costUsd = estimateModelUsageCostUsd({
        model: row.model,
        promptTokens: row.inputTokens,
        completionTokens: row.outputTokens,
      });
      if (costUsd == null) {
        missingPricing.set(row.model, (missingPricing.get(row.model) || 0) + 1);
        continue;
      }
      updates.push({ id: row.id, model: row.model, costUsd });
      const aggregate = byModel.get(row.model) || { rows: 0, costUsd: 0 };
      aggregate.rows += 1;
      aggregate.costUsd += costUsd;
      byModel.set(row.model, aggregate);
    }

    const totalCostUsd = updates.reduce((sum, row) => sum + row.costUsd, 0);
    const summary = {
      mode: apply ? 'apply' : 'dry-run',
      dbPath,
      candidateRows: rows.length,
      updatableRows: updates.length,
      estimatedBackfillCostUsd: Number(totalCostUsd.toFixed(12)),
      byModel: [...byModel.entries()]
        .map(([model, value]) => ({
          model,
          rows: value.rows,
          costUsd: Number(value.costUsd.toFixed(12)),
        }))
        .sort((left, right) => right.costUsd - left.costUsd),
      missingPricing: [...missingPricing.entries()].map(
        ([model, rowCount]) => ({
          model,
          rows: rowCount,
        }),
      ),
    };

    console.log(JSON.stringify(summary, null, 2));

    if (!apply || updates.length === 0) return;

    const backupPath = path.join(
      path.dirname(dbPath),
      `hybridclaw.usage-cost-backfill.${timestampForFilename()}.db`,
    );
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    await db.backup(backupPath);

    const update = db.prepare(
      `UPDATE usage_events SET cost_usd = ? WHERE id = ? AND cost_usd = 0`,
    );
    const applyUpdates = db.transaction((rowsToUpdate) => {
      for (const row of rowsToUpdate) {
        update.run(row.costUsd, row.id);
      }
    });
    applyUpdates(updates);

    console.log(
      JSON.stringify(
        {
          appliedRows: updates.length,
          appliedCostUsd: Number(totalCostUsd.toFixed(12)),
          backupPath,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
