#!/usr/bin/env -S node --import tsx/esm
import { balanced } from '../sdk/ts/index.ts';

import { createDemoClient, decodeHeader } from './util.ts';

const URL = process.env.ASSURED_GOOD_URL ?? 'http://localhost:3000/api/good';

async function main() {
  const { client, facilitator } = createDemoClient(balanced());
  const response = await client.fetch(URL);
  const proof = facilitator.lastProof();

  if (!proof) {
    console.log('No payment required; service returned', response.status);
    return;
  }

  console.log(`GOOD callId ${proof.callId}`);
  console.log(`txSig ${proof.txSig}`);

  const body = await response.json();
  console.log('Response', JSON.stringify(body, null, 2));

  const header = decodeHeader(response.headers.get('x-payment-response'));
  if (header) {
    console.log('Settlement', header);
  }
}

main().catch((err) => {
  console.error('good-demo failed', err);
  process.exitCode = 1;
});
