/**
 * Models may record reasons only during the execution that produced them.
 * Retrieval requires the verified turn user and agent, never a model-supplied owner.
 * Models cannot write completion, delivery, or seen receipts.
 */
import type { ToolErrorCode } from '@hybridclaw/contracts/tool-error-code';
import { SILENT_REPLY_TOKEN } from '../agent/silent-reply.js';
import { getSessionById } from '../memory/db.js';
import { currentTurnUser } from '../session/turn-user.js';
import { isRecord } from '../utils/type-guards.js';
import {
  listWork,
  readWork,
  updateWork,
  type WorkRecord,
} from './work-store.js';

const active = new Map<string, Set<string>>();
export function beginWork(session: string, id: string): () => void {
  const runs = active.get(session) ?? new Set<string>();
  runs.add(id);
  active.set(session, runs);
  return () => {
    runs.delete(id);
    if (!runs.size) active.delete(session);
  };
}
/** Only a live gateway execution can say a run is active. */
export function isWorkActive(id: string): boolean {
  return [...active.values()].some((runs) => runs.has(id));
}
/** The scheduled run working in `session` right now, when exactly one is. */
export function currentWork(session: string): WorkRecord | null {
  const runs = active.get(session);
  return runs?.size === 1 ? readWork([...runs][0]) : null;
}
export function runWorkTool(body: unknown): {
  ok: boolean;
  result?: string;
  error?: string;
  errorCode?: ToolErrorCode;
} {
  try {
    if (!isRecord(body) || typeof body.sessionId !== 'string')
      throw new Error('Expected a session.');
    const owner = currentTurnUser(body.sessionId)?.userId;
    const current = currentWork(body.sessionId);
    const agent = current?.agentId ?? getSessionById(body.sessionId)?.agent_id;
    if (!owner || !agent) throw new Error('No verified user for this turn.');
    if (body.action === 'list')
      return {
        ok: true,
        result: JSON.stringify(
          listWork(agent, owner).map((work) => ({
            id: work.id,
            startedAt: work.startedAt,
            taskId: work.taskId,
            rationale: work.rationale?.slice(0, 240) ?? null,
          })),
        ),
      };
    if (body.action === 'get') {
      const work = typeof body.id === 'string' ? readWork(body.id) : null;
      if (!work || work.owner !== owner || work.agentId !== agent)
        throw new Error('Work not found.');
      return { ok: true, result: JSON.stringify(work) };
    }
    if (body.action !== 'record')
      throw new Error('Expected record, get or list.');
    if (
      !current ||
      current.owner !== owner ||
      current.completedAt ||
      current.failedAt
    )
      throw new Error('No active background work.');
    if (
      typeof body.rationale !== 'string' ||
      !body.rationale.trim() ||
      body.rationale.length > 4000
    )
      throw new Error('Expected a reason of 1–4000 characters.');
    if (
      !Array.isArray(body.evidence) ||
      body.evidence.length > 20 ||
      !body.evidence.every(
        (item) =>
          isRecord(item) &&
          typeof item.reference === 'string' &&
          item.reference.trim() &&
          item.reference.length <= 2000 &&
          typeof item.summary === 'string' &&
          item.summary.trim() &&
          item.summary.length <= 2000,
      )
    )
      throw new Error('Expected up to 20 evidence references and summaries.');
    const rationale = body.rationale.trim();
    const evidence = body.evidence as { reference: string; summary: string }[];
    // The first reason is immutable; later calls cannot rewrite why this run acted.
    if (current.rationale !== null)
      return {
        ok: false,
        error: 'The reason is already recorded. Retrieve it with get.',
        errorCode: 'ALREADY_EXISTS',
      };
    updateWork(current.id, (work) => {
      work.rationale = rationale;
      work.evidence = evidence.map(({ reference, summary }) => ({
        reference,
        summary,
      }));
    });
    return {
      ok: true,
      result: JSON.stringify({ id: current.id, recorded: true }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not read work.',
    };
  }
}
export function workPrompt(prompt: string, noticeEvidence = false): string {
  const evidenceRule = noticeEvidence
    ? 'Record work only after verifying a reportable new event in this run. Put the evidence for that event first. ' +
      'For email use mail:<provider>:<account-id>:<immutable-message-id> as the reference. Use the same lowercase ' +
      'provider and stable mailbox identity across watches (the primary address if the connector uses that as its identity). ' +
      'Use the immutable ID returned by the source, not a thread ID, subject, folder or date. Use the original mail ' +
      'as the primary evidence when other findings merely add context. For a non-mail event use event:<source-reference>. ' +
      `Never guess a missing reference. If nothing qualifies, leave the work unrecorded and return only ${SILENT_REPLY_TOKEN}.`
    : 'If no evidence is available, record an empty evidence list and state the gap in the reason.';
  return `${prompt}\n\nBefore suggesting or preparing something, use work(record) to save the concrete reason and the supporting evidence you actually read (source identifiers or URLs plus a short factual summary). Do this before taking the action. One work id links this run, its action receipts, prepared files, chat reply and alert. Do not invent evidence. ${evidenceRule} When asked why a suggestion was made, use work(get) or work(list) and explain the recorded reason; say when it was not recorded. A completed run, a saved reply, an attempted notification, transport acceptance and the user seeing it are separate facts.`;
}
