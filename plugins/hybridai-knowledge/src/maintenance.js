const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds until the next `hourUtc` boundary after `now`. */
export function msUntilNextRun(now, hourUtc) {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setTime(next.getTime() + DAY_MS);
  return next.getTime() - now.getTime();
}

/** The maintenance turn: the llm-wiki lint workflow against one collection. */
export function buildMaintenancePrompt({ collection }) {
  const target = collection
    ? `the knowledge collection \`${collection}\``
    : 'the first company knowledge collection that knowledge_list returns';
  return [
    '[knowledge maintenance] Scheduled wiki maintenance, no user is waiting.',
    `Maintain ${target} on the HybridAI platform with the knowledge tools only;`,
    'follow the llm-wiki skill in its platform collection mode.',
    '',
    '1. Orient: read index.md and log.md of the collection.',
    '2. Find what needs work: pages that duplicate each other, pages no other',
    '   page links to, pages whose cited raw/ sources are newer than the page,',
    '   contradictions between pages, and raw/ sources that no sources/ page',
    '   summarises yet (knowledge_list shows the sources).',
    '3. Fix what you can with knowledge_write: merge duplicates, add links,',
    '   update pages from their sources, write the missing sources/ pages, and',
    '   mark open contradictions in the affected pages. Give every write a',
    '   one-line reason and overwrite only with the content_hash you read.',
    '4. Keep the pass small: at most twelve writes; leave the rest for the next run.',
    '',
    'Reply with a short report: pages written, pages merged, open questions.',
    'If nothing needed work, reply with one line saying so.',
  ].join('\n');
}

/**
 * Runs the maintenance turn once through the gateway's own agent turn path,
 * on a session of its own, so it leaves no trace in the user's chats.
 */
export async function runMaintenance({ api, config, now = new Date() }) {
  const agentId = config.maintenance.agentId || api.getDefaultAgentId();
  const prompt = buildMaintenancePrompt({
    collection: config.maintenance.collection,
  });
  const started = Date.now();
  const result = await api.dispatchInboundMessage({
    sessionId: `knowledge-maintenance:${agentId}`,
    sessionMode: 'resume',
    guildId: null,
    channelId: 'knowledge-maintenance',
    userId: 'knowledge-maintenance',
    username: 'Knowledge maintenance',
    content: prompt,
    agentId,
  });
  const text = typeof result?.result === 'string' ? result.result : '';
  api.logger.info(
    {
      agentId,
      collection: config.maintenance.collection || null,
      durationMs: Date.now() - started,
      ranAt: now.toISOString(),
      reportChars: text.length,
    },
    'Knowledge maintenance turn completed',
  );
  return text;
}

/** Schedules the daily run; returns a stop function. */
export function startMaintenanceSchedule({
  api,
  config,
  run = runMaintenance,
  now = () => new Date(),
}) {
  let timer = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const delay = msUntilNextRun(now(), config.maintenance.hourUtc);
    timer = setTimeout(async () => {
      try {
        await run({ api, config, now: now() });
      } catch (error) {
        api.logger.warn({ error }, 'Knowledge maintenance turn failed');
      } finally {
        arm();
      }
    }, delay);
    timer.unref?.();
    api.logger.info(
      { hourUtc: config.maintenance.hourUtc, inMs: delay },
      'Knowledge maintenance scheduled',
    );
  };
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
