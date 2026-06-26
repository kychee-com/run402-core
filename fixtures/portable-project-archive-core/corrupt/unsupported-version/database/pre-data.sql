create table todos (
  id bigint primary key,
  owner_id text not null,
  title text not null
);
create index todos_owner_id_idx on todos(owner_id);
