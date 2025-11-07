#!/usr/bin/env -S node --import tsx/esm
import { balanced, cheap } from '../sdk/ts/index.ts';

import { createDemoClient, decodeHeader } from './util.ts';

const URL = process.env.ASSURED_FALLBACK_URL ?? 'http://localhost:3000/api/good';

async function main() {
  const initial = await fetch(URL);
  if (initial.status !== 402) {
    console.log('Primary service responded directly', initial.status);
    return;
  }
  const requirements = await initial.json();
  const assured = requirements.assured ?? {};

  const strictPolicy = { ...balanced(), maxPrice: 0.0005 };
  const { client: strictClient } = createDemoClient(strictPolicy);

  try {
    await strictClient.fetch(URL);
    console.log('Strict policy allowed primary service; fallback not triggered');
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('Primary policy refused payment:', message);
  }

  const fallbackUrl = typeof assured.altService === 'string' ? assured.altService : URL;
  console.log(`Falling back to ${fallbackUrl}`);

  const { client: fallbackClient, facilitator: fallbackFac } = createDemoClient(cheap());
  const response = await fallbackClient.fetch(fallbackUrl);
  const proof = fallbackFac.lastProof();
  if (proof) {
    console.log(`FALLBACK callId ${proof.callId}`);
    console.log(`txSig ${proof.txSig}`);
  } else {
    console.log('Fallback service returned without requiring payment');
  }

  const body = await readBody(response);
  console.log('Fallback status', response.status);
  if (body) {
    console.log('Body', JSON.stringify(body, null, 2));
  }

  const header = decodeHeader(response.headers.get('x-payment-response'));
  if (header) {
    console.log('Settlement', header);
  }
}

async function readBody(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

main().catch((err) => {
  console.error('fallback-demo failed', err);
  process.exitCode = 1;
});
