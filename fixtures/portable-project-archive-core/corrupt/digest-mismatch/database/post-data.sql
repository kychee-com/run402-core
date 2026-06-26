alter table todos enable row level security;
create policy todos_owner_read on todos for select using (owner_id = auth.uid());
