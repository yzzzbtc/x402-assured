# x402-Assured

**SLA escrow + disputes + on-chain reputation for x402 on Solana.**

Make agent payments safe by default. x402‑Assured routes each 402 payment through a minimal Solana escrow, releases only when SLA is met and no dispute is raised, and writes outcomes to a public reputation registry that other agents can query before paying.

## Quickstart (devnet)

```bash
# one-time: build + deploy programs (IDs from Anchor.toml)
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor build && anchor deploy --provider.cluster devnet

# app dependencies
pnpm install

# run the Fastify server in one shell
pnpm dev

# in another shell: spec conformance + demos
pnpm conf http://localhost:3000/api/good
node demo/good-demo.ts
node demo/bad-demo.ts
node demo/fallback-demo.ts
```

Environment knobs (`ASSURED_*`) and settlement modes are documented in [docs/SERVER.md](docs/SERVER.md).

More: [OVERVIEW](docs/OVERVIEW.md) · [PLAN](docs/PLAN.md) · [SPEC](docs/SPEC.md) · [CONTRACTS](docs/CONTRACTS.md) · [SERVER](docs/SERVER.md) · [SDK](docs/SDK.md) · [CLI](docs/CLI.md) · [DEMO](docs/DEMO.md)
