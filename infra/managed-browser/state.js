import fs from 'node:fs';
import path from 'node:path';

export function appendAuditLine(auditPath, event) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(
    auditPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
    'utf-8',
  );
}

export function loadLostLeases({ statePath, auditPath, nodeId }) {
  const lostLeases = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (!Array.isArray(parsed.leases)) return lostLeases;
    for (const lease of parsed.leases) {
      if (!lease?.leaseId || !lease?.tenantId) continue;
      lostLeases.push(lease);
      appendAuditLine(auditPath, {
        type: 'browser.session_lost',
        tenantId: lease.tenantId,
        agentId: lease.agentId,
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        nodeId,
        reason: 'pool restarted before lease release',
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return lostLeases;
}
