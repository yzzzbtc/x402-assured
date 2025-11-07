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

## Submission readiness
- README updated with 3-sentence pitch + ≤6 command Quickstart.
- MIT LICENSE added.
- Docs refreshed (`SERVER.md`, `DEMO.md`, `OVERVIEW.md`) with new features and image placeholders (`docs/img/`).
