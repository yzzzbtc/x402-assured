# DEMO (≤3 minutes)

**Hook (0:00–0:10)** — “x402‑Assured — Safe payments for agents.”  
**Problem (0:10–0:30)** — x402 lacks recourse/reputation; we add it.

**Good path (0:30–1:05)**
```bash
pnpm dev
pnpm conf http://localhost:3000/api/good
node demo/good-demo.ts
```

**Bad path (1:05–1:45)**
```bash
node demo/bad-demo.ts
```

**Fallback routing (1:45–2:15)**
```bash
node demo/fallback-demo.ts
```

**Wrap (2:15–3:00)** — Open source, devnet, spec‑compatible, adapters.
