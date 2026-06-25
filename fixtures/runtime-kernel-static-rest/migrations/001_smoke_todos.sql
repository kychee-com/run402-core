CREATE TABLE IF NOT EXISTS smoke_todos (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  title text NOT NULL
);
ALTER TABLE smoke_todos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS smoke_todos_owner_select ON smoke_todos;
CREATE POLICY smoke_todos_owner_select ON smoke_todos
  FOR SELECT TO authenticated
  USING (owner_id::text = auth.uid()::text);
INSERT INTO smoke_todos (id, owner_id, title) VALUES
  ('todo_a', 'user_a', 'User A private todo'),
  ('todo_b', 'user_b', 'User B private todo')
ON CONFLICT (id) DO UPDATE
SET owner_id = EXCLUDED.owner_id, title = EXCLUDED.title;
