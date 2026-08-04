-- Ridgewood v0.6.0: persist procedural-terrain removals as voxel tombstones.
-- Run once in Supabase SQL Editor before deploying the v0.6.0 server.

create or replace function public.apply_voxel_edit(
    p_world_id text,
    p_user_id uuid,
    p_chunk_x integer,
    p_chunk_z integer,
    p_action text,
    p_voxel_pos jsonb,
    p_block_data jsonb,
    p_client_action_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_chunk public.chunks%rowtype;
    v_key text;
    v_existing_log bigint;
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
        return jsonb_build_object('ok', false, 'error', 'chunk_not_claimed');
    end if;

    if v_chunk.owner_id is distinct from p_user_id then
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

    return jsonb_build_object(
        'ok', true,
        'duplicate', false,
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

revoke all on function public.apply_voxel_edit(text, uuid, integer, integer, text, jsonb, jsonb, uuid)
    from public, anon, authenticated;

grant execute on function public.apply_voxel_edit(text, uuid, integer, integer, text, jsonb, jsonb, uuid)
    to service_role;
