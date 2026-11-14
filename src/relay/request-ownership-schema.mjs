/** Routing identity only. Approval authority and execution state belong to the runtime. */
export const REQUEST_OWNERSHIP_SCHEMA = `
  CREATE TABLE request_ownership (
    runtime_id TEXT NOT NULL CHECK(length(runtime_id) BETWEEN 1 AND 128),
    request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 128),
    subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 320),
    device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),
    status TEXT NOT NULL CHECK(status IN ('open', 'terminal')),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    terminal_at INTEGER,
    PRIMARY KEY(runtime_id, request_id),
    CHECK((status = 'open' AND terminal_at IS NULL)
      OR (status = 'terminal' AND terminal_at IS NOT NULL AND terminal_at >= 0))
  ) STRICT;
  CREATE INDEX request_ownership_session ON request_ownership(runtime_id, session_id);
  CREATE INDEX request_ownership_terminal ON request_ownership(terminal_at) WHERE status = 'terminal';
`;
