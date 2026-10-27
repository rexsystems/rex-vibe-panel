CREATE TABLE IF NOT EXISTS node_setup_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 node_id uuid NOT NULL REFERENCES nodes(id),
 owner_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'starting',
 message text NOT NULL DEFAULT 'Preparing the local node.',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_local_node_setup ON node_setup_jobs ((true))
 WHERE status NOT IN ('complete','failed');
