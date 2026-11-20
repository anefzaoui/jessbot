// Append-only audit trail for security-relevant actions (admin dashboard → logs).
import { run, all } from '../db/index.js';

export function audit(action, { actorId = null, targetType = null, targetId = null, detail = null, ip = null } = {}) {
  run(`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)`,
    actorId, action, targetType, targetId == null ? null : String(targetId), detail ? JSON.stringify(detail) : null, ip);
}

export function recentAudit(limit = 50) {
  return all(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
              ORDER BY a.id DESC LIMIT ?`, limit)
    .map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
