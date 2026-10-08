/**
 * Human distillation: turns a consenting person's source material into a
 * coworker agent (persona files plus a work-module skill) with cited claims,
 * reversible F4-versioned merges, and a hard consent gate.
 *
 * Owns the `hybridclaw coworker` CLI and the `/api/admin/distill` console API.
 * Data stays where 0.39.1 wrote it, in the agent workspace (`distill/<alias>/`,
 * `runtime/distill/<run-id>/`), so installing the plugin needs no migration.
 * Audit, revisions and confidential-rule masking are the gateway's own, via
 * the plugin SDK; the agent half of the pipeline is the `human-distill` skill.
 */
import { registerDistillAdminRoutes } from './admin-routes.js';
import { runCoworkerCommand } from './cli.js';

export default {
  id: 'distill',
  register(api) {
    registerDistillAdminRoutes(api);
    api.registerCliCommand({ name: 'coworker', run: runCoworkerCommand });
  },
};
