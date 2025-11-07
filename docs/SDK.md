# SDK

## API
```ts
const { Connection, Keypair } = await import('@solana/web3.js');
const connection = new Connection('https://api.devnet.solana.com');
const wallet = { publicKey: Keypair.generate().publicKey } as any; // read-only fetches

const client = new Assured402Client({
  policy: balanced(),
  connection,
  wallet,
  escrowProgramId: '6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL',
});
const res = await client.fetch('http://localhost:3000/api/good');
```

## Policy presets
```ts
export const strict   = () => ({ minReputation: 0.8, maxPrice: 0.02, requireSLA: true });
export const balanced = () => ({ minReputation: 0.6, maxPrice: 0.05, requireSLA: true });
export const cheap    = () => ({ minReputation: 0.4, maxPrice: 0.01, requireSLA: false });
```

## Facilitator interface
```ts
export interface Facilitator {
  name: 'native' | 'coinbase' | 'corbits';
  verifyPayment(req: PaymentRequirements): Promise<PaymentProof>;
  settle?(proof: PaymentProof): Promise<void>;
}
```

- `nativeFacilitator` requires a real `Connection`, `Wallet`, and the deployed escrow program ID.
- The CLI & demo scripts ship a mock facilitator that mints base64 receipts without touching chain; see `tools/cli/index.ts` and `demo/util.ts`.
- Reputation lookups default to devnet program `8QFXHzWC1hDC7GQTNqBhsVRLURpYfXFBzT5Vb4NTxDh5` but can be overridden via `reputationProgramId`.

## Signature Verification

The SDK exports helper functions to verify trace and mirror signatures returned by the server:

```ts
import { verifyTrace, verifyMirrorSig } from './sdk/ts/index.ts';

// Verify a trace signature from the server response
const traceValid = verifyTrace(
  callId,           // The call ID
  responseHashHex,  // Response hash in hex format
  deliveredAt,      // Delivery timestamp (milliseconds)
  signature,        // Base64-encoded ed25519 signature
  signerPublicKey   // Signer's Solana public key (base58)
);

// Verify a mirror signature
const mirrorValid = verifyMirrorSig(
  serviceId,        // Service identifier
  mirrorUrl,        // Mirror URL
  signature,        // Base64-encoded ed25519 signature
  signerPublicKey   // Signer's Solana public key (base58)
);
```

These functions return `true` if the signature is valid, `false` otherwise.

## Event Subscription

For streaming responses with partial releases, clients can subscribe to events:

```ts
const client = new Assured402Client({ ... });

// Subscribe to partial release events
client.on('partialRelease', (event) => {
  console.log(`Released ${event.index + 1} of ${event.totalUnits} units`);
});

// Subscribe to final settlement
client.on('finalSettle', (event) => {
  console.log(`Call ${event.callId} fully settled`);
});

// Unsubscribe when done
client.off('partialRelease', handler);
```
