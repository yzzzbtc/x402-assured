# CLI (Conformance & Demo)

`tools/cli/index.ts` wraps the SDK so judges can validate the server and run the demos without writing code.

## Capabilities
- `conformance <url>`
  - Asserts the first response is `402`.
  - Validates the JSON body against the PaymentRequirements schema (including the `assured` namespace).
  - Boots the SDK with a mock facilitator, simulates payment, retries with `X-PAYMENT`, and requires a `200`.
  - Prints the generated `callId`, mock `txSig`, and decodes the `X-PAYMENT-RESPONSE` header.
  - **New checks:**
    - `traceSaved` - Verifies response includes trace data (responseHash, signature, signer)
    - `traceValid` - Verifies trace signature using `verifyTrace()` SDK helper
    - `mirrorSigValid` - Verifies mirror signatures if `assured.mirrors` present using `verifyMirrorSig()`
- `demo good|bad|stream`
  - Uses the same SDK flow but points at `GET /api/good`, `/api/bad`, or `/api/good_stream`.
  - For `stream`, displays the partial release timeline showing units released with timestamps.
  - Prints `callId`/`txSig` and reports whether the outcome released or went into dispute/refund.
- Policy presets can be overridden with `--policy strict|balanced|cheap`.

## Scripts
```json
{
  "scripts": {
    "cli": "tsx tools/cli/index.ts",
    "conf": "tsx tools/cli/index.ts conformance",
    "demo:good": "tsx tools/cli/index.ts demo good",
    "demo:bad": "tsx tools/cli/index.ts demo bad",
    "demo:stream": "tsx tools/cli/index.ts demo stream"
  }
}
```

## Usage
```bash
pnpm conf http://localhost:3000/api/good
pnpm demo:good
pnpm demo:bad
pnpm demo:stream
```
