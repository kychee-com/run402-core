create index todos_owner_id_idx on todos(owner_id);
create index comments_todo_id_idx on comments(todo_id);
create function record_todo_insert() returns trigger language plpgsql as $$
begin
  insert into todo_audit(event, todo_id, owner_id) values ('insert', new.id, new.owner_id);
  return new;
end;
$$;
create trigger todos_audit_insert after insert on todos for each row execute function record_todo_insert();
alter table todos enable row level security;
alter table comments enable row level security;
grant select on todos, comments to anon, authenticated, service_role;
grant insert on todos to authenticated, service_role;
grant select, insert on todo_audit to service_role;
grant usage, select on sequence todos_id_seq, comments_id_seq to anon, authenticated, service_role;
create policy todos_owner_read on todos for select using (owner_id = auth.uid());
create policy todos_owner_insert on todos for insert with check (owner_id = auth.uid());
create policy comments_owner_read on comments for select using (exists (select 1 from todos where todos.id = comments.todo_id and todos.owner_id = auth.uid()));
