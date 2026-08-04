-- Ridgewood v0.7.0: server-managed username/password authentication.
-- Run once in Supabase SQL Editor before deploying the v0.7.0 server.

-- Discord-only accounts previously required a Discord identifier. Password
-- accounts use the same game_users table without a Discord identity.
alter table public.game_users
    alter column discord_id drop not null,
    alter column discord_username drop not null;

create table if not exists public.game_password_credentials (
    user_id uuid primary key
        references public.game_users(id) on delete cascade,
    username text not null,
    username_normalized text not null unique,
    password_hash text not null,
    password_salt text not null,
    hash_algorithm text not null default 'scrypt',
    hash_params jsonb not null default '{"n":16384,"r":8,"p":1,"dklen":32}'::jsonb,
    failed_attempts integer not null default 0,
    locked_until timestamptz,
    password_changed_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    check (username = btrim(username)),
    check (char_length(username) between 3 and 24),
    check (username_normalized = lower(username_normalized)),
    check (jsonb_typeof(hash_params) = 'object')
);

create index if not exists game_password_credentials_locked_until_idx
    on public.game_password_credentials(locked_until)
    where locked_until is not null;

alter table public.game_password_credentials enable row level security;
revoke all on public.game_password_credentials from anon, authenticated;

-- Only the trusted Render backend uses the service-role/secret key.
grant select, insert, update, delete
    on public.game_password_credentials to service_role;
