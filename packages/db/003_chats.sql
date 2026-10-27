CREATE TABLE IF NOT EXISTS chats (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 title text NOT NULL DEFAULT 'New chat',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chats_server_updated ON chats(server_id, updated_at DESC);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_id uuid REFERENCES chats(id) ON DELETE CASCADE;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS chat_id uuid REFERENCES chats(id) ON DELETE CASCADE;

INSERT INTO chats (server_id, user_id, title, created_at, updated_at)
SELECT s.id, s.owner_id, 'Chat', COALESCE((SELECT min(m.created_at) FROM messages m WHERE m.server_id = s.id), now()), now()
FROM servers s
WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.server_id = s.id)
  AND (
    EXISTS (SELECT 1 FROM messages m WHERE m.server_id = s.id)
    OR EXISTS (SELECT 1 FROM runs r WHERE r.server_id = s.id)
  );

UPDATE messages m
SET chat_id = c.id
FROM chats c
WHERE c.server_id = m.server_id AND m.chat_id IS NULL;

UPDATE runs r
SET chat_id = c.id
FROM chats c
WHERE c.server_id = r.server_id AND r.chat_id IS NULL;

DELETE FROM messages WHERE chat_id IS NULL;
DELETE FROM runs WHERE chat_id IS NULL;

ALTER TABLE messages ALTER COLUMN chat_id SET NOT NULL;
ALTER TABLE runs ALTER COLUMN chat_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS messages_chat_id ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS runs_chat_id ON runs(chat_id, created_at DESC);
