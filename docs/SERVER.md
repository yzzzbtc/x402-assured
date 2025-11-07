# SERVER

## Routes
- `GET /api/good` → returns spec 402 with `assured`; on retry with `X-PAYMENT`, verifies, calls `fulfill`, returns `200` body.
- `GET /api/bad` → same, but violates SLA/returns malformed to trigger refund/dispute.
- `GET /api/good_mirror` → alternate service for fallback demo; returns PaymentRequirements with `serviceId:mirror` and resolves with body `{ source: 'alt-service' }` after payment.
- `POST /webhook/settlement` (HMAC) → provider notified of release/refund.

## 402 Example
See [SPEC.md](SPEC.md). Add `assured.altService` for fallback demo.

## Verification
- Native mode: verify escrow call on-chain before responding.
- Facilitator mode (Coinbase/Corbits): use their `/verify`/`/settle` endpoints if available.
