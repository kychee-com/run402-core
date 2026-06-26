create sequence todos_id_seq;
create table todos (
  id bigint primary key default nextval('todos_id_seq'),
  owner_id text not null,
  title text not null
);
create sequence comments_id_seq;
create table comments (
  id bigint primary key default nextval('comments_id_seq'),
  todo_id bigint not null references todos(id) on delete cascade,
  body text not null
);
create table todo_audit (
  event text not null,
  todo_id bigint not null,
  owner_id text not null
);
COPY todos FROM '/tmp/run402-should-not-read';
