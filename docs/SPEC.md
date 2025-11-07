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
    "altService": "https://localhost:3000/api/good_mirror",
    "sigAlg": "ed25519"
  }
}
```

- Retry header: `X-PAYMENT: <base64 receipt>` (optionally `X-PAYMENT-RESPONSE` on success).
- `assured` is **namespaced** to remain wire‑compatible with standard x402 clients.

## Evidence Types
- `LATE`, `NO_RESPONSE`, `BAD_PROOF`, `MISMATCH_HASH`

## Policy (SDK)
```ts
type Policy = { minReputation: number; maxPrice: number; requireSLA: boolean };
// presets: strict | balanced | cheap
```
