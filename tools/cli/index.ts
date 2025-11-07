#!/usr/bin/env node
import { Command } from 'commander';
import assert from 'node:assert';
import Ajv from 'ajv';

import {
  Assured402Client,
  balanced,
  cheap,
  strict,
  type Policy,
} from '../../sdk/ts/index.ts';
import {
  type Facilitator,
  type PaymentProof,
  type PaymentRequirements,
} from '../../sdk/ts/facilitators.ts';

const program = new Command();
program.name('assured402').description('x402-Assured CLI & conformance tests');

const ajv = new Ajv({ allErrors: true, strict: false });
const validateRequirements = ajv.compile(paymentRequirementsSchema());

class CliMockFacilitator implements Facilitator {
  name: 'native' = 'native';
  private proof?: PaymentProof;

  async verifyPayment(req: PaymentRequirements): Promise<PaymentProof> {
    const serviceId = req.assured?.serviceId ?? 'unknown';
    const callId = `cli:${serviceId}:${Date.now().toString(36)}`;
    const txSig = `mock-${Math.random().toString(36).slice(2, 11)}`;
    const headerValue = Buffer.from(
      JSON.stringify({ callId, txSig, facilitator: this.name, ts: Date.now() }),
      'utf8'
    ).toString('base64');
    const proof = { callId, txSig, headerValue };
    this.proof = proof;
    return proof;
  }

  lastProof(): PaymentProof | undefined {
    return this.proof;
  }
}

program
  .command('conformance')
  .argument('<url>')
  .option('-p, --policy <preset>', 'strict|balanced|cheap', 'balanced')
  .action(async (url, options) => {
    try {
      const first = await fetch(url);
      assert.equal(first.status, 402, 'Expected HTTP 402 response');
      const body = await first.json() as PaymentRequirements;
      assert.ok(
        validateRequirements(body),
        ajv.errorsText(validateRequirements.errors, { separator: '\n' })
      );
      console.log('✓ 402 with PaymentRequirements');
      assert.ok(body.assured, 'Missing assured extension');
      console.log('✓ assured namespace present');

      const { client, facilitator } = createClient(options.policy);
      const settled = await client.fetch(url);
      assert.ok(settled.ok, `Expected 200 after payment, received ${settled.status}`);
      console.log('✓ retry with X-PAYMENT returned 200');

      const receipt = facilitator.lastProof();
      if (receipt) {
        console.log(`→ callId ${receipt.callId} (txSig ${receipt.txSig})`);
      }
      const paymentResponse = settled.headers.get('x-payment-response');
      if (paymentResponse) {
        const parsed = decodeBase64Json(paymentResponse);
        console.log(`→ settlement header confirms mode=${parsed.mode ?? 'mock'}`);
      }
    } catch (err) {
      console.error('✗ conformance failed');
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command('demo')
  .argument('<which>', 'good|bad')
  .option('-p, --policy <preset>', 'strict|balanced|cheap', 'balanced')
  .action(async (which, options) => {
    const url = resolveDemoUrl(which);
    const label = which.toUpperCase();
    const { client, facilitator } = createClient(options.policy);

    try {
      const response = await client.fetch(url);
      const payment = facilitator.lastProof();
      if (payment) {
        console.log(`${label} payment callId ${payment.callId}`);
        console.log(`txSig ${payment.txSig}`);
      }

      const body = await safeJson(response);
      if (response.ok) {
        console.log(`${label} outcome: released`);
        if (body) {
          console.log(JSON.stringify(body, null, 2));
        }
      } else {
        console.log(`${label} outcome: disputed/refund pending`);
        console.log(`HTTP ${response.status}`);
        if (body) {
          console.log(JSON.stringify(body, null, 2));
        }
      }
    } catch (err) {
      console.error(`✗ demo ${label.toLowerCase()} failed`);
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program.parseAsync();

function paymentRequirementsSchema() {
  return {
    type: 'object',
    required: ['price', 'currency', 'network', 'recipient', 'assured'],
    properties: {
      price: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' },
      currency: { type: 'string', minLength: 1 },
      network: { type: 'string', minLength: 1 },
      recipient: { type: 'string', minLength: 32 },
      assured: {
        type: 'object',
        required: ['serviceId', 'slaMs', 'disputeWindowS', 'escrowProgram', 'sigAlg'],
        properties: {
          serviceId: { type: 'string', minLength: 1 },
          slaMs: { type: 'integer', minimum: 1 },
          disputeWindowS: { type: 'integer', minimum: 1 },
          escrowProgram: { type: 'string', minLength: 32 },
          altService: { type: 'string' },
          sigAlg: { type: 'string', enum: ['ed25519'] },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  };
}

function createClient(preset: string): { client: Assured402Client; facilitator: CliMockFacilitator } {
  const policy = resolvePolicyPreset(preset);
  const facilitator = new CliMockFacilitator();
  const client = new Assured402Client({ facilitator, policy });
  return { client, facilitator };
}

function resolvePolicyPreset(preset: string): Policy {
  const key = (preset ?? 'balanced').toLowerCase();
  switch (key) {
    case 'strict':
      return strict();
    case 'cheap':
      return cheap();
    case 'balanced':
      return balanced();
    default:
      throw new Error(`Unknown policy preset: ${preset}`);
  }
}

function resolveDemoUrl(which: string): string {
  if (which === 'good') {
    return 'http://localhost:3000/api/good';
  }
  if (which === 'bad') {
    return 'http://localhost:3000/api/bad';
  }
  throw new Error(`Unknown demo variant: ${which}`);
}

function decodeBase64Json(header: string) {
  const json = Buffer.from(header, 'base64').toString('utf8');
  return JSON.parse(json);
}

async function safeJson(res: Response): Promise<any | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
