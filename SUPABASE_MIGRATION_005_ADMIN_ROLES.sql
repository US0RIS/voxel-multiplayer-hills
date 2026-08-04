-- Ridgewood v0.8.0: staff roles, account bans, and admin build override.
-- Run once in the Supabase SQL Editor before deploying the v0.8.0 server.
--
-- This migration is written to be re-runnable: every statement is guarded, so
-- running it twice is harmless.

-- ---------------------------------------------------------------- roles/bans

alter table public.game_users
    add column if not exists role text not null default 'player',
    add column if not exists banned_until timestamptz,
    add column if not exists ban_reason text,
    add column if not exists banned_at timestamptz,
    add column if not exists banned_by uuid;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'game_users_role_check'
    ) then
        alter table public.game_users
            add constraint game_users_role_check
            check (role in ('player', 'moderator', 'admin'));
    end if;

    if not exists (
        select 1 from pg_constraint where conname = 'game_users_banned_by_fkey'
    ) then
        alter table public.game_users
            add constraint game_users_banned_by_fkey
            foreign key (banned_by) references public.game_users(id) on delete set null;
    end if;
end
$$;

create index if not exists game_users_role_idx
    on public.game_users(role)
    where role <> 'player';

create index if not exists game_users_banned_until_idx
    on public.game_users(banned_until)
    where banned_until is not null;

create index if not exists game_users_display_name_lower_idx
    on public.game_users(lower(display_name));

-- --------------------------------------------------------------- audit trail

create table if not exists public.admin_actions (
    id bigserial primary key,
    actor_id uuid references public.game_users(id) on delete set null,
    actor_name text,
    action text not null,
    target_id uuid references public.game_users(id) on delete set null,
    target_name text,
    detail jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists admin_actions_created_at_idx
    on public.admin_actions(created_at desc);

create index if not exists admin_actions_target_idx
    on public.admin_actions(target_id, created_at desc);

alter table public.admin_actions enable row level security;
revoke all on public.admin_actions from anon, authenticated;
revoke all on sequence public.admin_actions_id_seq from anon, authenticated;
grant select, insert on public.admin_actions to service_role;
grant usage, select on sequence public.admin_actions_id_seq to service_role;

-- ------------------------------------------------------- staff role helper

create or replace function public.is_staff_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(
        (select role in ('moderator', 'admin') from public.game_users where id = p_user_id),
        false
    );
$$;

revoke all on function public.is_staff_user(uuid) from public, anon, authenticated;
grant execute on function public.is_staff_user(uuid) to service_role;

-- ------------------------------------------------ voxel edits with override
--
-- The v0.6.0 signature took eight arguments. v0.8.0 adds p_admin_override so
-- staff can edit chunks they do not own, including chunks nobody has claimed.
-- The override is only honoured when the caller is actually staff, so a forged
-- flag from a modified client cannot bypass ownership.

drop function if exists public.apply_voxel_edit(text, uuid, integer, integer, text, jsonb, jsonb, uuid);

create or replace function public.apply_voxel_edit(
    p_world_id text,
    p_user_id uuid,
    p_chunk_x integer,
    p_chunk_z integer,
    p_action text,
    p_voxel_pos jsonb,
    p_block_data jsonb,
    p_client_action_id uuid,
    p_admin_override boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_chunk public.chunks%rowtype;
    v_key text;
    v_existing_log bigint;
    v_is_staff boolean;
    v_override boolean;
    v_actor_name text;
begin
    if p_action not in ('place', 'remove') then
        return jsonb_build_object('ok', false, 'error', 'invalid_action');
    end if;

    if p_voxel_pos is null
       or not (p_voxel_pos ? 'x')
       or not (p_voxel_pos ? 'y')
       or not (p_voxel_pos ? 'z') then
        return jsonb_build_object('ok', false, 'error', 'invalid_voxel_position');
    end if;

    select id into v_existing_log
    from public.building_log
    where client_action_id = p_client_action_id;

    if found then
        select * into v_chunk
        from public.chunks
        where world_id = p_world_id
          and chunk_x = p_chunk_x
          and chunk_z = p_chunk_z;
        return jsonb_build_object(
            'ok', true,
            'duplicate', true,
            'chunk', to_jsonb(v_chunk),
            'clientActionId', p_client_action_id
        );
    end if;

    select role in ('moderator', 'admin'), display_name
        into v_is_staff, v_actor_name
    from public.game_users
    where id = p_user_id;

    v_override := coalesce(p_admin_override, false) and coalesce(v_is_staff, false);

    perform pg_advisory_xact_lock(
        hashtextextended(p_world_id || ':' || p_chunk_x::text || ':' || p_chunk_z::text, 0)
    );

    select * into v_chunk
    from public.chunks
    where world_id = p_world_id
      and chunk_x = p_chunk_x
      and chunk_z = p_chunk_z
    for update;

    if not found then
        if not v_override then
            return jsonb_build_object('ok', false, 'error', 'chunk_not_claimed');
        end if;
        -- Staff may build on open land. The chunk row is created unowned so the
        -- land stays claimable by an ordinary player afterwards.
        insert into public.chunks (world_id, chunk_x, chunk_z, owner_id, voxel_data, revision, updated_at)
        values (p_world_id, p_chunk_x, p_chunk_z, null, '{}'::jsonb, 0, now())
        on conflict (world_id, chunk_x, chunk_z) do nothing;

        select * into v_chunk
        from public.chunks
        where world_id = p_world_id
          and chunk_x = p_chunk_x
          and chunk_z = p_chunk_z
        for update;

        if not found then
            return jsonb_build_object('ok', false, 'error', 'chunk_not_claimed');
        end if;
    end if;

    if v_chunk.owner_id is distinct from p_user_id and not v_override then
        return jsonb_build_object(
            'ok', false,
            'error', 'not_owner',
            'ownerId', v_chunk.owner_id
        );
    end if;

    v_key := (p_voxel_pos->>'x') || ':' || (p_voxel_pos->>'y') || ':' || (p_voxel_pos->>'z');

    if p_action = 'place' then
        update public.chunks
        set voxel_data = jsonb_set(
                coalesce(voxel_data, '{}'::jsonb),
                array[v_key],
                jsonb_build_object(
                    'action', 'place',
                    'block', coalesce(p_block_data, '{}'::jsonb)
                ),
                true
            ),
            revision = revision + 1,
            updated_at = now()
        where world_id = p_world_id
          and chunk_x = p_chunk_x
          and chunk_z = p_chunk_z
        returning * into v_chunk;
    else
        update public.chunks
        set voxel_data = jsonb_set(
                coalesce(voxel_data, '{}'::jsonb),
                array[v_key],
                jsonb_build_object('action', 'remove'),
                true
            ),
            revision = revision + 1,
            updated_at = now()
        where world_id = p_world_id
          and chunk_x = p_chunk_x
          and chunk_z = p_chunk_z
        returning * into v_chunk;
    end if;

    insert into public.building_log (
        world_id, user_id, chunk_x, chunk_z, action,
        voxel_pos, block_data, client_action_id, timestamp
    ) values (
        p_world_id, p_user_id, p_chunk_x, p_chunk_z, p_action,
        p_voxel_pos, p_block_data, p_client_action_id, now()
    );

    -- Every override is recorded so building inside someone else's claim is
    -- always attributable after the fact.
    if v_override and v_chunk.owner_id is distinct from p_user_id then
        insert into public.admin_actions (actor_id, actor_name, action, target_id, detail)
        values (
            p_user_id, v_actor_name, 'build_override', v_chunk.owner_id,
            jsonb_build_object(
                'worldId', p_world_id,
                'chunkX', p_chunk_x,
                'chunkZ', p_chunk_z,
                'voxel', p_voxel_pos,
                'voxelAction', p_action
            )
        );
    end if;

    return jsonb_build_object(
        'ok', true,
        'duplicate', false,
        'adminOverride', v_override,
        'clientActionId', p_client_action_id,
        'edit', jsonb_build_object(
            'action', p_action,
            'chunkX', p_chunk_x,
            'chunkZ', p_chunk_z,
            'localX', (p_voxel_pos->>'x')::integer,
            'y', (p_voxel_pos->>'y')::integer,
            'localZ', (p_voxel_pos->>'z')::integer,
            'block', p_block_data,
            'revision', v_chunk.revision
        ),
        'chunk', to_jsonb(v_chunk)
    );
end;
$$;

revoke all on function public.apply_voxel_edit(text, uuid, integer, integer, text, jsonb, jsonb, uuid, boolean)
    from public, anon, authenticated;

grant execute on function public.apply_voxel_edit(text, uuid, integer, integer, text, jsonb, jsonb, uuid, boolean)
    to service_role;

-- -------------------------------------------------- admin chunk reassignment
--
-- Lets staff release a claim or transfer it to another player without touching
-- the ordinary claim limits. Passing null for p_owner_id releases the chunk.

create or replace function public.admin_set_chunk_owner(
    p_world_id text,
    p_chunk_x integer,
    p_chunk_z integer,
    p_owner_id uuid,
    p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_chunk public.chunks%rowtype;
    v_actor_name text;
    v_previous uuid;
begin
    select display_name into v_actor_name from public.game_users where id = p_actor_id;

    if not public.is_staff_user(p_actor_id) then
        return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;

    if p_owner_id is not null
       and not exists (select 1 from public.game_users where id = p_owner_id) then
        return jsonb_build_object('ok', false, 'error', 'unknown_owner');
    end if;

    perform pg_advisory_xact_lock(
        hashtextextended(p_world_id || ':' || p_chunk_x::text || ':' || p_chunk_z::text, 0)
    );

    select * into v_chunk
    from public.chunks
    where world_id = p_world_id and chunk_x = p_chunk_x and chunk_z = p_chunk_z
    for update;

    v_previous := v_chunk.owner_id;

    if not found then
        insert into public.chunks (world_id, chunk_x, chunk_z, owner_id, claimed_at, voxel_data, revision, updated_at)
        values (
            p_world_id, p_chunk_x, p_chunk_z, p_owner_id,
            case when p_owner_id is null then null else now() end,
            '{}'::jsonb, 0, now()
        )
        returning * into v_chunk;
    else
        update public.chunks
        set owner_id = p_owner_id,
            claimed_at = case when p_owner_id is null then null else now() end,
            updated_at = now()
        where world_id = p_world_id and chunk_x = p_chunk_x and chunk_z = p_chunk_z
        returning * into v_chunk;
    end if;

    insert into public.admin_actions (actor_id, actor_name, action, target_id, detail)
    values (
        p_actor_id, v_actor_name, 'set_chunk_owner', p_owner_id,
        jsonb_build_object(
            'worldId', p_world_id,
            'chunkX', p_chunk_x,
            'chunkZ', p_chunk_z,
            'previousOwnerId', v_previous
        )
    );

    return jsonb_build_object('ok', true, 'chunk', to_jsonb(v_chunk), 'previousOwnerId', v_previous);
end;
$$;

revoke all on function public.admin_set_chunk_owner(text, integer, integer, uuid, uuid)
    from public, anon, authenticated;

grant execute on function public.admin_set_chunk_owner(text, integer, integer, uuid, uuid)
    to service_role;

-- ---------------------------------------------------------------- bootstrap
--
-- Promote your own account. Replace 'Admin' if your username differs. The
-- server also does this automatically from the ADMIN_USERNAMES environment
-- variable, so this statement is only a convenience for the first deploy.

update public.game_users
set role = 'admin', updated_at = now()
where lower(display_name) = 'admin'
  and role <> 'admin';
