import { NOTIFICATION_SCHEMA } from '../src/notifications/notification-schema.mjs';

/** Materialize the exact v4 notification tables, preserving fixture rows and previews. */
export function restoreLegacyNotificationSchema(database) {
  const columns = ['id', 'device_id', 'runtime_id', 'session_id', 'request_id', 'kind',
    'approval_id', 'created_at', 'read_at', 'expires_at'];
  const notifications = database.prepare(`SELECT ${columns.join(',')} FROM notifications`).all();
  const outbox = database.prepare('SELECT notification_id, attempts, next_at, encrypted_preview FROM notification_outbox').all();
  database.transaction(() => {
    for (const table of ['notification_client_capabilities', 'agent_notification_receipts', 'notification_outbox', 'notifications']) {
      database.prepare(`DROP TABLE ${table}`).run();
    }
    const schema = NOTIFICATION_SCHEMA.replace(/CREATE TABLE notification_registrations \([\s\S]*?\) STRICT;/u, '');
    for (const sql of schema.split(';').filter(sql => sql.trim())) database.prepare(sql).run();
    database.prepare('ALTER TABLE notification_outbox ADD COLUMN encrypted_preview TEXT').run();
    const insert = database.prepare(`INSERT INTO notifications(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    for (const row of notifications) insert.run(...columns.map(key => row[key]));
    const queue = database.prepare('INSERT INTO notification_outbox VALUES (?, ?, ?, ?)');
    for (const row of outbox) queue.run(row.notification_id, row.attempts, row.next_at, row.encrypted_preview);
  });
}
