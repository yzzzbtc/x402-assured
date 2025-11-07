# PLAN

## Phases (Spec‑Aligned)

### Phase 0 — Framing (1–2 hrs)
- Tracks: **Dev Tool** (primary), **Trustless Agent** (secondary).
- Success criteria: end‑to‑end on devnet; good→release; bad→refund; second agent refuses low‑rep; `pnpm dev` run; ≤3‑min video.

### Phase 1 — Solana Core (Day 1–2)
- Escrow program: `EscrowCall{callId,payer,serviceId,amount,startTs,slaMs,disputeWindowS,status,deliveredTs?,responseHash?,disputed?}`;
  ix: `init_payment`, `fulfill`, `raise_dispute(kind,reasonHash)`, `settle`.
- Reputation registry: PDA keyed by `serviceId`; `update_reputation(serviceId,outcome)`; outcomes `OK|LATE|DISPUTED`.
- Unit tests for release/refund.

### Phase 2 — x402 Server (Day 2–3)
- `/api/good` and `/api/bad` routes.
- Unauth → spec 402 with `assured` extension.
- Retry with `X-PAYMENT` → verify → `fulfill` → `200`.

### Phase 3 — SDK / Agent Client (Day 3–4)
- `assured.fetch(url, { policy, facilitator })`.
- Policy: `{minReputation,maxPrice,requireSLA}`.
- Facilitators: `native|corbits|coinbase`.

### Phase 4 — Dashboard (Day 4–5)
- List services, counts, score %, live log; demo buttons.

### Phase 5 — Demo Script & Docs (Day 5)
- README quickstart, architecture, commands.
- Video: problem → good path → bad path → refusal → recap.

### Phase 6 — Depth & Differentiation (Day 6–7)
- Evidence taxonomy; fallback provider via `assured.altService`;
- Sybil‑lite weights; JSON schema for `assured`.

### Phase 7 — Submission Pack (Day 7)
- Public GitHub + LICENSE; program IDs; demo video; one‑pager.

## Scope Additions — Locked

### High‑Impact (ship all)
1. Spec‑conformance CLI.
2. Facilitator adapters (Coinbase/Corbits).
3. Signed attestations (fulfill + dispute).
4. Provider settlement webhooks (HMAC).
5. SDK policy presets.

### Medium‑Impact (include both)
6. Fallback routing (altService).
7. Reputation weights (credibility weighting).

## Frontend polish tracks

### Level 1 — Winning polish (1–2 days)
- **Single-page dashboard** with services table (serviceId, OK/Late/Disputed counts, score badge) and recent calls list showing outcome chips, SLA, dispute reason, and devnet tx links.
- **Action buttons** for “Call Good”, “Call Bad”, and “Call Fallback” that invoke SDK flows and live-update the dashboard.
- **Transcript drawer** that surfaces the emitted 402 JSON, X-PAYMENT header, response hash, program IDs, settlement signatures, and copy helpers.
- **Sales copy** in the header (1-line pitch + Escrow/Disputes/Reputation bullets) emphasizing spec compatibility and devnet readiness.

### Level 2 — Developer experience (1–2 days)
- **Playground panel** to run arbitrary URLs with custom policy (minReputation/maxPrice/requireSLA) and render the transcript inline.
- **Request snippets** (curl/Postman/OpenAPI) auto-filled from the last run showing both the initial 402 GET and retry with X-PAYMENT.
- **Conformance tester UI** that accepts an endpoint, runs the CLI checks, and shows pass/fail badges in the browser.

### Level 3 — Seriousness & breadth (2–3 days)
- **Provider console** for registering services, viewing webhooks, and tracking dispute rates.
- **Reputation explorer** with historical charts (scores + evidence taxonomy) plus optional MCP demo tab that showcases an x402-Assured gated tool call.
- **UX polish** items: devnet faucet hints, trust badges (spec-compatible, program IDs, commit hash), and doc links to `docs/DEMO.md` / `docs/SPEC.md`.

## Feature wave — Hackathon stretch
- **Assured-Trace:** verifiable response signatures stored on-chain and verified client-side.
- **Assured-Stream:** partial settlement units with per-chunk signatures and timeline UI.
- **Assured-Bond:** provider bond deposits/slashing + latency EWMA/p95 metrics.
- **SLA scorecards:** surface p50/p95 latency in services table and enforceable policies.
- **Signed fallback mesh:** mirrors advertise ed25519 signatures; SDK verifies before routing.
