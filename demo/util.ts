import {
  Assured402Client,
  type Policy,
} from '../sdk/ts/index.ts';
import type {
  Facilitator,
  PaymentProof,
  PaymentRequirements,
} from '../sdk/ts/facilitators.ts';

export class DemoFacilitator implements Facilitator {
  name: 'native' = 'native';
  private proof?: PaymentProof;

  async verifyPayment(req: PaymentRequirements): Promise<PaymentProof> {
    const serviceId = req.assured?.serviceId ?? 'unknown';
    const callId = `demo:${serviceId}:${Date.now().toString(36)}`;
    const txSig = `mock-${Math.random().toString(36).slice(2, 11)}`;
    const headerValue = Buffer.from(
      JSON.stringify({ callId, txSig, facilitator: this.name, ts: Date.now() }),
      'utf8'
    ).toString('base64');
    const proof = { callId, txSig, headerValue };
    this.proof = proof;
    return proof;
  }

  async settle(): Promise<void> {}

  lastProof(): PaymentProof | undefined {
    return this.proof;
  }
}

export function createDemoClient(policy: Policy) {
  const facilitator = new DemoFacilitator();
  const client = new Assured402Client({ facilitator, policy });
  return { client, facilitator };
}

export function decodeHeader(header: string | null) {
  if (!header) return null;
  try {
    const json = Buffer.from(header, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
