# QA Checklist

## Spec wire
- `server/index.ts` `paymentRequirements()` emits the spec-aligned JSON (`price`, `currency`, `network`, `recipient`, namespaced `assured`).
- `finalizeSettlement()` encodes the x402 response header via `encodeResponseHeader` (base64) and the dashboard renders it via `maskHeader()` with expand/copy controls.

## Conformance endpoint
- `/conformance` returns named check results (`has402`, `validSchema`, `hasAssured`, `acceptsRetry`, `returns200`, `settlesWithinSLA`).

## Bad path realism
- Mock mode seeds `demo:bad` stats (~0.1 score). On-chain mode keeps live tallies via verified settlement webhooks.
- `runFallbackFlow()` records fallback evidence in the transcript and Recent Calls reflects the mirror release.

## UI clarity
- Dashboard hero explains the problem/solution; quick actions use spinners, Recent Calls rows are clickable.
- Transcript drawer: program IDs with copy, init/fulfill/settle devnet links, masked X-PAYMENT expand/copy, webhook verification badge, formatted evidence JSON.

## Ops polish
- `/run` is rate-limited (3 RPS) and enforces same-origin URLs; on-chain mode checks provider SOL balance (>0.1) and hints `solana airdrop` when low.
- `/webhook/settlement` validates HMAC signatures and records verification state.

## New Features (Stretch Wave)

### Assured-Trace
- ✓ Server generates ed25519 signatures for all successful responses
- ✓ SDK `verifyTrace()` function validates trace signatures
- ✓ CLI conformance checks include `traceSaved` and `traceValid`
- ⚠ Dashboard "Verify Trace" button (UI component pending)

### Assured-Stream
- ✓ Escrow contract supports `fulfill_partial` with `totalUnits` and `units_released`
- ✓ Server `/api/good_stream` endpoint performs 3 partial releases
- ✓ CLI `demo:stream` command shows timeline
- ⚠ Dashboard stream timeline visualization (UI component pending)

### Assured-Bond
- ✓ Reputation contract tracks `bond_balance` with deposit/withdraw/slash instructions
- ✓ Server reflects bond data in `/summary` and `/calls/:id` responses
- ✓ Bond slash triggered on refund with evidence
- ⚠ Dashboard "Bonded" badges (UI component pending)

### SLA Scorecards
- ✓ Reputation contract tracks EWMA and p95 latency with `update_latency`
- ✓ Server surfaces `ewmaMs` and `p95Ms` in service summaries
- ✓ SDK Policy type includes `slaP95MaxMs` field
- ⚠ SDK p95 enforcement before payment (logic pending)
- ⚠ Dashboard p95 chips (UI component pending)

### Signed Fallback Mesh
- ✓ Server signs mirror URLs with ed25519 (format: `serviceId|url`)
- ✓ SDK `verifyMirrorSig()` function validates mirror signatures
- ✓ CLI conformance checks include `mirrorSigValid`
- ⚠ SDK automatic mirror routing (integration pending)
- ⚠ Dashboard mirror routing badge (UI component pending)

## Submission readiness
- README updated with 3-sentence pitch + ≤6 command Quickstart.
- MIT LICENSE added.
- Docs refreshed (`CONTRACTS.md`, `SERVER.md`, `SDK.md`, `CLI.md`, `DEMO.md`, `SPEC.md`) with new features.
