CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'run402_core_authenticator_dev';
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;

CREATE SCHEMA IF NOT EXISTS internal;
GRANT USAGE ON SCHEMA internal TO authenticator, anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.jwt_claim(name text)
RETURNS text AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.' || name, true), ''),
    NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> name, '')
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS text AS $$
  SELECT auth.jwt_claim('sub');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text AS $$
  SELECT auth.jwt_claim('role');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION auth.project_id()
RETURNS text AS $$
  SELECT auth.jwt_claim('project_id');
$$ LANGUAGE sql STABLE;

CREATE SCHEMA IF NOT EXISTS postgrest;
GRANT USAGE ON SCHEMA postgrest TO authenticator;

CREATE OR REPLACE FUNCTION postgrest.pre_config()
RETURNS void AS $$
  SELECT
    set_config(
      'pgrst.db_schemas',
      COALESCE('public,' || string_agg(nspname, ',' ORDER BY nspname), 'public'),
      true
    )
  FROM pg_namespace
  WHERE nspname LIKE 'project_%';
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS internal.runtime_kernel_bootstrap (
  id integer PRIMARY KEY DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO internal.runtime_kernel_bootstrap (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS internal.core_projects (
  project_id text PRIMARY KEY,
  name text NOT NULL,
  schema_slot text NOT NULL UNIQUE,
  public_id text NOT NULL UNIQUE,
  anon_key text NOT NULL,
  service_key text NOT NULL,
  active_release_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS core_projects_created_at_idx
  ON internal.core_projects (created_at);

CREATE TABLE IF NOT EXISTS internal.core_releases (
  project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
  release_id text NOT NULL,
  digest text NOT NULL,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, release_id)
);

CREATE TABLE IF NOT EXISTS internal.core_apply_plans (
  plan_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
  spec jsonb NOT NULL,
  release_spec_digest text NOT NULL,
  base_release_id text,
  target_release_id text NOT NULL,
  target_release_digest text NOT NULL,
  target_release jsonb NOT NULL,
  noop boolean NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'committed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE TABLE IF NOT EXISTS internal.core_applied_migrations (
  project_id text NOT NULL REFERENCES internal.core_projects(project_id) ON DELETE CASCADE,
  migration_id text NOT NULL,
  checksum_hex text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, migration_id)
);
