// sdk/ts/index.ts
import type { Idl, Wallet, Program as AnchorProgram } from '@coral-xyz/anchor';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const reputationIdlJson = require('../../contracts/reputation/target/idl/reputation.json') as Idl;

import type { Facilitator, PaymentRequirements } from './facilitators.ts';
import { nativeFacilitator } from './facilitators.ts';

type ClientEventMap = {
  partialRelease: { index: number; totalUnits: number };
  finalSettle: { callId: string };
};

type ClientEventName = keyof ClientEventMap;

export type Policy = {
  minReputation: number;
  maxPrice: number;
  requireSLA: boolean;
  slaP95MaxMs?: number;
};

export type PolicyOverride = Partial<Policy>;

export type Assured402ClientOptions = {
  connection?: Connection;
  wallet?: Wallet;
  escrowProgramId?: string;
  reputationProgramId?: string;
  reputationConnection?: Connection;
  facilitator?: Facilitator;
  policy?: Policy;
};

const DEFAULT_REPUTATION_PROGRAM_ID = '8QFXHzWC1hDC7GQTNqBhsVRLURpYfXFBzT5Vb4NTxDh5';

export const strict = (): Policy => ({ minReputation: 0.8, maxPrice: 0.02, requireSLA: true });
export const balanced = (): Policy => ({ minReputation: 0.6, maxPrice: 0.05, requireSLA: true });
export const cheap = (): Policy => ({ minReputation: 0.4, maxPrice: 0.01, requireSLA: false });

export class Assured402Client {
  private facilitatorInstance?: Facilitator;
  private reputationProgram?: AnchorProgram;
  private readOnlyWallet?: Wallet;
  private opts: Assured402ClientOptions;
  private listeners: Map<ClientEventName, Set<(payload: any) => void>> = new Map();
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(opts: Assured402ClientOptions = {}) {
    this.opts = opts;
  }

  async fetch(url: string, overridePolicy?: PolicyOverride): Promise<Response> {
    const policy = this.resolvePolicy(overridePolicy);
    const first = await fetch(url);
    if (first.status !== 402) {
      return first;
    }

    const requirements: PaymentRequirements = await first.json();
    this.validateRequirements(requirements);
    await this.enforcePolicy(requirements, policy);

    const proof = await this.facilitator.verifyPayment(requirements);
    return fetch(url, { headers: { 'X-PAYMENT': proof.headerValue } });
  }

  private get facilitator(): Facilitator {
    if (!this.facilitatorInstance) {
      if (this.opts.facilitator) {
        this.facilitatorInstance = this.opts.facilitator;
      } else if (this.opts.connection && this.opts.wallet && this.opts.escrowProgramId) {
        this.facilitatorInstance = nativeFacilitator({
          connection: this.opts.connection,
          wallet: this.opts.wallet,
          escrowProgramId: this.opts.escrowProgramId,
        });
      } else {
        throw new Error(
          'Facilitator not provided and insufficient configuration to construct native facilitator'
        );
      }
    }
    return this.facilitatorInstance;
  }

  private resolvePolicy(overridePolicy?: PolicyOverride): Policy {
    const base = { ...balanced(), ...(this.opts.policy ?? {}) };
    return { ...base, ...(overridePolicy ?? {}) };
  }

  private validateRequirements(req: PaymentRequirements): void {
    if (!req.assured) {
      throw new Error('Server response missing assured namespace; cannot proceed');
    }
    if (!req.assured.serviceId) {
      throw new Error('PaymentRequirements.assured.serviceId missing');
    }
    if (!req.recipient) {
      throw new Error('PaymentRequirements.recipient missing');
    }
  }

  private async enforcePolicy(req: PaymentRequirements, policy: Policy): Promise<void> {
    const assured = req.assured!;
    const price = Number(req.price);
    if (!Number.isFinite(price)) {
      throw new Error(`Invalid price in payment requirements: ${req.price}`);
    }
    if (price > policy.maxPrice) {
      throw new Error(
        `Quoted price ${price} exceeds policy maximum ${policy.maxPrice}`
      );
    }

    if (policy.requireSLA && (!assured.slaMs || assured.slaMs <= 0)) {
      throw new Error('Policy requires SLA but server did not advertise one');
    }

    if (policy.minReputation > 0) {
      const score = await this.getReputationScore(assured.serviceId);
      if (score !== null && score < policy.minReputation) {
        throw new Error(
          `Service reputation ${score.toFixed(2)} below required minimum ${policy.minReputation}`
        );
      }
    }

    // Enforce p95 latency maximum if policy specifies
    if (policy.slaP95MaxMs && policy.slaP95MaxMs > 0) {
      const p95 = await this.getServiceP95(assured.serviceId);
      if (p95 !== null && p95 > policy.slaP95MaxMs) {
        throw new Error(
          `Service p95 latency ${p95}ms exceeds policy maximum ${policy.slaP95MaxMs}ms`
        );
      }
    }
  }

  private async getReputationScore(serviceId: string): Promise<number | null> {
    const program = this.getReputationProgram();
    if (!program) {
      return null;
    }
    const [servicePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('svc'), Buffer.from(serviceId)],
      program.programId
    );
    try {
      const account = await (program.account as any).service.fetch(servicePda);
      const ok = Number(account.ok ?? 0);
      const late = Number(account.late ?? 0);
      const disputed = Number(account.disputed ?? 0);
      const total = ok + late + disputed;
      if (total <= 0) {
        return 1;
      }
      return ok / total;
    } catch (err) {
      if (isAccountMissingError(err)) {
        return 1;
      }
      throw err;
    }
  }

  private async getServiceP95(serviceId: string): Promise<number | null> {
    const program = this.getReputationProgram();
    if (!program) {
      return null;
    }
    const [servicePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('svc'), Buffer.from(serviceId)],
      program.programId
    );
    try {
      const account = await (program.account as any).service.fetch(servicePda);
      const p95 = Number(account.p95EstMs ?? 0);
      return p95 > 0 ? p95 : null;
    } catch (err) {
      if (isAccountMissingError(err)) {
        return null;
      }
      throw err;
    }
  }

  private getReputationProgram(): AnchorProgram | null {
    if (this.reputationProgram) {
      return this.reputationProgram;
    }
    const connection = this.opts.reputationConnection ?? this.opts.connection;
    if (!connection) {
      return null;
    }
    const programId = new PublicKey(this.opts.reputationProgramId ?? DEFAULT_REPUTATION_PROGRAM_ID);
    const provider = new AnchorProvider(connection, this.getReadOnlyWallet(), AnchorProvider.defaultOptions());
    this.reputationProgram = new (Program as any)(reputationIdlJson, programId, provider);
    return this.reputationProgram;
  }

  private getReadOnlyWallet(): Wallet {
    if (this.opts.wallet) {
      return this.opts.wallet;
    }
    if (!this.readOnlyWallet) {
      const kp = Keypair.generate();
      this.readOnlyWallet = {
        publicKey: kp.publicKey,
        payer: kp,
        async signTransaction(tx) {
          return tx;
        },
        async signAllTransactions(txs) {
          return txs;
        },
      } as Wallet;
    }
    return this.readOnlyWallet;
  }

  on<K extends ClientEventName>(event: K, handler: (payload: ClientEventMap[K]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off<K extends ClientEventName>(event: K, handler: (payload: ClientEventMap[K]) => void): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  private emit<K extends ClientEventName>(event: K, payload: ClientEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`Error in ${event} event handler:`, err);
        }
      }
    }
  }
}

/**
 * Verify a trace signature from the server
 * @param callId The call ID
 * @param responseHashHex The response hash in hex format
 * @param deliveredAt The delivery timestamp
 * @param signature The base64-encoded signature
 * @param signerPublicKey The signer's public key (base58 string)
 * @returns true if signature is valid
 */
export function verifyTrace(
  callId: string,
  responseHashHex: string,
  deliveredAt: number,
  signature: string,
  signerPublicKey: string
): boolean {
  try {
    const message = buildTraceMessage(callId, responseHashHex, deliveredAt);
    const sigBytes = Buffer.from(signature, 'base64');
    const pubkey = new PublicKey(signerPublicKey);
    const pubkeyBytes = pubkey.toBytes();
    return nacl.sign.detached.verify(message, sigBytes, pubkeyBytes);
  } catch (err) {
    console.error('verifyTrace error:', err);
    return false;
  }
}

/**
 * Verify a mirror signature
 * @param serviceId The service ID
 * @param url The mirror URL
 * @param signature The base64-encoded signature
 * @param signerPublicKey The signer's public key (base58 string)
 * @returns true if signature is valid
 */
export function verifyMirrorSig(
  serviceId: string,
  url: string,
  signature: string,
  signerPublicKey: string
): boolean {
  try {
    const message = buildMirrorMessage(serviceId, url);
    const sigBytes = Buffer.from(signature, 'base64');
    const pubkey = new PublicKey(signerPublicKey);
    const pubkeyBytes = pubkey.toBytes();
    return nacl.sign.detached.verify(message, sigBytes, pubkeyBytes);
  } catch (err) {
    console.error('verifyMirrorSig error:', err);
    return false;
  }
}

function buildTraceMessage(callId: string, responseHashHex: string, deliveredAt: number): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`assured-trace|${callId}|${responseHashHex}|${deliveredAt}`);
}

function buildMirrorMessage(serviceId: string, url: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`assured-mirror|${serviceId}|${url}`);
}

function isAccountMissingError(err: unknown): boolean {
  if (!err) return false;
  const message = typeof err === 'string' ? err : (err as Error).message ?? '';
  return message.includes('Account does not exist') || message.includes('could not find account');
}
