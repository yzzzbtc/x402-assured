# SERVER

## Routes
- `GET /api/good` → returns spec 402 with `assured`; on retry with `X-PAYMENT`, verifies, calls `fulfill`, returns `200` body with trace signature.
- `GET /api/bad` → same, but violates SLA/returns malformed to trigger refund/dispute (records refund evidence).
- `GET /api/good_stream` → streaming endpoint with partial releases; returns 402 with `stream:true, totalUnits:3`; on retry, performs 3 partial releases via `fulfill_partial` then final settle.
- `GET /api/good_mirror` → alternate service for fallback demo; returns PaymentRequirements with `serviceId:mirror` and resolves with body `{ source: 'alt-service' }` after payment.
- `POST /webhook/settlement` (HMAC) → provider notified of release/refund.

### Trace Signatures
All successful responses include a trace signature in the response body:
- **Format:** `assured-trace|callId|responseHashHex|deliveredAt`
- **Signature:** ed25519 signed by provider key
- **Verification:** Use SDK `verifyTrace()` function with provider's public key

### Mirror Signatures
Mirrors are advertised with ed25519 signatures in the `assured.mirrors` array:
- **Format:** `assured-mirror|serviceId|url`
- **Signature:** ed25519 signed by provider key
- **Verification:** Use SDK `verifyMirrorSig()` function

### Dashboard API
- `GET /summary`
  ```json
  {
    "services": [
      {
        "serviceId": "demo:good",
        "ok": 12,
        "late": 0,
        "disputed": 1,
        "score": 0.92,
        "hasBond": true,
        "bondLamports": 1500000000,
        "bond": "1.50",
        "ewmaMs": 850,
        "p95Ms": 1200,
        "latencySamples": 15
      },
      {
        "serviceId": "demo:bad",
        "ok": 1,
        "late": 4,
        "disputed": 7,
        "score": 0.11,
        "hasBond": false
      }
    ],
    "recent": [
      {
        "callId": "srv:demo:good:mhj6r1pi:i7nl8p",
        "serviceId": "demo:good",
        "startedAt": 1730652000,
        "slaMs": 2000,
        "outcome": "RELEASED",
        "tx": { "init": "<sig>", "fulfill": "<sig>", "settle": null },
        "stream": {
          "enabled": true,
          "totalUnits": 3,
          "unitsReleased": 3,
          "timeline": [
            { "index": 0, "at": 1730652100, "txSig": "<sig1>" },
            { "index": 1, "at": 1730652200, "txSig": "<sig2>" },
            { "index": 2, "at": 1730652300, "txSig": "<sig3>" }
          ]
        }
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
    "evidence": [ { "type": "SLA_MISSED", "expectedMs": 1000, "actualMs": 2004 } ],
    "trace": {
      "responseHash": "<hex32>",
      "signature": "<base64_ed25519>",
      "signer": "<provider_pubkey_base58>",
      "message": "assured-trace|callId|responseHash|deliveredAt",
      "savedAt": 1730652100
    },
    "stream": {
      "enabled": true,
      "totalUnits": 3,
      "unitsReleased": 3,
      "timeline": [ ... ]
    },
    "bond": {
      "hasBond": true,
      "bondLamports": 1500000000,
      "bond": "1.50"
    },
    "latency": {
      "ewmaMs": 850,
      "p95Ms": 1200,
      "samples": 15
    }
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
