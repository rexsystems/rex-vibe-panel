CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
 password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('admin','user')) DEFAULT 'user',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, address text NOT NULL,
 token_hash text UNIQUE, last_seen timestamptz, capacity jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS enrollment_tokens (
 token_hash text PRIMARY KEY, node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
 node_id uuid NOT NULL REFERENCES nodes(id), name text NOT NULL, config jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS server_port ON servers(node_id, ((config->>'port')::int));
CREATE TABLE IF NOT EXISTS providers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL, kind text NOT NULL, config jsonb NOT NULL, secret text NOT NULL,
 tested_at timestamptz, tool_capable boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS messages (
 id bigserial PRIMARY KEY, server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 user_id uuid REFERENCES users(id), role text NOT NULL, content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid NOT NULL REFERENCES servers(id),
 user_id uuid NOT NULL REFERENCES users(id), provider_id uuid REFERENCES providers(id) ON DELETE SET NULL,
 prompt text NOT NULL, status text NOT NULL DEFAULT 'queued', cancel_requested boolean NOT NULL DEFAULT false,
 worker_id text, heartbeat_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(server_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS events (
 id bigserial PRIMARY KEY, server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 run_id uuid REFERENCES runs(id), type text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_server_id ON events(server_id, id);
CREATE TABLE IF NOT EXISTS server_locks (
 server_id uuid PRIMARY KEY REFERENCES servers(id), owner text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), node_id uuid NOT NULL REFERENCES nodes(id),
 server_id uuid NOT NULL REFERENCES servers(id), operation jsonb NOT NULL,
 run_id uuid REFERENCES runs(id),
 status text NOT NULL DEFAULT 'pending', result jsonb, error text,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
 created_at timestamptz NOT NULL DEFAULT now()
);
