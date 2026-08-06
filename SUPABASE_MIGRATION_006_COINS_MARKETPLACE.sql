-- Ridgewood v0.9.0: coins, marketplace stalls, listings, and inventory.
-- Run this once in Supabase SQL Editor before deploying the v0.9.0 server.
-- Re-running is safe: tables, indexes, seed rows, triggers, and functions are
-- created or replaced idempotently.

-- ------------------------------------------------------------------ balances

alter table public.game_users
    alter column coins set default 0;

update public.game_users
set coins = 0
where coins is null;

alter table public.game_users
    alter column coins set not null;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'game_users_coins_nonnegative'
    ) then
        alter table public.game_users
            add constraint game_users_coins_nonnegative check (coins >= 0);
    end if;
end
$$;

create table if not exists public.coin_transactions (
    id bigserial primary key,
    user_id uuid not null references public.game_users(id) on delete cascade,
    amount bigint not null check (amount <> 0),
    balance_after bigint not null check (balance_after >= 0),
    type text not null check (type in ('earn', 'spend', 'admin')),
    reason text not null check (char_length(reason) between 1 and 96),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists coin_transactions_user_created_idx
    on public.coin_transactions(user_id, created_at desc);

create index if not exists coin_transactions_reason_idx
    on public.coin_transactions(reason, created_at desc);

create unique index if not exists coin_transactions_starter_once_idx
    on public.coin_transactions(user_id)
    where reason = 'starter_bonus';

-- -------------------------------------------------------------- marketplace

create table if not exists public.marketplace_stalls (
    id bigserial primary key,
    owner_id uuid references public.game_users(id) on delete set null,
    stall_number integer not null unique check (stall_number between 1 and 20),
    world_id text not null default 'public' references public.worlds(id) on delete cascade,
    chunk_x integer not null default 0,
    chunk_z integer not null default 0,
    stall_x double precision not null,
    stall_y double precision not null default 0,
    stall_z double precision not null,
    name text not null,
    claimed_at timestamptz,
    claimed boolean not null default false,
    updated_at timestamptz not null default now(),
    check (char_length(name) between 1 and 48),
    check (claimed = (owner_id is not null))
);

create unique index if not exists marketplace_one_stall_per_owner_idx
    on public.marketplace_stalls(owner_id)
    where owner_id is not null;

create index if not exists marketplace_stalls_world_idx
    on public.marketplace_stalls(world_id, chunk_x, chunk_z, stall_number);

create table if not exists public.marketplace_listings (
    id bigserial primary key,
    stall_id bigint not null references public.marketplace_stalls(id) on delete cascade,
    seller_id uuid not null references public.game_users(id) on delete cascade,
    item_type text not null,
    item_name text not null,
    price bigint not null check (price between 1 and 1000000000),
    quantity integer not null default 1 check (quantity between 1 and 999),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (char_length(item_type) between 1 and 32),
    check (char_length(item_name) between 1 and 80)
);

create index if not exists marketplace_listings_stall_idx
    on public.marketplace_listings(stall_id, created_at);

create index if not exists marketplace_listings_seller_idx
    on public.marketplace_listings(seller_id, created_at desc);

create table if not exists public.player_inventory (
    id bigserial primary key,
    user_id uuid not null references public.game_users(id) on delete cascade,
    item_type text not null,
    item_name text not null,
    quantity integer not null default 1 check (quantity > 0),
    source_listing_id bigint references public.marketplace_listings(id) on delete set null,
    seller_id uuid references public.game_users(id) on delete set null,
    metadata jsonb not null default '{}'::jsonb,
    acquired_at timestamptz not null default now(),
    check (char_length(item_type) between 1 and 32),
    check (char_length(item_name) between 1 and 80)
);

create index if not exists player_inventory_user_idx
    on public.player_inventory(user_id, acquired_at desc);

-- Twenty fixed stalls in a 5 x 4 grid inside the marketplace hub at chunk 0,0.
-- stall_y=0 means the WebGL client should place the structure on the local
-- procedural ground height rather than at an absolute world elevation.
insert into public.marketplace_stalls (
    stall_number, world_id, chunk_x, chunk_z, stall_x, stall_y, stall_z, name
)
select
    n,
    'public',
    0,
    0,
    1.5 + ((n - 1) % 5) * 3.0,
    0,
    1.5 + floor((n - 1) / 5.0) * 4.0,
    'Stall ' || n::text
from generate_series(1, 20) as n
on conflict (stall_number) do nothing;

-- The marketplace hub is public infrastructure. Nobody may claim chunk 0,0,
-- even by bypassing the ordinary claim RPC and writing the chunks table.
create or replace function public.guard_marketplace_chunk_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.world_id = 'public'
       and new.chunk_x = 0
       and new.chunk_z = 0
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

-- ----------------------------------------------------------- coin functions

create or replace function public.grant_starter_coins(
    p_user_id uuid,
    p_amount bigint default 1000
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_balance bigint;
    v_transaction_id bigint;
begin
    if p_amount < 0 or p_amount > 1000000 then
        return jsonb_build_object('ok', false, 'error', 'invalid_amount');
    end if;

    select coins into v_balance
    from public.game_users
    where id = p_user_id
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_user');
    end if;

    select id into v_transaction_id
    from public.coin_transactions
    where user_id = p_user_id and reason = 'starter_bonus'
    limit 1;

    if found or p_amount = 0 then
        return jsonb_build_object(
            'ok', true,
            'granted', false,
            'coins', v_balance,
            'transactionId', v_transaction_id
        );
    end if;

    update public.game_users
    set coins = coins + p_amount, updated_at = now()
    where id = p_user_id
    returning coins into v_balance;

    insert into public.coin_transactions (
        user_id, amount, balance_after, type, reason, metadata
    ) values (
        p_user_id, p_amount, v_balance, 'earn', 'starter_bonus',
        jsonb_build_object('version', '0.9.0')
    ) returning id into v_transaction_id;

    return jsonb_build_object(
        'ok', true,
        'granted', true,
        'coins', v_balance,
        'transactionId', v_transaction_id
    );
end;
$$;

create or replace function public.admin_add_coins(
    p_actor_id uuid,
    p_target_user_id uuid,
    p_amount bigint,
    p_reason text default 'admin_grant'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_balance bigint;
    v_transaction_id bigint;
    v_role text;
begin
    if p_amount <= 0 or p_amount > 1000000000 then
        return jsonb_build_object('ok', false, 'error', 'invalid_amount');
    end if;

    select role into v_role from public.game_users where id = p_actor_id;
    if coalesce(v_role, 'player') <> 'admin' then
        return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;

    select coins into v_balance
    from public.game_users
    where id = p_target_user_id
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_user');
    end if;

    update public.game_users
    set coins = coins + p_amount, updated_at = now()
    where id = p_target_user_id
    returning coins into v_balance;

    insert into public.coin_transactions (
        user_id, amount, balance_after, type, reason, metadata
    ) values (
        p_target_user_id, p_amount, v_balance, 'admin',
        left(coalesce(nullif(trim(p_reason), ''), 'admin_grant'), 96),
        jsonb_build_object('actorId', p_actor_id)
    ) returning id into v_transaction_id;

    return jsonb_build_object(
        'ok', true,
        'coins', v_balance,
        'userId', p_target_user_id,
        'transactionId', v_transaction_id
    );
end;
$$;

create or replace function public.spend_coins(
    p_user_id uuid,
    p_amount bigint,
    p_reason text,
    p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_balance bigint;
    v_transaction_id bigint;
begin
    if p_amount <= 0 or p_amount > 1000000000 then
        return jsonb_build_object('ok', false, 'error', 'invalid_amount');
    end if;
    if char_length(trim(coalesce(p_reason, ''))) < 1 then
        return jsonb_build_object('ok', false, 'error', 'invalid_reason');
    end if;

    select coins into v_balance
    from public.game_users
    where id = p_user_id
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_user');
    end if;
    if v_balance < p_amount then
        return jsonb_build_object(
            'ok', false,
            'error', 'insufficient_coins',
            'coins', v_balance,
            'required', p_amount
        );
    end if;

    update public.game_users
    set coins = coins - p_amount, updated_at = now()
    where id = p_user_id
    returning coins into v_balance;

    insert into public.coin_transactions (
        user_id, amount, balance_after, type, reason, metadata
    ) values (
        p_user_id, -p_amount, v_balance, 'spend', left(trim(p_reason), 96),
        coalesce(p_metadata, '{}'::jsonb)
    ) returning id into v_transaction_id;

    return jsonb_build_object(
        'ok', true,
        'success', true,
        'coins', v_balance,
        'transactionId', v_transaction_id
    );
end;
$$;

-- ---------------------------------------------------- marketplace functions

create or replace function public.claim_marketplace_stall(
    p_user_id uuid,
    p_stall_number integer,
    p_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_stall public.marketplace_stalls%rowtype;
    v_existing public.marketplace_stalls%rowtype;
    v_display_name text;
    v_name text;
begin
    if p_stall_number < 1 or p_stall_number > 20 then
        return jsonb_build_object('ok', false, 'error', 'invalid_stall');
    end if;

    select display_name into v_display_name
    from public.game_users
    where id = p_user_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_user');
    end if;

    perform pg_advisory_xact_lock(hashtextextended('marketplace:user:' || p_user_id::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('marketplace:stall:' || p_stall_number::text, 0));

    select * into v_existing
    from public.marketplace_stalls
    where owner_id = p_user_id
    for update;

    if found then
        if v_existing.stall_number = p_stall_number then
            return jsonb_build_object('ok', true, 'duplicate', true, 'stall', to_jsonb(v_existing));
        end if;
        return jsonb_build_object('ok', false, 'error', 'already_has_stall', 'stall', to_jsonb(v_existing));
    end if;

    select * into v_stall
    from public.marketplace_stalls
    where stall_number = p_stall_number
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_stall');
    end if;
    if v_stall.claimed then
        return jsonb_build_object('ok', false, 'error', 'stall_claimed', 'stall', to_jsonb(v_stall));
    end if;

    v_name := left(coalesce(nullif(trim(p_name), ''), v_display_name || '''s Stall'), 48);

    update public.marketplace_stalls
    set owner_id = p_user_id,
        claimed = true,
        claimed_at = now(),
        name = v_name,
        updated_at = now()
    where id = v_stall.id
    returning * into v_stall;

    return jsonb_build_object('ok', true, 'success', true, 'stall', to_jsonb(v_stall));
end;
$$;

create or replace function public.unclaim_marketplace_stall(
    p_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_stall public.marketplace_stalls%rowtype;
begin
    perform pg_advisory_xact_lock(hashtextextended('marketplace:user:' || p_user_id::text, 0));

    select * into v_stall
    from public.marketplace_stalls
    where owner_id = p_user_id
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'no_stall');
    end if;

    delete from public.marketplace_listings where stall_id = v_stall.id;

    update public.marketplace_stalls
    set owner_id = null,
        claimed = false,
        claimed_at = null,
        name = 'Stall ' || stall_number::text,
        updated_at = now()
    where id = v_stall.id
    returning * into v_stall;

    return jsonb_build_object('ok', true, 'success', true, 'stall', to_jsonb(v_stall));
end;
$$;

create or replace function public.rename_marketplace_stall(
    p_user_id uuid,
    p_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_stall public.marketplace_stalls%rowtype;
    v_name text;
begin
    v_name := trim(coalesce(p_name, ''));
    if char_length(v_name) < 1 or char_length(v_name) > 48 then
        return jsonb_build_object('ok', false, 'error', 'invalid_name');
    end if;

    update public.marketplace_stalls
    set name = v_name, updated_at = now()
    where owner_id = p_user_id
    returning * into v_stall;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'no_stall');
    end if;
    return jsonb_build_object('ok', true, 'success', true, 'stall', to_jsonb(v_stall));
end;
$$;

create or replace function public.list_marketplace_item(
    p_user_id uuid,
    p_stall_id bigint,
    p_item_type text,
    p_item_name text,
    p_price bigint,
    p_quantity integer default 1,
    p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_stall public.marketplace_stalls%rowtype;
    v_listing public.marketplace_listings%rowtype;
    v_count integer;
    v_type text;
    v_name text;
begin
    v_type := lower(trim(coalesce(p_item_type, '')));
    v_name := trim(coalesce(p_item_name, ''));

    if char_length(v_type) < 1 or char_length(v_type) > 32 then
        return jsonb_build_object('ok', false, 'error', 'invalid_item_type');
    end if;
    if char_length(v_name) < 1 or char_length(v_name) > 80 then
        return jsonb_build_object('ok', false, 'error', 'invalid_item_name');
    end if;
    if p_price < 1 or p_price > 1000000000 then
        return jsonb_build_object('ok', false, 'error', 'invalid_price');
    end if;
    if p_quantity < 1 or p_quantity > 999 then
        return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    select * into v_stall
    from public.marketplace_stalls
    where id = p_stall_id
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_stall');
    end if;
    if v_stall.owner_id is distinct from p_user_id then
        return jsonb_build_object('ok', false, 'error', 'not_stall_owner');
    end if;

    select count(*) into v_count from public.marketplace_listings where stall_id = p_stall_id;
    if v_count >= 24 then
        return jsonb_build_object('ok', false, 'error', 'listing_limit');
    end if;

    insert into public.marketplace_listings (
        stall_id, seller_id, item_type, item_name, price, quantity, metadata
    ) values (
        p_stall_id, p_user_id, v_type, v_name, p_price, p_quantity,
        coalesce(p_metadata, '{}'::jsonb)
    ) returning * into v_listing;

    return jsonb_build_object('ok', true, 'success', true, 'listing', to_jsonb(v_listing));
end;
$$;

create or replace function public.delist_marketplace_item(
    p_user_id uuid,
    p_listing_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_listing public.marketplace_listings%rowtype;
begin
    select * into v_listing
    from public.marketplace_listings
    where id = p_listing_id
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_listing');
    end if;
    if v_listing.seller_id is distinct from p_user_id then
        return jsonb_build_object('ok', false, 'error', 'not_listing_owner');
    end if;

    delete from public.marketplace_listings where id = p_listing_id;
    return jsonb_build_object('ok', true, 'success', true, 'listingId', p_listing_id);
end;
$$;

create or replace function public.buy_marketplace_listing(
    p_buyer_id uuid,
    p_listing_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_listing public.marketplace_listings%rowtype;
    v_stall public.marketplace_stalls%rowtype;
    v_buyer_balance bigint;
    v_seller_balance bigint;
    v_buyer_transaction bigint;
    v_seller_transaction bigint;
    v_inventory_id bigint;
begin
    select * into v_listing
    from public.marketplace_listings
    where id = p_listing_id
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_listing');
    end if;

    select * into v_stall
    from public.marketplace_stalls
    where id = v_listing.stall_id
    for update;

    if not found or not v_stall.claimed or v_stall.owner_id is distinct from v_listing.seller_id then
        return jsonb_build_object('ok', false, 'error', 'listing_unavailable');
    end if;
    if v_listing.seller_id = p_buyer_id then
        return jsonb_build_object('ok', false, 'error', 'cannot_buy_own_listing');
    end if;

    -- Lock both account rows in UUID order to avoid buyer/seller deadlocks when
    -- two purchases cross in opposite directions.
    perform 1
    from public.game_users
    where id in (p_buyer_id, v_listing.seller_id)
    order by id
    for update;

    select coins into v_buyer_balance from public.game_users where id = p_buyer_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_buyer');
    end if;
    select coins into v_seller_balance from public.game_users where id = v_listing.seller_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_seller');
    end if;

    if v_buyer_balance < v_listing.price then
        return jsonb_build_object(
            'ok', false,
            'error', 'insufficient_coins',
            'coins', v_buyer_balance,
            'required', v_listing.price
        );
    end if;

    update public.game_users
    set coins = coins - v_listing.price, updated_at = now()
    where id = p_buyer_id
    returning coins into v_buyer_balance;

    update public.game_users
    set coins = coins + v_listing.price, updated_at = now()
    where id = v_listing.seller_id
    returning coins into v_seller_balance;

    insert into public.coin_transactions (
        user_id, amount, balance_after, type, reason, metadata
    ) values (
        p_buyer_id, -v_listing.price, v_buyer_balance, 'spend', 'marketplace_purchase',
        jsonb_build_object(
            'listingId', v_listing.id,
            'stallId', v_stall.id,
            'sellerId', v_listing.seller_id,
            'itemType', v_listing.item_type,
            'itemName', v_listing.item_name
        )
    ) returning id into v_buyer_transaction;

    insert into public.coin_transactions (
        user_id, amount, balance_after, type, reason, metadata
    ) values (
        v_listing.seller_id, v_listing.price, v_seller_balance, 'earn', 'marketplace_sale',
        jsonb_build_object(
            'listingId', v_listing.id,
            'stallId', v_stall.id,
            'buyerId', p_buyer_id,
            'itemType', v_listing.item_type,
            'itemName', v_listing.item_name
        )
    ) returning id into v_seller_transaction;

    insert into public.player_inventory (
        user_id, item_type, item_name, quantity, source_listing_id, seller_id, metadata
    ) values (
        p_buyer_id, v_listing.item_type, v_listing.item_name, 1,
        v_listing.id, v_listing.seller_id, v_listing.metadata
    ) returning id into v_inventory_id;

    if v_listing.quantity <= 1 then
        delete from public.marketplace_listings where id = v_listing.id;
    else
        update public.marketplace_listings
        set quantity = quantity - 1, updated_at = now()
        where id = v_listing.id;
    end if;

    return jsonb_build_object(
        'ok', true,
        'success', true,
        'coinsRemaining', v_buyer_balance,
        'sellerCoins', v_seller_balance,
        'sellerId', v_listing.seller_id,
        'buyerTransactionId', v_buyer_transaction,
        'sellerTransactionId', v_seller_transaction,
        'inventoryId', v_inventory_id,
        'item', jsonb_build_object(
            'type', v_listing.item_type,
            'name', v_listing.item_name,
            'price', v_listing.price
        ),
        'stallId', v_stall.id,
        'stallName', v_stall.name,
        'listingId', v_listing.id
    );
end;
$$;

-- --------------------------------------------------------------- permissions

alter table public.coin_transactions enable row level security;
alter table public.marketplace_stalls enable row level security;
alter table public.marketplace_listings enable row level security;
alter table public.player_inventory enable row level security;

revoke all on public.coin_transactions from anon, authenticated;
revoke all on public.marketplace_stalls from anon, authenticated;
revoke all on public.marketplace_listings from anon, authenticated;
revoke all on public.player_inventory from anon, authenticated;

revoke all on sequence public.coin_transactions_id_seq from anon, authenticated;
revoke all on sequence public.marketplace_stalls_id_seq from anon, authenticated;
revoke all on sequence public.marketplace_listings_id_seq from anon, authenticated;
revoke all on sequence public.player_inventory_id_seq from anon, authenticated;

grant select, insert on public.coin_transactions to service_role;
grant select, insert, update, delete on public.marketplace_stalls to service_role;
grant select, insert, update, delete on public.marketplace_listings to service_role;
grant select, insert, update, delete on public.player_inventory to service_role;

grant usage, select on sequence public.coin_transactions_id_seq to service_role;
grant usage, select on sequence public.marketplace_stalls_id_seq to service_role;
grant usage, select on sequence public.marketplace_listings_id_seq to service_role;
grant usage, select on sequence public.player_inventory_id_seq to service_role;

revoke all on function public.grant_starter_coins(uuid, bigint) from public, anon, authenticated;
revoke all on function public.admin_add_coins(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.spend_coins(uuid, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_marketplace_stall(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.unclaim_marketplace_stall(uuid) from public, anon, authenticated;
revoke all on function public.rename_marketplace_stall(uuid, text) from public, anon, authenticated;
revoke all on function public.list_marketplace_item(uuid, bigint, text, text, bigint, integer, jsonb) from public, anon, authenticated;
revoke all on function public.delist_marketplace_item(uuid, bigint) from public, anon, authenticated;
revoke all on function public.buy_marketplace_listing(uuid, bigint) from public, anon, authenticated;

grant execute on function public.grant_starter_coins(uuid, bigint) to service_role;
grant execute on function public.admin_add_coins(uuid, uuid, bigint, text) to service_role;
grant execute on function public.spend_coins(uuid, bigint, text, jsonb) to service_role;
grant execute on function public.claim_marketplace_stall(uuid, integer, text) to service_role;
grant execute on function public.unclaim_marketplace_stall(uuid) to service_role;
grant execute on function public.rename_marketplace_stall(uuid, text) to service_role;
grant execute on function public.list_marketplace_item(uuid, bigint, text, text, bigint, integer, jsonb) to service_role;
grant execute on function public.delist_marketplace_item(uuid, bigint) to service_role;
grant execute on function public.buy_marketplace_listing(uuid, bigint) to service_role;
