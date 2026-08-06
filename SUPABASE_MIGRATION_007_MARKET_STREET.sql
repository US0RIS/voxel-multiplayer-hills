-- Ridgewood v0.9.1: replace the compact marketplace grid with one long street.
-- Run after SUPABASE_MIGRATION_006_COINS_MARKETPLACE.sql.
--
-- Layout:
--   * street centerline: x = 8.5, running north/south along z
--   * stalls 1-10: west side at x = 4.25, facing east/inward
--   * stalls 11-20: east side at x = 12.75, facing west/inward
--   * ten paired positions from z = -20.25 through z = 20.25

begin;

-- Clear player claims and voxel overlays from the four chunks occupied by the
-- public street. Chunk 0,0 was already reserved by migration 006; the other
-- three become public infrastructure in this migration.
delete from public.chunks
where world_id = 'public'
  and chunk_x = 0
  and chunk_z between -2 and 1;

with layout as (
    select
        stall_number,
        case when stall_number <= 10 then 4.25 else 12.75 end::double precision as world_x,
        (-20.25 + (
            case when stall_number <= 10 then stall_number - 1 else stall_number - 11 end
        ) * 4.5)::double precision as world_z
    from public.marketplace_stalls
    where stall_number between 1 and 20
)
update public.marketplace_stalls as stall
set world_id = 'public',
    chunk_x = 0,
    chunk_z = floor(layout.world_z / 16.0)::integer,
    stall_x = layout.world_x,
    stall_y = 0,
    stall_z = layout.world_z,
    updated_at = now()
from layout
where stall.stall_number = layout.stall_number;

-- Reject claims anywhere in the complete marketplace street, not only chunk
-- 0,0. The trigger also protects the corridor against direct server writes.
create or replace function public.guard_marketplace_chunk_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.world_id = 'public'
       and new.chunk_x = 0
       and new.chunk_z between -2 and 1
       and new.owner_id is not null then
        raise exception 'marketplace_reserved' using errcode = 'P0001';
    end if;
    return new;
end;
$$;

drop trigger if exists marketplace_chunk_owner_guard on public.chunks;
create trigger marketplace_chunk_owner_guard
before insert or update of owner_id on public.chunks
for each row execute function public.guard_marketplace_chunk_owner();

commit;

-- Verification: should return 20 rows in two x positions and four z chunks.
select
    stall_number,
    chunk_x,
    chunk_z,
    stall_x,
    stall_z
from public.marketplace_stalls
order by stall_number;
