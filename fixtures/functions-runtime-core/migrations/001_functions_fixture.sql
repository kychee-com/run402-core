CREATE TABLE IF NOT EXISTS function_notes (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  body text NOT NULL
);
ALTER TABLE function_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS function_notes_owner_select ON function_notes;
CREATE POLICY function_notes_owner_select ON function_notes
  FOR SELECT TO authenticated
  USING (owner_id::text = auth.uid()::text);

CREATE TABLE IF NOT EXISTS members (
  user_id text PRIMARY KEY,
  role text NOT NULL
);

INSERT INTO function_notes (id, owner_id, body) VALUES
  ('note_admin', 'user_admin', 'Admin private note'),
  ('note_viewer', 'user_viewer', 'Viewer private note')
ON CONFLICT (id) DO UPDATE
SET owner_id = EXCLUDED.owner_id, body = EXCLUDED.body;

INSERT INTO members (user_id, role) VALUES
  ('user_admin', 'admin'),
  ('user_viewer', 'viewer')
ON CONFLICT (user_id) DO UPDATE
SET role = EXCLUDED.role;
