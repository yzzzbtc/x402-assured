// sdk/ts/facilitators.ts
import { randomBytes } from 'crypto';

import type { Idl, Wallet } from '@coral-xyz/anchor';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import BN from 'bn.js/lib/bn.js';
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const escrowIdlJson = require('../../idl/escrow.json') as Idl;
// Strip accounts field for Anchor 0.30+ compatibility
const escrowIdl = { ...escrowIdlJson, accounts: [] } as Idl;

export type PaymentRequirements = {
  price: string;
  currency: string;
  network: string;
  recipient: string;
  assured?: {
    serviceId: string;
    slaMs: number;
    disputeWindowS: number;
    escrowProgram: string;
    altService?: string;
    sigAlg?: 'ed25519';
    stream?: boolean;
    totalUnits?: number;
    reputationProgram?: string;
    mirrors?: { url: string; sig: string }[];
    hasBond?: boolean;
    bondBalance?: string;
    slaP95Ms?: number;
  };
};

export type PaymentProof = {
  callId: string;
  txSig: string;
  headerValue: string;
};

export interface Facilitator {
  name: 'native' | 'coinbase' | 'corbits';
  verifyPayment(req: PaymentRequirements): Promise<PaymentProof>;
  settle?(proof: PaymentProof): Promise<void>;
}

type NativeFacilitatorParams = {
  connection: Connection;
  wallet: Wallet;
  escrowProgramId: string;
};

export function nativeFacilitator({ connection, wallet, escrowProgramId }: NativeFacilitatorParams): Facilitator {
  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  const programId = new PublicKey(escrowProgramId);
  const program = new (Program as any)(escrowIdl, programId, provider);

  return {
    name: 'native',
    async verifyPayment(req) {
      const assured = req.assured;
      if (!assured) {
        throw new Error('Assured namespace is required for native facilitator payments');
      }
      if (assured.escrowProgram && assured.escrowProgram !== programId.toBase58()) {
        throw new Error('Escrow program mismatch between client configuration and server requirements');
      }

      const callId = generateCallId(assured.serviceId);
      const [escrowCall] = PublicKey.findProgramAddressSync(
        [Buffer.from('call'), Buffer.from(callId)],
        programId
      );

      const amount = toLamportsBN(req.price);
      const slaMs = new BN(assured.slaMs ?? 0);
      const disputeWindow = new BN(assured.disputeWindowS ?? 0);
      const providerKey = new PublicKey(req.recipient);
      const totalUnits = new BN(Math.max(1, assured.totalUnits ?? 1));

      const txSig = await program.methods
        .initPayment(callId, assured.serviceId, amount, slaMs, disputeWindow, totalUnits)
        .accounts({
          escrowCall,
          payer: wallet.publicKey,
          provider: providerKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const headerValue = encodePaymentHeader({ callId, txSig, facilitator: 'native' });

      return { callId, txSig, headerValue };
    },
    async settle(_proof) {
      // Native facilitator leaves settlement to the provider webhook.
    },
  };
}

function generateCallId(serviceId: string): string {
  const suffix = randomBytes(6).toString('hex');
  return `${serviceId}:${Date.now().toString(36)}:${suffix}`;
}

function encodePaymentHeader(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
}

function toLamportsBN(price: string): BN {
  const trimmed = price.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    throw new Error(`Invalid price format: ${price}`);
  }
  const [wholeRaw, fracRaw = ''] = trimmed.split('.');
  const whole = BigInt(wholeRaw || '0');
  const fractionPadded = `${fracRaw}000000000`.slice(0, 9);
  const frac = BigInt(fractionPadded);
  const lamports = whole * BigInt(LAMPORTS_PER_SOL) + frac;
  return new BN(lamports.toString());
}

export function coinbaseFacilitator(_: { baseUrl: string; apiKey?: string }) : Facilitator {
  return {
    name: 'coinbase',
    async verifyPayment(req) {
      // TODO: call Coinbase facilitator
      return { callId: 'CB_'+Date.now(), txSig: 'TODO', headerValue: 'TODO' };
    }
  };
}

export function corbitsFacilitator(_: { baseUrl: string; apiKey?: string }) : Facilitator {
  return {
    name: 'corbits',
    async verifyPayment(req) {
      // TODO: call Corbits facilitator
      return { callId: 'CO_'+Date.now(), txSig: 'TODO', headerValue: 'TODO' };
    }
  };
}
