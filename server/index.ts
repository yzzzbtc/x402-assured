// server/index.ts — Fastify x402-Assured demo server
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createHash, createHmac } from 'crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor';
import BN from 'bn.js/lib/bn.js';

import escrowIdlJson from '../contracts/escrow/target/idl/escrow.json' assert { type: 'json' };

type ServiceKind = 'good' | 'bad';

type PaymentRequirements = {
  price: string;
  currency: string;
  network: string;
  recipient: string;
  assured: {
    serviceId: string;
    slaMs: number;
    disputeWindowS: number;
    escrowProgram: string;
    altService?: string;
    sigAlg: 'ed25519';
  };
};

type PaymentReceipt = {
  callId: string;
  txSig?: string;
  headerValue?: string;
};

type SettlementRequest = {
  callId: string;
  txSig?: string;
  responseHash: Uint8Array;
  deliveredAt: number;
};

interface SettlementManager {
  mode: 'mock' | 'onchain';
  fulfill(req: SettlementRequest): Promise<void>;
}

interface ServerConfig {
  price: string;
  currency: string;
  network: string;
  recipient: string;
  escrowProgramId: string;
  altService?: string;
  sla: Record<ServiceKind, number>;
  disputeWindow: number;
  serviceIds: Record<ServiceKind, string>;
  webhookSecret?: string;
  settlementMode: 'mock' | 'onchain';
  providerKeypairPath?: string;
  rpcEndpoint: string;
}

const fastify = Fastify({ logger: true });
const config = loadConfig();
const settlementManager = createSettlementManager(config, fastify);
const seenFulfillments = new Set<string>();

await fastify.register(fastifyRawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true,
});

fastify.get('/api/good', async (req, reply) => {
  const receipt = extractReceipt(req.headers['x-payment']);
  if (!receipt) {
    return reply.code(402).send(paymentRequirements('good'));
  }

  const payload = { ok: true, data: { hello: 'world' } };

  try {
    const header = await finalizeSettlement('good', receipt, payload);
    reply.header('x-payment-response', header);
    return payload;
  } catch (err) {
    req.log.error({ err, receipt }, 'failed to fulfill escrow call');
    return reply.code(502).send({ ok: false, error: 'FULFILL_FAILED' });
  }
});

fastify.get('/api/bad', async (req, reply) => {
  const receipt = extractReceipt(req.headers['x-payment']);
  if (!receipt) {
    return reply.code(402).send(paymentRequirements('bad'));
  }

  // Simulate an SLA miss by stalling beyond the advertised SLA window
  await sleep(config.sla.bad + 1000);
  return reply.code(503).send({ ok: false, error: 'SLA_MISSED' });
});

fastify.post('/webhook/settlement', { config: { rawBody: true } }, async (req, reply) => {
  const raw = (req as typeof req & { rawBody?: string }).rawBody ?? '';
  if (config.webhookSecret) {
    const provided = req.headers['x-assured-signature'];
    const expected = createHmac('sha256', config.webhookSecret)
      .update(raw)
      .digest('hex');
    if (provided !== expected) {
      req.log.warn('invalid webhook signature');
      return reply.code(401).send({ ok: false, error: 'INVALID_SIGNATURE' });
    }
  }

  req.log.info({ settlement: req.body }, 'settlement webhook received');
  return { ok: true };
});

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

fastify
  .listen({ port: PORT, host: HOST })
  .then(() => {
    fastify.log.info({ port: PORT }, 'x402 assured server listening');
  })
  .catch((err) => {
    fastify.log.error(err, 'failed to start server');
    process.exit(1);
  });

function paymentRequirements(kind: ServiceKind): PaymentRequirements {
  return {
    price: config.price,
    currency: config.currency,
    network: config.network,
    recipient: config.recipient,
    assured: {
      serviceId: config.serviceIds[kind],
      slaMs: config.sla[kind],
      disputeWindowS: config.disputeWindow,
      escrowProgram: config.escrowProgramId,
      altService: config.altService,
      sigAlg: 'ed25519',
    },
  };
}

function loadConfig(): ServerConfig {
  const home = process.env.HOME ?? '';
  const providerPath = process.env.ASSURED_PROVIDER_KEYPAIR
    ? expandPath(process.env.ASSURED_PROVIDER_KEYPAIR, home)
    : resolve(home, '.config/solana/id.json');

  const settlementMode = (process.env.ASSURED_MODE as 'mock' | 'onchain') ?? 'mock';

  return {
    price: process.env.ASSURED_PRICE ?? '0.001',
    currency: process.env.ASSURED_CURRENCY ?? 'USDC',
    network: process.env.ASSURED_NETWORK ?? 'solana-devnet',
    recipient:
      process.env.ASSURED_RECIPIENT ?? 'CTdyT6ZctmsuPhkJrfcvQgAe95uPS45aXErGLKAhAZAA',
    escrowProgramId:
      process.env.ASSURED_ESCROW_PROGRAM_ID ?? '6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL',
    altService: process.env.ASSURED_ALT_SERVICE ?? 'http://localhost:3000/api/good_mirror',
    sla: {
      good: Number(process.env.ASSURED_GOOD_SLA ?? '2000'),
      bad: Number(process.env.ASSURED_BAD_SLA ?? '1000'),
    },
    disputeWindow: Number(process.env.ASSURED_DISPUTE_WINDOW ?? '10'),
    serviceIds: {
      good: process.env.ASSURED_GOOD_SERVICE_ID ?? 'demo:good',
      bad: process.env.ASSURED_BAD_SERVICE_ID ?? 'demo:bad',
    },
    webhookSecret: process.env.ASSURED_WEBHOOK_SECRET,
    settlementMode,
    providerKeypairPath: providerPath,
    rpcEndpoint: process.env.ASSURED_RPC ?? 'https://api.devnet.solana.com',
  };
}

function expandPath(p: string, home: string): string {
  if (p.startsWith('~')) {
    return resolve(home, p.slice(1));
  }
  return resolve(p);
}

function extractReceipt(header: unknown): PaymentReceipt | null {
  if (typeof header !== 'string') {
    return null;
  }
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (typeof parsed.callId !== 'string' || parsed.callId.length === 0) {
      return null;
    }
    return parsed as PaymentReceipt;
  } catch {
    return null;
  }
}

async function finalizeSettlement(
  _kind: ServiceKind,
  receipt: PaymentReceipt,
  payload: Record<string, unknown>
): Promise<string> {
  const responseJson = JSON.stringify(payload);
  const responseHash = createHash('sha256').update(responseJson).digest();
  const deliveredAt = Date.now();

  if (!seenFulfillments.has(receipt.callId)) {
    await settlementManager.fulfill({
      callId: receipt.callId,
      txSig: receipt.txSig,
      responseHash: new Uint8Array(responseHash),
      deliveredAt,
    });
    seenFulfillments.add(receipt.callId);
  }

  return encodeResponseHeader({
    callId: receipt.callId,
    responseHash: Buffer.from(responseHash).toString('hex'),
    fulfilledAt: deliveredAt,
    mode: settlementManager.mode,
  });
}

function encodeResponseHeader(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSettlementManager(cfg: ServerConfig, instance: FastifyInstance): SettlementManager {
  const log = instance.log;

  if (cfg.settlementMode !== 'onchain') {
    log.info('assured settlement running in mock mode');
    return {
      mode: 'mock',
      async fulfill(req) {
        log.info({ callId: req.callId }, 'mock fulfill');
      },
    };
  }

  const keypair = loadKeypair(cfg.providerKeypairPath);
  if (!keypair) {
    log.warn(
      { path: cfg.providerKeypairPath },
      'unable to load provider keypair, falling back to mock mode'
    );
    return {
      mode: 'mock',
      async fulfill(req) {
        log.info({ callId: req.callId }, 'mock fulfill');
      },
    };
  }

  const connection = new Connection(cfg.rpcEndpoint, 'confirmed');
  const wallet = createWallet(keypair);
  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  const programId = new PublicKey(cfg.escrowProgramId);
  const idl = escrowIdlJson as Idl;
  const program = new Program(idl, programId, provider);

  log.info({ programId: programId.toBase58() }, 'assured settlement running in on-chain mode');

  return {
    mode: 'onchain',
    async fulfill(req) {
      const [escrowCall] = PublicKey.findProgramAddressSync(
        [Buffer.from('call'), Buffer.from(req.callId)],
        programId
      );
      const ts = new BN(Math.floor(req.deliveredAt / 1000));
      const responseHashArray = Array.from(req.responseHash);
      const providerSig = req.txSig ? Buffer.from(req.txSig, 'utf8') : Buffer.alloc(0);

      await program.methods
        .fulfill(responseHashArray, ts, Array.from(providerSig))
        .accounts({
          escrowCall,
          provider: keypair.publicKey,
        })
        .signers([keypair])
        .rpc();
    },
  };
}

function loadKeypair(maybePath?: string): Keypair | null {
  if (!maybePath) return null;
  try {
    if (existsSync(maybePath)) {
      const secret = JSON.parse(readFileSync(maybePath, 'utf8')) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    }

    const parsed = JSON.parse(maybePath);
    if (Array.isArray(parsed)) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
  } catch (err) {
    fastify.log.warn({ err }, 'failed to load keypair from path or inline array');
  }
  return null;
}

function createWallet(keypair: Keypair) {
  return {
    publicKey: keypair.publicKey,
    async signTransaction(tx: any) {
      tx.partialSign(keypair);
      return tx;
    },
    async signAllTransactions(txs: any[]) {
      return txs.map((tx) => {
        tx.partialSign(keypair);
        return tx;
      });
    },
  };
}
