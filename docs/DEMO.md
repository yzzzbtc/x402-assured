# DEMO (≤3 minutes)

## Structure

### Hook (0:00–0:10)
Slide: “x402‑Assured — Safe payments for agents (escrow + disputes + reputation)”.

### Problem framing (0:10–0:30)
Narration over diagram: “Plain x402 wires funds instantly but has no recourse. Assured keeps the 402 spec, adds escrow + disputes + shared reputation.”

### UI walkthrough (0:30–1:45)
Screen record the dashboard at `http://localhost:5173` while `pnpm dev` is running.

1. Highlight the header copy (“Spec-compatible. Devnet live.”) and the program ID badges.
2. Scroll through the Services table — point at score badges (green/amber/red) and OK/Late/Disputed counts.
3. Show the Recent Calls list, click the latest entry to open the Transcript drawer; copy the `X-PAYMENT` header and point at explorer links + response hash.
4. Click **Call Good** → wait for the toast/log line, watch the Services + Recent panels update live.
5. Click **Call Bad** → emphasize the refunded outcome and evidence chip (“SLA_MISSED”).
6. Click **Call Fallback** → explain alt-service handoff and show new transcript with fallback evidence.
7. Expand the **Playground** panel → run a strict policy against `/api/bad` to show the refusal before payment.
8. Run the **Conformance Tester** against `/api/good` → narrate each check badge turning green.

![UI walkthrough](img/demo-ui.png)

### Terminal flows (1:45–2:35)
Capture a terminal window next to the dashboard.

```bash
# verify spec compliance
pnpm conf http://localhost:3000/api/good

# run scripted demos (good path, SLA miss/dispute, fallback)
node demo/good-demo.ts
node demo/bad-demo.ts
node demo/fallback-demo.ts
```

Call out the emitted call IDs and settlement headers, relate them to the dashboard entries.

### Wrap (2:35–3:00)
Return to the dashboard header or slide.

- Reinforce “Escrow · Disputes · Reputation” bullets.
- Mention adapters (native / Coinbase / Corbits) and on-chain mode toggle.
- Prompt to clone + `pnpm dev` for a one-command boot.
