# Ridgewood v0.9.0 alpha — coins and marketplace

This feature is isolated on `feature/coin-marketplace-v0.9.0`. It extends the
current v0.8 authentication, persistence, building, mining, and staff systems.

## Supabase

Run `SUPABASE_MIGRATION_006_COINS_MARKETPLACE.sql` in the Supabase SQL Editor
before deploying the server. The migration uses the repository's existing
`public.game_users(id uuid)` table; it does not create a conflicting `users`
table.

It creates:

- `coin_transactions`: append-only, signed, balance-after coin ledger
- `marketplace_stalls`: twenty fixed stalls in public chunk `0,0`
- `marketplace_listings`: seller listings with price and quantity
- `player_inventory`: purchased-item receipts/inventory
- atomic PostgreSQL functions for starter grants, admin grants, spending, stall
  claims, listings, delisting, renaming, and purchases

Chunk `0,0` is protected by both PostgreSQL and the server runtime so it remains
shared marketplace infrastructure.

## Render configuration

The server uses the existing Supabase secret configuration. Optional settings:

```text
STARTER_COINS=1000
COIN_TRANSACTION_LIMIT=30
```

The Supabase secret key remains server-side. No browser code receives it.

## HTTP API

All endpoints except `GET /marketplace/stalls` require a valid session token in
`Authorization: Bearer <token>` or `?token=<token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/coins/balance` | Current balance; grants the one-time starter bonus |
| POST | `/coins/add` | Admin-only grant to self or `user_id` |
| POST | `/coins/spend` | Atomic generic spend with reason and metadata |
| GET | `/coins/transactions` | Recent ledger rows |
| GET | `/marketplace/stalls` | Stalls, owners, locations, and listings |
| POST | `/marketplace/claim` | Claim one unclaimed stall |
| POST | `/marketplace/unclaim` | Release the caller's stall and its listings |
| POST | `/marketplace/rename` | Rename the caller's stall |
| POST | `/marketplace/list-item` | Create a listing |
| POST | `/marketplace/buy` | Atomic buyer-to-seller purchase |
| POST | `/marketplace/delist` | Remove the caller's listing |
| GET | `/marketplace/inventory` | Purchased items |

Equivalent actions use the existing WebSocket connection. Coin changes are sent
to the affected player as `coins:balance`; marketplace mutations broadcast
`marketplace:updated`; purchases notify buyer and seller separately.

## Client behavior

- The coin balance appears in the top-right HUD.
- Press `M` or enter `/marketplace` to teleport to the hub.
- Twenty voxel kiosks are generated in chunk `0,0`.
- Point at a kiosk and click to open its stall panel.
- Unclaimed stalls show **Claim this stall**.
- Owners can list, delist, rename, and unclaim.
- Other players can buy listings after confirmation.
- Purchased items are inserted into `player_inventory`.
- The first active listing controls the showcase block displayed on the kiosk.

The v0.8 loader is retained as `docs/game-loader-v0.8.0-base.js`. The existing
entry filename remains compatible and forwards to the v0.9 loader, so the
current authentication script does not need to be duplicated.

## Test sequence

1. Run migration 006.
2. Deploy the feature branch to a separate Render service.
3. Confirm `/health` reports `coins: true` and `marketplace: true`.
4. Sign in as Player 1 and verify a one-time 1,000-coin balance.
5. Press `M`, click an empty stall, claim it, and list a cosmetic for 100 coins.
6. Sign in as Player 2 and verify a separate one-time 1,000-coin balance.
7. Press `M`, open Player 1's stall, and buy the cosmetic.
8. Confirm Player 2 has 900 coins, Player 1 has 1,100 coins, the listing quantity
   decreases, and `player_inventory` contains the purchased item.
9. Confirm two corresponding rows exist in `coin_transactions`.
10. Restart Render and verify balances, stall ownership, listings, and inventory
    remain unchanged.

Do not merge into production until the live Supabase/Render test passes.
