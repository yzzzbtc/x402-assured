# SERVER

## Routes
- `GET /api/good` → returns spec 402 with `assured`; on retry with `X-PAYMENT`, verifies, calls `fulfill`, returns `200` body.
- `GET /api/bad` → same, but violates SLA/returns malformed to trigger refund/dispute (records refund evidence).
- `GET /api/good_mirror` → alternate service for fallback demo; returns PaymentRequirements with `serviceId:mirror` and resolves with body `{ source: 'alt-service' }` after payment.
- `POST /webhook/settlement` (HMAC) → provider notified of release/refund.

### Dashboard API
- `GET /summary`
  ```json
  {
    "services": [
      { "serviceId": "demo:good", "ok": 12, "late": 0, "disputed": 1, "score": 0.92 },
      { "serviceId": "demo:bad", "ok": 1, "late": 4, "disputed": 7, "score": 0.11 }
    ],
    "recent": [
      {
        "callId": "srv:demo:good:mhj6r1pi:i7nl8p",
        "serviceId": "demo:good",
        "startedAt": 1730652000,
        "slaMs": 2000,
        "outcome": "RELEASED",
        "tx": { "init": "<sig>", "fulfill": "<sig>", "settle": null }
      }
    ]
  }
  ```
- `GET /calls/:callId`
  ```json
  {
    "callId": "srv:demo:good:mhj6r1pi:i7nl8p",
    "serviceId": "demo:good",
    "paymentRequirements": { /* exact 402 JSON */ },
    "retryHeaders": { "X-PAYMENT": "<base64>" },
    "responseHash": "<hex32>",
    "programIds": { "escrow": "6zp...", "reputation": "8QF..." },
    "tx": { "init": "<sig>", "fulfill": "<sig|null>", "settle": "<sig|null>" },
    "outcome": "RELEASED",
    "evidence": [ { "type": "SLA_MISSED", "expectedMs": 1000, "actualMs": 2004 } ]
  }
  ```
- `POST /run`
  - Body: `{ "type": "good" | "bad" | "fallback", "policy"?: { "minReputation": number, "maxPrice": number, "requireSLA": boolean }, "url"?: string }`
  - Behaviour: drives the SDK against the requested route (or custom URL) and returns the same payload as `GET /calls/:callId`.
  - Guardrails: rate-limited to ~3 RPS, rejects URLs outside the local origin, and (in `ASSURED_MODE=onchain`) refuses to run if the provider wallet holds <0.1 SOL (responds with an airdrop hint).
- `POST /conformance`
  - Body: `{ "url"?: string, "policy"?: "strict" | "balanced" | "cheap" }`
  - Behaviour: mirrors the CLI checks server-side (ensures HTTP 402, schema conformity, assured namespace, retry acceptance, final `200 OK`, and presence of the settlement header).
  - Response:
    ```json
    {
      "ok": true,
      "checks": {
        "has402": { "passed": true, "detail": "status=402" },
        "validSchema": { "passed": true },
        "hasAssured": { "passed": true },
        "acceptsRetry": { "passed": true, "detail": "status=200" },
        "returns200": { "passed": true, "detail": "status=200" },
        "settlesWithinSLA": { "passed": true, "detail": "fulfilledAt=..." }
      },
      "receipt": { "callId": "conf:demo:good:...", "txSig": "mock-...", "headerValue": "<base64>" },
      "paymentResponse": "eyAiY2FsbElkIjogLi4uIH0="
    }
    ```
  - Powers the dashboard conformance tester panel.

## 402 Example
See [SPEC.md](SPEC.md). Add `assured.altService` for fallback demo.

## Verification
- Native mode: verify escrow call on-chain before responding.
- Facilitator mode (Coinbase/Corbits): use their `/verify`/`/settle` endpoints if available.
