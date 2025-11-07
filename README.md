# x402-Assured

**SLA escrow + disputes + on-chain reputation for x402 on Solana.**

Plain x402 wires funds instantly with no recourse. x402‑Assured routes every 402 payment through a Solana escrow, enforces SLAs with typed disputes, and writes outcomes to a shared reputation registry that other agents query before paying.

## Quickstart (devnet)

```bash
pnpm install

# run the Fastify server + dashboard
pnpm dev

# new terminal: spec checks + demos
pnpm conf http://localhost:3000/api/good
pnpm demo:good
pnpm demo:bad
```

Environment knobs (`ASSURED_*`) and settlement modes are documented in [docs/SERVER.md](docs/SERVER.md).

More: [OVERVIEW](docs/OVERVIEW.md) · [PLAN](docs/PLAN.md) · [SPEC](docs/SPEC.md) · [CONTRACTS](docs/CONTRACTS.md) · [SERVER](docs/SERVER.md) · [SDK](docs/SDK.md) · [CLI](docs/CLI.md) · [DEMO](docs/DEMO.md)
