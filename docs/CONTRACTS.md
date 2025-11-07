# CONTRACTS

Two Anchor programs: **escrow** and **reputation**.

## Escrow
- **Program ID:** `6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL`
- **IDL:** `contracts/escrow/target/idl/escrow.json`
- **Accounts:** `EscrowCall { call_id, payer, service_id, provider, amount, start_ts, sla_ms, dispute_window_s, status, delivered_ts?, response_hash, disputed, total_units, units_released, provider_sig }`
- **Instructions:**
  - `init_payment(callId, serviceId, amount, slaMs, disputeWindowS, totalUnits)`
  - `fulfill(responseHash[32], ts, providerSig)`
  - `fulfill_partial(chunkHash[32], units, ts, providerSig)`
  - `raise_dispute(kind, reasonHash[32], reporterSig)`
  - `settle()`
- **Events:** `Fulfilled`, `Released`, `Refunded`, `Disputed`, `PartialReleased`, `TraceSaved`

## Reputation
- **Program ID:** `8QFXHzWC1hDC7GQTNqBhsVRLURpYfXFBzT5Vb4NTxDh5`
- **IDL:** `contracts/reputation/target/idl/reputation.json`
- **Accounts:** `Service { ok: f32, late: f32, disputed: f32, bond_balance: u64, ewma_latency_ms: u64, p95_est_ms: u64 }`
- **Instructions:**
  - `update_weighted(serviceId, outcome, weightF32)` - Update reputation score
  - `bond_deposit(amount: u64)` - Deposit bond funds (owner only)
  - `bond_withdraw(amount: u64)` - Withdraw bond funds (owner only, requires non-negative balance)
  - `bond_slash(amount: u64)` - Slash bond on refund with evidence (callable from escrow via CPI)
  - `update_latency(sample_ms: u64)` - Update EWMA and p95 latency estimates

See implementations in `contracts/escrow/src/lib.rs` and `contracts/reputation/src/lib.rs`. Unit tests cover:
- Partial release increments `units_released` and emits `PartialReleased` event
- Refund path slashes bond when `disputed = true`
- Latency updates compute EWMA and p95 estimates
- Release/refund path selection and reputation tallies
