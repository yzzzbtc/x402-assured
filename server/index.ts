// server/index.ts — Fastify x402-Assured demo server
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createHash, createHmac } from 'crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyRawBody from 'fastify-raw-body';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor';
import BN from 'bn.js/lib/bn.js';
import Ajv from 'ajv';

import { Assured402Client, balanced, cheap, strict, type Policy } from '../sdk/ts/index.ts';
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

type CheckResult = {
  passed: boolean;
  detail?: string | null;
};

type StructuredChecks = {
  has402: CheckResult;
  validSchema: CheckResult;
  hasAssured: CheckResult;
  acceptsRetry: CheckResult;
  returns200: CheckResult;
  settlesWithinSLA: CheckResult;
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
const ajv = new Ajv({ allErrors: true, strict: false });
const validateRequirements = ajv.compile(paymentRequirementsSchema());
const runTimestamps: number[] = [];
const RUN_RATE_LIMIT = { windowMs: 1000, max: 3 };
const MIN_PROVIDER_SOL = 0.1;
let providerBalanceLamports: number | null = null;
let providerPublicKey: PublicKey | null = null;

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
  webhookVerified?: boolean;
  webhookReceivedAt?: number;
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
const seededServiceStats = buildInitialStatSeeds(config);

ensureServiceStats(config.serviceIds.good);
ensureServiceStats(config.serviceIds.bad);

await fastify.register(fastifyRawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true,
});

await fastify.register(cors, {
  origin: true,
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
  const payload = req.body as { callId?: string } | undefined;
  if (config.webhookSecret) {
    const provided = req.headers['x-assured-signature'];
    const expected = createHmac('sha256', config.webhookSecret)
      .update(raw)
      .digest('hex');
    if (provided !== expected) {
      req.log.warn('invalid webhook signature');
      return reply.code(401).send({ ok: false, error: 'INVALID_SIGNATURE' });
    }
    if (payload?.callId) {
      const record = callIndex.get(payload.callId);
      if (record) {
        record.webhookVerified = true;
        record.webhookReceivedAt = Date.now();
      }
    }
  } else if (payload?.callId) {
    const record = callIndex.get(payload.callId);
    if (record) {
      record.webhookReceivedAt = Date.now();
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
    body.url = sanitizeUserProvidedUrl(body.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(400).send({ ok: false, error: 'INVALID_URL', message });
  }

  if (!consumeRunToken()) {
    return reply
      .code(429)
      .send({ ok: false, error: 'RATE_LIMIT', message: 'Demo limited to 3 runs per second. Please pause and retry.' });
  }

  if (settlementManager.mode === 'onchain') {
    const hasFunds = hasSufficientProviderBalance();
    if (hasFunds === false) {
      const hint = providerPublicKey
        ? `Run \`solana airdrop 1 ${providerPublicKey.toBase58()}\` to top up.`
        : 'Run `solana airdrop 1 <providerPubkey>` to top up the provider wallet.';
      return reply
        .code(503)
        .send({ ok: false, error: 'LOW_FUNDS', message: `Provider wallet below ${MIN_PROVIDER_SOL} SOL. ${hint}` });
    }
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

fastify.post('/conformance', async (req, reply) => {
  const payload = req.body as { url?: string; policy?: string } | undefined;
  let sanitizedUrl: string | undefined;
  try {
    sanitizedUrl = sanitizeUserProvidedUrl(payload?.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(400).send({ ok: false, error: 'INVALID_URL', message });
  }
  const target = resolveRunUrl(sanitizedUrl, '/api/good');
  const policyPreset = (payload?.policy ?? 'balanced').toLowerCase();

  const checks = defaultChecks();
  let requirements: PaymentRequirements | null = null;

  try {
    const first = await fetch(target);
    const passed = first.status === 402;
    checks.has402 = { passed, detail: `status=${first.status}` };
    if (!passed) {
      await first.text().catch(() => undefined);
      return reply.send({ ok: false, checks });
    }
    requirements = (await first.json()) as PaymentRequirements;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.has402 = { passed: false, detail: message };
    return reply.send({ ok: false, checks });
  }

  const schemaValid = validateRequirements(requirements);
  checks.validSchema = {
    passed: Boolean(schemaValid),
    detail: schemaValid ? undefined : ajv.errorsText(validateRequirements.errors, { separator: '\n' }),
  };

  const assuredPresent = Boolean(requirements?.assured);
  checks.hasAssured = { passed: assuredPresent };

  if (!schemaValid || !assuredPresent) {
    return reply.send({ ok: false, checks });
  }

  const facilitator = new ConformanceFacilitator();
  const policy = resolvePolicyPreset(policyPreset);
  const client = new Assured402Client({ facilitator, policy });

  try {
    const response = await client.fetch(target);
    checks.acceptsRetry = { passed: response.status !== 402, detail: `status=${response.status}` };
    checks.returns200 = { passed: response.ok, detail: `status=${response.status}` };
    const paymentResponse = response.headers.get('x-payment-response');
    await response.text().catch(() => undefined);
    const receipt = facilitator.lastProof();
    const decodedHeader = paymentResponse ? decodeResponseHeader(paymentResponse) : null;
    checks.settlesWithinSLA = {
      passed: Boolean(decodedHeader?.fulfilledAt),
      detail: decodedHeader ? `fulfilledAt=${decodedHeader.fulfilledAt ?? 'unknown'}` : 'missing header',
    };
    return reply.send({
      ok: allChecksPassed(checks),
      checks,
      receipt,
      paymentResponse,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.acceptsRetry = { passed: false, detail: message };
    return reply.send({ ok: false, checks });
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

function buildInitialStatSeeds(cfg: ServerConfig) {
  const seeds = new Map<string, Omit<ServiceStats, 'serviceId'>>();
  if (cfg.settlementMode === 'mock') {
    seeds.set(cfg.serviceIds.bad, { ok: 1, late: 3, disputed: 4 });
  }
  return seeds;
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
    const seeded = seededServiceStats.get(serviceId);
    stats = {
      serviceId,
      ok: seeded?.ok ?? 0,
      late: seeded?.late ?? 0,
      disputed: seeded?.disputed ?? 0,
    };
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
    webhookVerified: record.webhookVerified ?? null,
    webhookReceivedAt: record.webhookReceivedAt ?? null,
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

function resolvePolicyPreset(preset: string): Policy {
  switch (preset) {
    case 'strict':
      return strict();
    case 'cheap':
      return cheap();
    case 'balanced':
    default:
      return balanced();
  }
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

function sanitizeUserProvidedUrl(candidate: string | undefined): string | undefined {
  if (!candidate) {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const base = new URL(SERVER_BASE_URL);
    const resolved = new URL(trimmed, SERVER_BASE_URL);
    if (resolved.origin !== base.origin) {
      throw new Error('External URLs are not allowed');
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    throw new Error('Invalid URL; only same-origin paths are allowed');
  }
}

function consumeRunToken(): boolean {
  const now = Date.now();
  while (runTimestamps.length && now - runTimestamps[0] > RUN_RATE_LIMIT.windowMs) {
    runTimestamps.shift();
  }
  if (runTimestamps.length >= RUN_RATE_LIMIT.max) {
    return false;
  }
  runTimestamps.push(now);
  return true;
}

function hasSufficientProviderBalance(): boolean | null {
  if (!providerPublicKey) {
    return null;
  }
  if (providerBalanceLamports === null) {
    return null;
  }
  return providerBalanceLamports >= MIN_PROVIDER_SOL * LAMPORTS_PER_SOL;
}

function defaultChecks(): StructuredChecks {
  return {
    has402: { passed: false },
    validSchema: { passed: false },
    hasAssured: { passed: false },
    acceptsRetry: { passed: false },
    returns200: { passed: false },
    settlesWithinSLA: { passed: false },
  };
}

function allChecksPassed(checks: StructuredChecks): boolean {
  return Object.values(checks).every((check) => check.passed);
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

class ConformanceFacilitator implements Facilitator {
  name: 'native' = 'native';
  private proof?: PaymentProof;

  async verifyPayment(req: PaymentRequirements): Promise<PaymentProof> {
    const serviceId = req.assured?.serviceId ?? 'unknown';
    const callId = `conf:${serviceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
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

function decodeResponseHeader<T = Record<string, unknown>>(header: string): T | null {
  try {
    const json = Buffer.from(header, 'base64').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
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
  providerPublicKey = keypair.publicKey;
  refreshProviderBalance(connection, keypair.publicKey, instance.log);
  setInterval(() => refreshProviderBalance(connection, keypair.publicKey!, instance.log), 30_000).unref?.();

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

function refreshProviderBalance(connection: Connection, pubkey: PublicKey, log: FastifyInstance['log']) {
  connection
    .getBalance(pubkey)
    .then((balance) => {
      providerBalanceLamports = balance;
    })
    .catch((err) => {
      log.warn({ err }, 'failed to refresh provider balance');
    });
}
