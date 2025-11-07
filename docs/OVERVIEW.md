# OVERVIEW

**Title:** x402‑Assured — SLA escrow, disputes, and on‑chain reputation for x402 on Solana  
**One‑liner:** Make agent payments safe by default.  
**Why now:** x402 unlocks instant, HTTP‑native payments; what’s missing is *recourse and shared memory* against slow/bad providers.

## What it does (spec‑aligned)
- Responds with standard HTTP 402 Payment Requirements; extensions live under a namespaced `assured` object (`serviceId`, `slaMs`, `disputeWindowS`, `escrowProgram`).
- Client pays and retries with `X-PAYMENT`; server verifies and calls on‑chain `fulfill`; settlement is gated by SLA & disputes.
- Disputes post structured evidence on-chain; reputation aggregates `ok/late/disputed` per `serviceId`.
- Ships a TS SDK with agent policy (`minReputation`, `maxPrice`, `requireSLA`) + auto‑dispute.
- Drop‑in facilitator adapters (native / Corbits / Coinbase).

**Tracks:** Best x402 Dev Tool (primary) • Best Trustless Agent (secondary).

## Architecture
- **Escrow Program (Anchor):** `init_payment`, `fulfill`, `raise_dispute`, `settle`.
- **Reputation Registry (PDA per serviceId):** `ok`, `late`, `disputed` → score = `ok/(ok+late+disputed)`.
- **x402 Server (Fastify/Express):** returns spec 402 + `assured`; on retry with `X-PAYMENT`, verifies and writes `fulfill` → `200`.
- **SDK (TypeScript):** `assured.fetch(url, { policy, facilitator })` with policy + adapters.
- **Dashboard (Vite/Next):** list services, outcomes, scores; demo buttons.

### Dashboard snapshots
- **Services table** — serviceId, score badge (green/amber/red), and OK/Late/Disputed counts that sync live with new flows.
- **Recent calls** — rolling log with callId, timestamps, outcome chips, and quick access to transcripts.
- **Transcript drawer** — full 402 payload, masked X-PAYMENT header with expand/copy, escrow/reputation program IDs, explorer links for init/fulfill/settle signatures, and webhook verification.
- **Quick actions** — “Call Good”, “Call Bad”, “Call Fallback” buttons that drive SDK flows against the running Fastify server.

![Dashboard overview](img/dashboard-overview.png)
![Transcript drawer](img/dashboard-transcript.png)

### ASCII Diagram
```
+--------------------+           HTTP           +------------------------------+
|        Agent       |  GET /api/x  ─────────▶  |        x402 Server/API       |
|  (SDK: assured.js) |                          | (Fastify/Express + Assured)  |
+----------+---------+                          +---------------+--------------+
           |                                                    |
           |  402 PaymentRequired (PaymentRequirements JSON)    |
           ◀────────────────────────────────────────────────────┘
           |
           |  (1) Policy check: reputation, price, SLA
           |  (2) init_payment(callId, ... amount ...)  ────────────────┐
           |                                                             |
           |                    Solana (devnet)                          |
           |        +-------------------+   +------------------------+   |
           |        |   Escrow Program  |   |  Reputation Registry  |   |
           |        |  (Anchor PDA per  |   | (PDA per serviceId)   |   |
           |        |     callId)       |   | ok/late/disputed tallies| |
           |        +---------+---------+   +-----------+------------+   |
           |                  ^                         ^                |
           |                  |                         |                |
           |   fulfill(callId,responseHash,ts)          |                |
           |   settle(callId) / refund or release       |                |
           |                                            | update(outcome)|
           |                                            |                |
           └────────────────────────────────────────────┴────────────────┘
                         ^                        |
                         |                        |
           retry with X-PAYMENT header            |
                         |                        |
+--------------------+   |    200 OK + body       |       +-------------------+
|        Agent       | ◀─┘   (auto‑dispute if bad)|       |   Dashboard UI    |
|  (SDK: assured.js) |                            |       | (service scores)  |
+--------------------+                            |       +-------------------+
                                                  |
                       disputes(kind,reasonHash) ─┘
```
