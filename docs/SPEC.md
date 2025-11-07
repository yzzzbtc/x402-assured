# SPEC

## PaymentRequirements (spec + namespaced extension)

```json
{
  "price": "0.001",
  "currency": "USDC",
  "network": "solana-devnet",
  "recipient": "<merchant_pubkey>",
  "assured": {
    "serviceId": "demo:good",
    "slaMs": 2000,
    "disputeWindowS": 10,
    "escrowProgram": "<program_id>",
    "reputationProgram": "<reputation_program_id>",
    "altService": "https://localhost:3000/api/good_mirror",
    "sigAlg": "ed25519",
    "stream": true,
    "totalUnits": 5,
    "mirrors": [
      {
        "url": "https://mirror1.example.com/api/good",
        "sig": "<base64_ed25519_signature>"
      }
    ],
    "hasBond": true,
    "bondBalance": "1.50",
    "slaP95Ms": 1800
  }
}
```

- Retry header: `X-PAYMENT: <base64 receipt>` (optionally `X-PAYMENT-RESPONSE` on success).
- `assured` is **namespaced** to remain wire‑compatible with standard x402 clients.

### Streaming Extensions

- `stream` (boolean): Enables streaming with partial releases
- `totalUnits` (number): Number of stream units for incremental settlement
- Streaming responses emit server-side events as units are released

### Trace & Mirror Signatures

- `mirrors` (array): Signed fallback endpoints
  - Each mirror includes `url` and `sig` (ed25519 signature over `assured-mirror|serviceId|url`)
- Server attaches trace signatures to responses:
  - Message format: `assured-trace|callId|responseHashHex|deliveredAt`
  - Signature can be verified client-side with `verifyTrace()` SDK helper

### Bond & Latency Metadata

- `hasBond` (boolean): Provider has bonded funds
- `bondBalance` (string): Bond amount in SOL
- `slaP95Ms` (number): 95th percentile latency target

## Evidence Types
- `LATE`, `NO_RESPONSE`, `BAD_PROOF`, `MISMATCH_HASH`

## Policy (SDK)
```ts
type Policy = {
  minReputation: number;
  maxPrice: number;
  requireSLA: boolean;
  slaP95MaxMs?: number;
};
// presets: strict | balanced | cheap
```
