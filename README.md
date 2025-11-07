# x402-Assured

> **Solana-based HTTP 402 payment protocol with escrow, SLA enforcement, reputation tracking, and cryptographic audit trails.**

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://x402-assured.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Wire-compatible x402 extension** with streaming payments, bonded providers, and verified fallback mesh.

## 🚀 Live Demo

**Dashboard:** [https://x402-assured.vercel.app](https://x402-assured.vercel.app) *(link will be updated after deployment)*

Try the interactive demo to see all 5 features in action:
- View provider reputation scores with bond status and P95 latency
- Trigger payment flows (good/bad/streaming)
- Verify cryptographic trace signatures
- Inspect streaming payment timelines
- Test conformance against x402 spec

---

## 📖 Overview

Plain x402 wires funds instantly with **no recourse**. x402-Assured extends the protocol with:

- **Escrow-based payments** via Solana smart contracts
- **SLA enforcement** with typed disputes (LATE / BAD_PROOF / MISMATCH_HASH)
- **On-chain reputation** tracking (ok/late/disputed per serviceId)
- **Cryptographic audit trails** with Ed25519 signatures
- **Streaming payments** with incremental fund releases
- **Provider bonding** with stake-based reputation enhancement

All while maintaining **wire-compatibility** with the x402 spec.

---

## ✨ Five Differentiating Features

### 1. 🔐 Assured-Trace (Cryptographic Audit Trail)

Every response is signed with Ed25519 signatures, creating an unforgeable audit trail. Clients can verify that the server actually delivered the claimed response hash at the claimed time.

```typescript
const isValid = verifyTrace(callId, responseHash, deliveredAt, signature, signerPublicKey);
// true = cryptographically proven delivery
```

**Why it matters:** Enables dispute resolution with cryptographic proof instead of "he said, she said."

---

### 2. 🌊 Assured-Stream (Incremental Payment Releases)

For long-running operations, funds are released incrementally as progress milestones are reached. Reduces risk for both parties during streaming responses or multi-step workflows.

```json
{
  "stream": true,
  "totalUnits": 5,
  "unitsReleased": 3,
  "timeline": [
    { "index": 1, "at": 1699564234000, "txSig": "..." },
    { "index": 2, "at": 1699564236000, "txSig": "..." }
  ]
}
```

**Why it matters:** Protects both parties in long-running computations (LLM inference, video processing, etc.)

---

### 3. 💎 Assured-Bond (Stake-Based Reputation)

Providers can lock SOL on-chain as collateral, signaling commitment to quality. Bonds are slashed on disputes, creating economic incentive for good behavior.

```rust
// Provider locks 1.5 SOL as quality signal
bond_create(ctx, lamports: 1_500_000_000)
```

**Why it matters:** Distinguishes serious providers from fly-by-night operations before you pay.

---

### 4. 📊 SLA Scorecards (P95 Latency Tracking)

On-chain reputation tracks EWMA and P95 latency estimates. Clients can enforce maximum latency policies before payment, filtering out slow or unreliable providers.

```typescript
const client = new Assured402Client({
  policy: {
    minReputation: 0.8,
    maxPrice: 0.05,
    slaP95MaxMs: 2000  // Reject if provider's p95 > 2 seconds
  }
});
```

**Why it matters:** Enables SLA-based routing and automatic provider selection.

---

### 5. 🔗 Signed Fallback Mesh (Verified Mirrors)

Providers advertise signed mirror URLs for redundancy. Clients verify signatures before routing, ensuring mirrors are authentic and not malicious redirects.

```json
{
  "mirrors": [
    {
      "url": "https://backup.provider.com/api",
      "sig": "base64_ed25519_signature"
    }
  ]
}
```

**Why it matters:** Enables trustless failover without centralized discovery.

---

## 🏗️ Architecture

### On-Chain Components (Solana Devnet)

- **Escrow Program** - Payment locks, SLA enforcement, disputes, settlement
- **Reputation Program** - Service scores, provider bonds, latency tracking (EWMA, P95)

### Off-Chain Components

- **TypeScript SDK** - Client library with policy enforcement and verification helpers
- **Fastify Server** - Provider API with settlement automation and trace signing
- **React Dashboard** - Interactive UI for monitoring services, calls, and reputation
- **CLI Tools** - Conformance testing and demo flows

### Flow Diagram

```
Client                Server                Solana
  │                     │                     │
  ├─── GET /api ───────>│                     │
  │<─── 402 + Payment ──┤                     │
  │      Requirements    │                     │
  │                     │                     │
  ├─ Check Reputation ──┼─────────────────────>│
  │<─── Score ───────────┼─────────────────────┤
  │                     │                     │
  ├─ Init Payment ──────┼─────────────────────>│
  │<─── Escrow PDA ──────┼─────────────────────┤
  │                     │                     │
  ├─ Retry w/ X-PAYMENT>│                     │
  │                     ├─ Fulfill ───────────>│
  │<─── 200 OK + Trace ─┤                     │
  │      Signature       │                     │
  │                     │                     │
  ├─ Verify Trace ──────┘                     │
  │                                           │
  └─ Settle (after SLA)────────────────────────>│
                                              │
                                        Updates
                                      Reputation
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+
- Solana CLI (optional, for on-chain mode)

### Installation & Run

```bash
# Install dependencies
pnpm install

# Build contracts (generates IDL files)
cd contracts && anchor build && cd ..

# Start server + dashboard
pnpm dev
```

The dashboard will be available at **http://localhost:5173**
The API server will be available at **http://localhost:3000**

### Run Demos

```bash
# New terminal - run conformance tests
pnpm conf http://localhost:3000/api/good

# Try different payment flows
pnpm demo:good      # Successful payment
pnpm demo:bad       # Disputed payment
pnpm demo:stream    # Streaming payment with partial releases
```

---

## 🎮 Dashboard Features

Visit the dashboard to:

- **View Services** - See all providers with reputation scores, bond status, and P95 latency
- **Monitor Calls** - Track payment flows with transaction links and outcomes
- **Verify Traces** - Interactive Ed25519 signature verification
- **Inspect Streams** - Timeline visualization for incremental payments
- **Test Endpoints** - Built-in playground for trying different flows
- **Run Conformance** - Validate x402 spec compliance

---

## 📚 Documentation

Comprehensive guides available in `/docs`:

- **[OVERVIEW.md](docs/OVERVIEW.md)** - Project overview and motivation
- **[SPEC.md](docs/SPEC.md)** - Complete technical specification
- **[CONTRACTS.md](docs/CONTRACTS.md)** - Solana program documentation
- **[SERVER.md](docs/SERVER.md)** - API server and endpoints
- **[SDK.md](docs/SDK.md)** - Client SDK usage and examples
- **[CLI.md](docs/CLI.md)** - Command-line tools
- **[DEMO.md](docs/DEMO.md)** - Demo flows and use cases

---

## 🔧 Configuration

### Environment Variables

```bash
# Settlement mode: mock (default) or onchain
ASSURED_MODE=mock

# Solana RPC endpoint
ASSURED_RPC=https://api.devnet.solana.com

# Network identifier
ASSURED_NETWORK=solana-devnet

# Price and currency
ASSURED_PRICE=0.001
ASSURED_CURRENCY=USDC

# Provider recipient address
ASSURED_RECIPIENT=CTdyT6ZctmsuPhkJrfcvQgAe95uPS45aXErGLKAhAZAA

# Webhook secret for HMAC verification
ASSURED_WEBHOOK_SECRET=your-secret-here
```

See [docs/SERVER.md](docs/SERVER.md) for full configuration details.

---

## 📦 SDK Usage

```typescript
import { Assured402Client, balanced } from 'x402-assured/sdk';
import { Connection, Keypair } from '@solana/web3.js';

const client = new Assured402Client({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: loadWallet(),
  escrowProgramId: '...',
  policy: balanced() // minReputation: 0.6, maxPrice: 0.05
});

// Make a payment-required request with automatic policy enforcement
const response = await client.fetch('http://provider.com/api/compute');
const data = await response.json();

// SDK automatically:
// - Checks provider reputation & p95 latency
// - Verifies bond status if required
// - Handles payment via escrow
// - Validates trace signatures
// - Routes to mirrors on failure
```

---

## 🧪 Testing

```bash
# TypeScript compilation check
pnpm tsc --noEmit

# Run contract tests (Rust)
cd contracts && cargo test

# Conformance testing
pnpm conf http://localhost:3000/api/good
pnpm conf http://localhost:3000/api/bad
pnpm conf http://localhost:3000/api/good_stream
```

---

## 🛠️ Technology Stack

- **Blockchain:** Solana (Devnet)
- **Smart Contracts:** Anchor Framework (Rust)
- **Backend:** Fastify (TypeScript)
- **Frontend:** React + Vite + Tailwind CSS
- **SDK:** TypeScript with Solana Web3.js
- **Cryptography:** TweetNaCl (Ed25519)

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

---

## 🤝 Contributing

This project was built for the Solana x402 Hackathon. Contributions, issues, and feature requests are welcome!

---

## 🔗 Links

- **Live Demo:** [https://x402-assured.vercel.app](https://x402-assured.vercel.app)
- **Solana Explorer (Devnet):** [View Contracts](https://solscan.io/account/6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL?cluster=devnet)
- **x402 Spec:** [HTTP 402 Payment Required Protocol](https://github.com/getAlby/402)

---

**Built with ❤️ for the Solana x402 Hackathon**
