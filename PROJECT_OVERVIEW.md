# Voxel Multiplayer Hills — Project Overview

## Vision
A persistent multiplayer world game that functions primarily as a group chat replacement, where players build, trade, and socialize in a shared Hermitcraft-inspired environment. Monetized through chunk claims, cosmetics, server hosting, and marketplace cuts.

---

## Business Model

### Public Server (Developer-Hosted)
- **Monetization:**
  - Chunk claims: $3 per extra chunk (free tier: 2–4 chunks)
  - Cosmetics: $2–5 per item (skins, tool variants, themes)
  - Marketplace cuts: 10–20% on player-to-player trades
  - Optional battle pass: $5/season
- **Target:** 50–200 concurrent players (tight, Hermitcraft-style community)
- **Hosting:** Developer's M5 MacBook Air (MVP), upgrade to cloud ($5–15/mo) at scale

### Private Servers (Player-Hosted)
- **Monetization:**
  - Server software license: $10–15/month per server
  - Cosmetics: $2–5 per item (synced across all servers)
  - Server expansions: $5–10 per feature pack
- **Target:** Small friend groups (4–32 players)
- **Hosting:** Players self-host on their own hardware

---

## Core Mechanics

### World & Chunks
- Infinite procedurally generated world with rolling hills
- Chunk-based claiming system (16x16 or 32x32 units)
- Free tier: 2–4 chunks per player; $3 per additional chunk
- Persistent build storage (chunks saved indefinitely until deleted)

### Building & Customization
- Voxel-based or prop-placement building system
- Cosmetic items (skins, particles, themes) purchasable in-game
- Cosmetics sync across public + private servers
- Visual feedback for claimed chunks (borders, highlights)

### Economy & Marketplace
- **Physical marketplace hub near spawn** with claimable stalls
- Players harvest resources (trees, ore, crops, fish) that respawn daily/weekly
- Players claim stalls and sell items (resources, cosmetics, crafted goods)
- Developer takes 10–20% cut on all stall sales
- Player-to-player direct trades (no tax)

### Seasonal Content
- New biomes, events, building materials released every 3 months
- Collective server-wide goals (e.g., "harvest 100K apples to unlock new biome")
- Seasonal cosmetics with FOMO/battle pass incentive

### Social Features (Chat-Centric)
- **Discord-like chat panel** (40% of screen, collapsible)
  - Full message history with timestamps
  - Player list with online/offline status
  - Reactions, @ mentions, message search, pinned messages
  - Typing indicators, join/leave notifications
  - Avatar colors, custom status ("doing homework", "AFK")
- **Toast notifications** (top-right, when chat collapsed)
  - Shows new messages in real-time
  - Clickable to jump to message or player
  - Auto-dismisses after 4 seconds
- **Chat commands** (all shipped, plus more — see `CHAT.md`):
  - `/here` — broadcast current location
  - `/status [text]` — set custom status
  - `/tp [player]` — teleport to player
  - `/list` — see all online players + locations
  - `/goto [message]` — jump to location mentioned in chat
  - `/nick`, `/me`, `/w`, `/roll`, `/pins`, `/clear`, `/help`

---

## Current State (Build 4.3.0)

### ✅ Completed
- Procedural terrain generation with rolling hills (Perlin noise)
- Real-time multiplayer (2+ players synced across the world)
- Player model with rigged animations
- Chunk loading/unloading system
- WebGL2 rendering (high performance)
- Network sync via WebSocket (15 updates/sec)
- Cross-server connectivity (tested globally)
- **Chat system (Discord-like, collapsible, toasts)** — shipped in 4.3.0
  - Grouping, date/unread dividers, scroll anchoring, jump-to-present
  - Replies, edits, deletes, pins, reactions, markdown, emoji picker
  - @mentions, slash commands, search, member list, whispers, `/nick`
  - Desktop notifications, tab badge, offline outbox with retry
  - Chat history persisted server-side across restarts
  - See [`CHAT.md`](CHAT.md); regression suites in [`tests/`](tests/)

### 🚧 In Progress
- Persistence layer for **chunk/build data** (chat history already persists)
- Building system (place/remove blocks, claim chunks)

### 📋 Planned
- Marketplace hub (physical stalls near spawn)
- Resource harvesting & respawn system
- Cosmetics marketplace
- Battle pass system
- Private server software + licensing
- Admin tools (player management, moderation)
- Voice chat integration (optional)

---

## Technical Architecture

### Frontend
- **Framework:** Vanilla JavaScript + WebGL2
- **3D Engine:** Custom (no game engine dependency)
- **Networking:** native JSON-over-WebSocket (Socket.io-style event names)
- **Rendering:** Isometric voxel world with character model (GLB)
- **UI:** HTML/CSS with dark mode aesthetic

### Backend
- **Runtime:** Python 3 (standard library only — no install step on Render)
- **Networking:** native WebSocket implementation (`server/server-source.py`)
- **Database:** JSON file for chat history today; SQLite (MVP) → PostgreSQL (production) for chunk/build data
- **Hosting:** M5 MacBook Air (current), cloud services at scale

### Deployment
- Browser-based (no client install needed)
- Runs on localhost for development
- Deployed via web server (Render, Heroku, AWS, etc.)
- Share URL to invite players

---

## Development Roadmap

### Phase 1 (MVP — Next 2–3 weeks)
1. ~~**Chat system** (Discord-like, collapsible, toasts)~~ — ✅ done in 4.3.0
2. **Persistence** (save chunk data, player state)
3. **Building** (place/remove blocks, claim chunks)
4. **Marketplace hub** (physical spawn area with stalls)

**Milestone:** Playable MVP with 5–10 friends for testing

### Phase 2 (Polish & Economy — 4–6 weeks)
1. Resource harvesting system (trees, ore, crops)
2. Crafting mechanics (optional)
3. Cosmetics marketplace (buy/sell skins, themes)
4. Seasonal content rollout (first biome, event)

**Milestone:** Ready for public beta with 50+ players

### Phase 3 (Private Servers & Scale — 6–10 weeks)
1. Private server software package (download + run locally)
2. Server management dashboard
3. Subscription/licensing backend
4. Admin moderation tools

**Milestone:** Players can launch their own servers; revenue-generating

### Phase 4 (Long-term)
1. Mobile app (or mobile-optimized web client)
2. Advanced building tools (blueprints, terraforming)
3. Guilds/factions system
4. Leaderboards & achievements
5. Voice chat integration

---

## Success Metrics

### Player Engagement
- **30-day retention:** >50% (players return after first month)
- **Daily active users (DAU):** >100 on public server
- **Session length:** >20 mins average
- **Marketplace transactions:** >50 per day

### Monetization
- **Revenue per user (ARPU):** $2–5/month
- **Conversion rate:** 10–15% of free players → paid chunks/cosmetics
- **Private server adoption:** >10 active servers by month 6

### Community Health
- **Player satisfaction:** >4.5/5 rating
- **Moderation reports:** <5 per week
- **Churn rate:** <10% per month

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Players don't engage after building | Seasonal content, resource respawns, marketplace activity, chat as primary UX |
| Multiplayer lag/sync issues | Rigorous testing, reduce network send rate if needed, client-side prediction |
| Private server crashes | Robust error handling, clear logs, quick patch cycles, automated testing |
| Marketplace becomes toxic | Transaction moderation, listing review, escrow system, clear ToS |
| High server costs | Start on MacBook, migrate to cloud incrementally, scale with revenue |
| Cosmetics pricing too high | A/B test pricing, offer bundles, monitor conversion rates |

---

## Next Immediate Actions

1. ~~**Build chat system**~~ — ✅ shipped in 4.3.0
2. **Add persistence layer** (SQLite, chunk data storage) — 2–3 days
3. **Implement building** (place/remove blocks, claim UI) — 3–4 days
4. **Create marketplace hub** (spawn area, stall placement) — 2–3 days
5. **Playtest with friends** (gather feedback, iterate)

---

## Project Stats

- **Lines of code:** ~5K (frontend), ~2K (backend, MVP)
- **Development time so far:** ~2 weeks
- **Target launch:** 3–4 weeks (MVP)
- **Team size:** Solo (you)
- **Hosting cost (MVP):** $0 (MacBook) → $5–15/mo at scale
