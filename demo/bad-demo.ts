#!/usr/bin/env -S node --import tsx/esm
import { balanced } from '../sdk/ts/index.ts';

import { createDemoClient, decodeHeader } from './util.ts';

const URL = process.env.ASSURED_BAD_URL ?? 'http://localhost:3000/api/bad';

async function main() {
  const { client, facilitator } = createDemoClient(balanced());
  const response = await client.fetch(URL);
  const proof = facilitator.lastProof();

  if (proof) {
    console.log(`BAD callId ${proof.callId}`);
    console.log(`txSig ${proof.txSig}`);
  }

  const body = await readBody(response);
  console.log('Outcome status', response.status);
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
  console.error('bad-demo failed', err);
  process.exitCode = 1;
});
