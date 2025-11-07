// server/index.ts — Fastify x402-Assured demo server
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createHash, createHmac } from 'crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor';
import BN from 'bn.js/lib/bn.js';

import { Assured402Client, balanced, cheap, type Policy } from '../sdk/ts/index.ts';
import type { Facilitator, PaymentProof } from '../sdk/ts/facilitators.ts';

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

type RunType = 'good' | 'bad' | 'fallback';

type RunRequestBody = {
  type: RunType;
  policy?: Partial<Policy>;
  url?: string;
};

interface SettlementManager {
  mode: 'mock' | 'onchain';
  fulfill(req: SettlementRequest): Promise<string | null>;
}

interface ServerConfig {
  price: string;
  currency: string;
  network: string;
  recipient: string;
  escrowProgramId: string;
  reputationProgramId: string;
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
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const SERVER_BASE_URL = process.env.ASSURED_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const settlementManager = createSettlementManager(config, fastify);
const seenFulfillments = new Set<string>();

type CallOutcome = 'PENDING' | 'RELEASED' | 'REFUNDED';

interface CallTranscript {
  callId: string;
  serviceId: string;
  startedAt: number;
  slaMs: number;
  disputeWindowS: number;
  paymentRequirements: PaymentRequirements;
  retryHeaders: Record<string, string>;
  responseHash?: string;
  programIds: { escrow: string; reputation: string };
  tx: { init: string | null; fulfill: string | null; settle: string | null };
  outcome: CallOutcome;
  evidence: Array<Record<string, unknown>>;
  scored: boolean;
}

type ServiceStats = {
  serviceId: string;
  ok: number;
  late: number;
  disputed: number;
};

type PendingRequirement = {
  serviceId: string;
  requirements: PaymentRequirements;
  startedAt: number;
};

const RECENT_LIMIT = 50;
const pendingRequirements = new Map<string, PendingRequirement[]>();
const callIndex = new Map<string, CallTranscript>();
const callHistory: CallTranscript[] = [];
const serviceStats = new Map<string, ServiceStats>();

ensureServiceStats(config.serviceIds.good);
ensureServiceStats(config.serviceIds.bad);

await fastify.register(fastifyRawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true,
});

fastify.get('/api/good', async (req, reply) => {
  const serviceId = config.serviceIds.good;
  const headerValue = typeof req.headers['x-payment'] === 'string' ? req.headers['x-payment'] : undefined;
  const receipt = extractReceipt(headerValue);
  if (!receipt) {
    const requirements = paymentRequirements('good');
    recordPaymentRequirement(requirements);
    return reply.code(402).send(requirements);
  }

  const payload = { ok: true, data: { hello: 'world' } };

  try {
    const header = await finalizeSettlement(serviceId, receipt, headerValue, payload);
    reply.header('x-payment-response', header);
    return payload;
  } catch (err) {
    req.log.error({ err, receipt }, 'failed to fulfill escrow call');
    return reply.code(502).send({ ok: false, error: 'FULFILL_FAILED' });
  }
});

fastify.get('/api/bad', async (req, reply) => {
  const serviceId = config.serviceIds.bad;
  const headerValue = typeof req.headers['x-payment'] === 'string' ? req.headers['x-payment'] : undefined;
  const receipt = extractReceipt(headerValue);
  if (!receipt) {
    const requirements = paymentRequirements('bad');
    recordPaymentRequirement(requirements);
    return reply.code(402).send(requirements);
  }

  const record = hydrateCallRecord(serviceId, receipt.callId, {
    headerValue,
    txSig: receipt.txSig,
  });

  // Simulate an SLA miss by stalling beyond the advertised SLA window
  await sleep(config.sla.bad + 1000);
  const payload = { ok: false, error: 'SLA_MISSED' } as const;
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  record.responseHash = hash;
  record.evidence.push({
    type: 'SLA_MISSED',
    expectedMs: config.sla.bad,
    actualMs: Date.now() - record.startedAt,
  });
  updateOutcome(record, 'REFUNDED');

  return reply.code(503).send(payload);
});

fastify.get('/api/good_mirror', async (req, reply) => {
  const serviceId = `${config.serviceIds.good}:mirror`;
  const headerValue = typeof req.headers['x-payment'] === 'string' ? req.headers['x-payment'] : undefined;
  const receipt = extractReceipt(headerValue);
  if (!receipt) {
    const base = paymentRequirements('good');
    const requirements: PaymentRequirements = {
      ...base,
      assured: {
        ...base.assured,
        serviceId,
      },
    };
    recordPaymentRequirement(requirements);
    return reply.code(402).send(requirements);
  }

  const payload = { ok: true, data: { hello: 'world', source: 'alt-service' } };

  try {
    const header = await finalizeSettlement(serviceId, receipt, headerValue, payload);
    reply.header('x-payment-response', header);
    return payload;
  } catch (err) {
    req.log.error({ err, receipt }, 'failed to fulfill escrow call (alt)');
    return reply.code(502).send({ ok: false, error: 'FULFILL_FAILED' });
  }
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

fastify.get('/summary', async (_req, reply) => {
  return reply.send(buildSummary());
});

fastify.get('/calls/:callId', async (req, reply) => {
  const { callId } = req.params as { callId: string };
  const record = callIndex.get(callId);
  if (!record) {
    return reply.code(404).send({ ok: false, error: 'NOT_FOUND', callId });
  }
  return reply.send(serializeCall(record));
});

fastify.post('/run', async (req, reply) => {
  const body = req.body as RunRequestBody | undefined;
  if (!body || !body.type) {
    return reply.code(400).send({ ok: false, error: 'INVALID_REQUEST' });
  }

  try {
    const transcript = await executeRun(body);
    return reply.send(serializeCall(transcript));
  } catch (err) {
    req.log.error({ err, body }, 'failed to execute run');
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ ok: false, error: 'RUN_FAILED', message });
  }
});

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

function recordPaymentRequirement(reqs: PaymentRequirements) {
  const serviceId = reqs.assured.serviceId;
  const queue = pendingRequirements.get(serviceId) ?? [];
  queue.push({ serviceId, requirements: cloneRequirements(reqs), startedAt: Date.now() });
  pendingRequirements.set(serviceId, queue);
}

function shiftPendingRequirement(serviceId: string): PendingRequirement | undefined {
  const queue = pendingRequirements.get(serviceId);
  if (!queue || queue.length === 0) {
    return undefined;
  }
  return queue.shift();
}

function discardLastPendingRequirement(serviceId: string) {
  const queue = pendingRequirements.get(serviceId);
  if (!queue || queue.length === 0) return;
  queue.pop();
}

function cloneRequirements(reqs: PaymentRequirements): PaymentRequirements {
  const cloner = (globalThis as unknown as { structuredClone?: <T>(value: T) => T }).structuredClone;
  if (typeof cloner === 'function') {
    return cloner(reqs);
  }
  return JSON.parse(JSON.stringify(reqs)) as PaymentRequirements;
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
    reputationProgramId:
      process.env.ASSURED_REPUTATION_PROGRAM_ID ?? '8QFXHzWC1hDC7GQTNqBhsVRLURpYfXFBzT5Vb4NTxDh5',
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

function ensureServiceStats(serviceId: string): ServiceStats {
  let stats = serviceStats.get(serviceId);
  if (!stats) {
    stats = { serviceId, ok: 0, late: 0, disputed: 0 };
    serviceStats.set(serviceId, stats);
  }
  return stats;
}

function hydrateCallRecord(
  serviceId: string,
  callId: string,
  opts: { headerValue?: string; txSig?: string | undefined }
): CallTranscript {
  let record = callIndex.get(callId);
  if (!record) {
    const pending = shiftPendingRequirement(serviceId);
    const baseReqs = pending?.requirements ?? deriveRequirementsForService(serviceId);
    record = {
      callId,
      serviceId,
      startedAt: pending?.startedAt ?? Date.now(),
      slaMs: baseReqs.assured.slaMs,
      disputeWindowS: baseReqs.assured.disputeWindowS,
      paymentRequirements: baseReqs,
      retryHeaders: {},
      responseHash: undefined,
      programIds: {
        escrow: config.escrowProgramId,
        reputation: config.reputationProgramId,
      },
      tx: { init: null, fulfill: null, settle: null },
      outcome: 'PENDING',
      evidence: [],
      scored: false,
    };
    callIndex.set(callId, record);
    callHistory.unshift(record);
    if (callHistory.length > RECENT_LIMIT) {
      callHistory.pop();
    }
    ensureServiceStats(serviceId);
  }

  if (opts.headerValue) {
    record.retryHeaders['X-PAYMENT'] = opts.headerValue;
  }
  if (opts.txSig) {
    record.tx.init = opts.txSig;
  }
  return record;
}

function deriveRequirementsForService(serviceId: string): PaymentRequirements {
  if (serviceId === config.serviceIds.good) {
    return cloneRequirements(paymentRequirements('good'));
  }
  if (serviceId === config.serviceIds.bad) {
    return cloneRequirements(paymentRequirements('bad'));
  }

  // Mirror/unknown services fall back to good template with overridden serviceId.
  const base = cloneRequirements(paymentRequirements('good'));
  base.assured.serviceId = serviceId;
  return base;
}

function updateOutcome(record: CallTranscript, outcome: CallOutcome) {
  record.outcome = outcome;
  if (record.scored || outcome === 'PENDING') {
    return;
  }
  const stats = ensureServiceStats(record.serviceId);
  if (outcome === 'RELEASED') {
    stats.ok += 1;
  } else if (outcome === 'REFUNDED') {
    stats.disputed += 1;
    const hasLateEvidence = record.evidence.some((ev) => ev.type === 'SLA_MISSED');
    if (hasLateEvidence) {
      stats.late += 1;
    }
  }
  record.scored = true;
}

function buildSummary() {
  const services = Array.from(serviceStats.values()).map((stats) => {
    const total = stats.ok + stats.late + stats.disputed;
    const score = total === 0 ? 1 : stats.ok / total;
    return {
      serviceId: stats.serviceId,
      ok: stats.ok,
      late: stats.late,
      disputed: stats.disputed,
      score: Number(score.toFixed(2)),
    };
  });

  const recent = callHistory.slice(0, 10).map((record) => ({
    callId: record.callId,
    serviceId: record.serviceId,
    startedAt: record.startedAt,
    slaMs: record.slaMs,
    outcome: record.outcome === 'PENDING' ? null : record.outcome,
    tx: record.tx,
  }));

  return { services, recent };
}

function serializeCall(record: CallTranscript) {
  return {
    callId: record.callId,
    serviceId: record.serviceId,
    startedAt: record.startedAt,
    slaMs: record.slaMs,
    disputeWindowS: record.disputeWindowS,
    paymentRequirements: record.paymentRequirements,
    retryHeaders: record.retryHeaders,
    responseHash: record.responseHash,
    programIds: record.programIds,
    tx: record.tx,
    outcome: record.outcome === 'PENDING' ? null : record.outcome,
    evidence: record.evidence,
  };
}

async function waitForCallRecord(callId: string, timeoutMs = 2000): Promise<CallTranscript> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const record = callIndex.get(callId);
    if (record && record.outcome !== 'PENDING') {
      return record;
    }
    if (record) {
      // outcome pending but record exists; return it if timeout elapses.
      if (Date.now() - start > timeoutMs / 2) {
        return record;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const fallback = callIndex.get(callId);
  if (!fallback) {
    throw new Error(`Call ${callId} not found`);
  }
  return fallback;
}

function mergePolicy(base: Policy, override?: Partial<Policy>): Policy {
  return { ...base, ...(override ?? {}) };
}

function resolveRunUrl(candidate: string | undefined, fallbackPath: string): string {
  if (candidate) {
    try {
      return new URL(candidate).toString();
    } catch {
      return new URL(candidate, SERVER_BASE_URL).toString();
    }
  }
  return new URL(fallbackPath, SERVER_BASE_URL).toString();
}

async function runStandardFlow(targetUrl: string, policy: Policy): Promise<CallTranscript> {
  const facilitator = new ServerFacilitator();
  const client = new Assured402Client({ facilitator, policy });
  const response = await client.fetch(targetUrl);
  const proof = facilitator.lastProof();
  if (!proof) {
    throw new Error('No payment proof captured for run');
  }

  // Drain body to avoid hanging sockets
  await response.text().catch(() => undefined);
  const record = await waitForCallRecord(proof.callId);
  return record;
}

async function runFallbackFlow(primaryUrl: string, fallbackPolicy: Policy): Promise<CallTranscript> {
  const initial = await fetch(primaryUrl);
  if (initial.status !== 402) {
    await initial.text().catch(() => undefined);
    return runStandardFlow(primaryUrl, fallbackPolicy);
  }

  const requirements: PaymentRequirements = await initial.json();
  discardLastPendingRequirement(requirements.assured.serviceId);

  const fallbackUrl = resolveRunUrl(requirements.assured.altService, requirements.assured.altService ?? primaryUrl);
  const record = await runStandardFlow(fallbackUrl, fallbackPolicy);
  record.evidence.push({ type: 'FALLBACK', altService: fallbackUrl });
  return record;
}

async function executeRun(body: RunRequestBody): Promise<CallTranscript> {
  const basePolicy = mergePolicy(balanced(), body.policy);
  switch (body.type) {
    case 'good':
      return runStandardFlow(resolveRunUrl(body.url, '/api/good'), basePolicy);
    case 'bad':
      return runStandardFlow(resolveRunUrl(body.url, '/api/bad'), basePolicy);
    case 'fallback': {
      const fallbackPolicy = mergePolicy(cheap(), body.policy);
      return runFallbackFlow(resolveRunUrl(body.url, '/api/good'), fallbackPolicy);
    }
    default:
      throw new Error(`Unsupported run type: ${body.type}`);
  }
}

class ServerFacilitator implements Facilitator {
  name: 'native' = 'native';
  private proof?: PaymentProof;

  async verifyPayment(req: PaymentRequirements): Promise<PaymentProof> {
    const serviceId = req.assured?.serviceId ?? 'unknown';
    const callId = `srv:${serviceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const txSig = `mock-${Math.random().toString(36).slice(2, 11)}`;
    const headerValue = Buffer.from(
      JSON.stringify({ callId, txSig, facilitator: this.name, ts: Date.now() }),
      'utf8'
    ).toString('base64');
    const proof: PaymentProof = { callId, txSig, headerValue };
    this.proof = proof;
    return proof;
  }

  async settle(): Promise<void> {}

  lastProof(): PaymentProof | undefined {
    return this.proof;
  }
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
  serviceId: string,
  receipt: PaymentReceipt,
  headerValue: string | undefined,
  payload: Record<string, unknown>
): Promise<string> {
  const record = hydrateCallRecord(serviceId, receipt.callId, {
    headerValue,
    txSig: receipt.txSig,
  });

  const responseJson = JSON.stringify(payload);
  const responseHash = createHash('sha256').update(responseJson).digest();
  const deliveredAt = Date.now();

  let fulfillSignature: string | null = null;
  if (!seenFulfillments.has(receipt.callId)) {
    fulfillSignature = await settlementManager.fulfill({
      callId: receipt.callId,
      txSig: receipt.txSig,
      responseHash: new Uint8Array(responseHash),
      deliveredAt,
    });
    seenFulfillments.add(receipt.callId);
  }

  if (fulfillSignature) {
    record.tx.fulfill = fulfillSignature;
  }

  const headerPayload = {
    callId: receipt.callId,
    responseHash: Buffer.from(responseHash).toString('hex'),
    fulfilledAt: deliveredAt,
    mode: settlementManager.mode,
  };
  record.responseHash = headerPayload.responseHash;
  updateOutcome(record, 'RELEASED');

  return encodeResponseHeader(headerPayload);
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
        return null;
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
        return null;
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

      const signature = await program.methods
        .fulfill(responseHashArray, ts, Array.from(providerSig))
        .accounts({
          escrowCall,
          provider: keypair.publicKey,
        })
        .signers([keypair])
        .rpc();
      return signature;
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
