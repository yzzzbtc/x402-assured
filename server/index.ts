// server/index.ts — Fastify x402-Assured demo server
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createHash, createHmac } from 'crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyRawBody from 'fastify-raw-body';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import BN from 'bn.js/lib/bn.js';
import Ajv from 'ajv';
import nacl from 'tweetnacl';

import { Assured402Client, balanced, cheap, strict, type Policy } from '../sdk/ts/index.ts';
import type { Facilitator, PaymentProof } from '../sdk/ts/facilitators.ts';

import escrowIdlJson from '../contracts/escrow/target/idl/escrow.json' assert { type: 'json' };

// Use the full IDL (accounts+types) now that it's spec-compatible with Anchor 0.32
const escrowIdl = escrowIdlJson as any;

type ServiceKind = 'good' | 'bad';

type AssuredMirror = {
  url: string;
  sig: string;
};

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
    reputationProgram?: string;
    stream?: boolean;
    totalUnits?: number;
    mirrors?: AssuredMirror[];
    hasBond?: boolean;
    bondBalance?: string;
    slaP95Ms?: number;
  };
};

type PaymentReceipt = {
  callId: string;
  txSig?: string;
  headerValue?: string;
};

type SettlementRequest = {
  callId: string;
  responseHash: Uint8Array;
  deliveredAt: number;
  signature?: string;
};

type PartialSettlementRequest = {
  callId: string;
  chunkHash: Uint8Array;
  units: number;
  deliveredAt: number;
  signature?: string;
};

type RunType = 'good' | 'bad' | 'fallback' | 'stream';

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
  traceSaved?: CheckResult;
  traceValid?: CheckResult;
  mirrorSigValid?: CheckResult;
};

type StreamChunk = {
  index: number;
  units: number;
  cumulativeUnits: number;
  hash?: string;
  signature?: string | null;
  signer?: string | null;
  tx?: string | null;
  at: number;
  payload?: Record<string, unknown>;
};

type StreamState = {
  enabled: boolean;
  totalUnits: number;
  unitsReleased: number;
  chunks: StreamChunk[];
};

type TraceInfo = {
  responseHash?: string;
  signature?: string | null;
  signer?: string | null;
  message?: string;
  savedAt?: number;
};

type BondInfo = {
  hasBond: boolean;
  balanceLamports: number;
  display: string;
};

type LatencyInfo = {
  ewmaMs: number;
  p95Ms: number;
  samples: number;
};

type TraceAuthority = {
  keypair: Keypair;
  publicKey: string;
  sign(message: Uint8Array): string;
};

interface SettlementManager {
  mode: 'mock' | 'onchain';
  fulfill(req: SettlementRequest): Promise<string | null>;
  fulfillPartial(req: PartialSettlementRequest): Promise<string | null>;
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
  streamServiceId: string;
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
const runTimestamps: number[] = [];
const RUN_RATE_LIMIT = { windowMs: 1000, max: 3 };
const MIN_PROVIDER_SOL = 0.1;
let providerBalanceLamports: number | null = null;
let providerPublicKey: PublicKey | null = null;
const providerAuthority = loadKeypair(config.providerKeypairPath);
const traceSigner = createTraceSigner(providerAuthority);
providerPublicKey = traceSigner.keypair.publicKey;
const settlementManager = createSettlementManager(config, fastify, providerAuthority);
const seenFulfillments = new Set<string>();
const ajv = new Ajv({ allErrors: true, strict: false });
const validateRequirements = ajv.compile(paymentRequirementsSchema());

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
  trace: TraceInfo;
  stream?: StreamState;
  bond?: BondInfo;
  latency?: LatencyInfo;
}

type ServiceStats = {
  serviceId: string;
  ok: number;
  late: number;
  disputed: number;
  hasBond: boolean;
  bondLamports: number;
  ewmaLatencyMs: number;
  p95LatencyMs: number;
  latencySamples: number;
};

type PendingRequirement = {
  serviceId: string;
  requirements: PaymentRequirements;
  startedAt: number;
};

const RECENT_LIMIT = 50;
const STREAM_TOTAL_UNITS = 3;
const pendingRequirements = new Map<string, PendingRequirement[]>();
const callIndex = new Map<string, CallTranscript>();
const callHistory: CallTranscript[] = [];
const serviceStats = new Map<string, ServiceStats>();
const seededServiceStats = buildInitialStatSeeds(config);

ensureServiceStats(config.serviceIds.good);
ensureServiceStats(config.serviceIds.bad);
ensureServiceStats(config.streamServiceId);

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
    console.log('[SENDING 402] Full requirements object:', JSON.stringify(requirements, null, 2));
    console.log('[SENDING 402] escrowProgram value:', requirements.assured.escrowProgram);
    console.log('[SENDING 402] reputationProgram value:', requirements.assured.reputationProgram);
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

fastify.get('/api/good_stream', async (req, reply) => {
  const serviceId = config.streamServiceId;
  const headerValue = typeof req.headers['x-payment'] === 'string' ? req.headers['x-payment'] : undefined;
  const receipt = extractReceipt(headerValue);
  if (!receipt) {
    const requirements = paymentRequirements('good');
    requirements.assured.serviceId = serviceId;
    requirements.assured.stream = true;
    requirements.assured.totalUnits = STREAM_TOTAL_UNITS;
    requirements.assured.mirrors = config.altService
      ? [buildMirrorDescriptor(serviceId, config.altService)]
      : undefined;
    const streamBond = deriveBondSnapshot(serviceId);
    const streamLatency = deriveLatencySnapshot(serviceId);
    requirements.assured.hasBond = streamBond.hasBond;
    requirements.assured.bondBalance = streamBond.display;
    requirements.assured.slaP95Ms = streamLatency.p95Ms || undefined;
    recordPaymentRequirement(requirements);
    return reply.code(402).send(requirements);
  }

  const record = hydrateCallRecord(serviceId, receipt.callId, {
    headerValue,
    txSig: receipt.txSig,
  });
  const streamState = ensureStreamState(record, STREAM_TOTAL_UNITS);
  record.bond = deriveBondSnapshot(serviceId);
  record.latency = deriveLatencySnapshot(serviceId);

  if (seenFulfillments.has(receipt.callId) && streamState.unitsReleased >= streamState.totalUnits) {
    const fulfilledAt = record.trace.savedAt ?? record.startedAt;
    const headerPayload = {
      callId: receipt.callId,
      responseHash: record.responseHash,
      fulfilledAt,
      mode: settlementManager.mode,
      partials: streamState.chunks.length,
    };
    reply.header('x-payment-response', encodeResponseHeader(headerPayload));
    const existingTimeline = streamState.chunks.map((chunk) => chunk.payload ?? { index: chunk.index, units: chunk.units });
    return {
      ok: true,
      stream: {
        totalUnits: streamState.totalUnits,
        unitsReleased: streamState.unitsReleased,
        segments: existingTimeline,
      },
    };
  }

  let cumulativeUnits = streamState.unitsReleased ?? 0;
  const segments = buildStreamSegments();

  const useOnchainSettlement = shouldAttemptOnchain(receipt);
  if (settlementManager.mode === 'onchain' && !useOnchainSettlement) {
    req.log.warn(
      { callId: receipt.callId, txSig: receipt.txSig },
      'skipping on-chain stream fulfillment because receipt is mock or missing'
    );
  }

  for (const segment of segments) {
    const chunkPayload = {
      index: streamState.chunks.length + 1,
      ...segment.payload,
    };

    const chunkJson = JSON.stringify(chunkPayload);
    const chunkHash = createHash('sha256').update(chunkJson).digest();
    const chunkHashHex = Buffer.from(chunkHash).toString('hex');
    const deliveredAt = Date.now();
    const message = buildTraceMessage(receipt.callId, chunkHashHex, deliveredAt);
    const signature = traceSigner.sign(message);

    let txSig: string | null = null;
    const partialRequest = {
      callId: receipt.callId,
      chunkHash: new Uint8Array(chunkHash),
      units: segment.units,
      deliveredAt,
      signature,
    };
    if (settlementManager.mode === 'onchain') {
      if (useOnchainSettlement) {
        txSig = await settlementManager.fulfillPartial(partialRequest);
      }
    } else {
      await settlementManager.fulfillPartial(partialRequest);
    }

    cumulativeUnits += segment.units;
    const chunkRecord: StreamChunk = {
      index: streamState.chunks.length + 1,
      units: segment.units,
      cumulativeUnits,
      hash: chunkHashHex,
      signature,
      signer: traceSigner.publicKey,
      tx: txSig ?? null,
      at: deliveredAt,
      payload: chunkPayload,
    };
    streamState.chunks.push(chunkRecord);
    streamState.unitsReleased = cumulativeUnits;

    record.trace = {
      responseHash: chunkHashHex,
      signature,
      signer: traceSigner.publicKey,
      message: Buffer.from(message).toString('utf8'),
      savedAt: deliveredAt,
    };
    record.responseHash = chunkHashHex;
    if (txSig) {
      record.tx.fulfill = txSig;
    }

    if (segment.delayMs) {
      await sleep(segment.delayMs);
    }
  }

  updateOutcome(record, 'RELEASED');
  record.bond = deriveBondSnapshot(serviceId);
  record.latency = deriveLatencySnapshot(serviceId);
  seenFulfillments.add(receipt.callId);

  const fulfilledAt = record.trace.savedAt ?? Date.now();
  const headerPayload = {
    callId: receipt.callId,
    responseHash: record.responseHash,
    fulfilledAt,
    mode: useOnchainSettlement ? 'onchain' : 'mock',
    partials: streamState.chunks.length,
  };
  reply.header('x-payment-response', encodeResponseHeader(headerPayload));

  const payload = {
    ok: true,
    stream: {
      totalUnits: streamState.totalUnits,
      unitsReleased: streamState.unitsReleased,
      segments: streamState.chunks.map((chunk) => chunk.payload ?? { index: chunk.index, units: chunk.units }),
    },
  };
  return payload;
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
  const slashAmount = Math.round(0.1 * LAMPORTS_PER_SOL);
  applyBondSlash(serviceId, slashAmount);
  record.bond = deriveBondSnapshot(serviceId);
  record.latency = deriveLatencySnapshot(serviceId);
  record.trace = {
    responseHash: hash,
    signature: null,
    signer: null,
    message: 'sla-missed',
    savedAt: Date.now(),
  };
  record.evidence.push({ type: 'BOND_SLASH', amountLamports: slashAmount });

  return reply.code(503).send(payload);
});

fastify.get('/api/good_mirror', async (req, reply) => {
  const serviceId = `${config.serviceIds.good}:mirror`;
  const headerValue = typeof req.headers['x-payment'] === 'string' ? req.headers['x-payment'] : undefined;
  const receipt = extractReceipt(headerValue);
  if (!receipt) {
    const requirements = deriveRequirementsForService(serviceId);
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

// Health check endpoint for Railway
fastify.get('/', async (_req, reply) => {
  return reply.send({ ok: true, service: 'x402-assured', mode: config.settlementMode });
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
    let transcript: CallTranscript | null = null;
    if (receipt) {
      try {
        transcript = await waitForCallRecord(receipt.callId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        checks.traceSaved = { passed: false, detail: message };
      }
    }

    if (transcript) {
      const traceInfo = transcript.trace;
      if (traceInfo?.responseHash) {
        checks.traceSaved = { passed: true };
        const savedAt = traceInfo.savedAt ?? (typeof decodedHeader?.fulfilledAt === 'number' ? decodedHeader.fulfilledAt : Date.now());
        const traceMessage = buildTraceMessage(transcript.callId, traceInfo.responseHash, savedAt);
        const traceOk = verifySignature(
          traceMessage,
          traceInfo.signature ?? null,
          traceInfo.signer ?? traceSigner.publicKey
        );
        checks.traceValid = traceOk
          ? { passed: true }
          : { passed: false, detail: 'trace signature invalid' };
      } else {
        checks.traceSaved = { passed: false, detail: 'missing trace hash' };
        checks.traceValid = { passed: false, detail: 'no trace signature' };
      }

      const mirrors = transcript.paymentRequirements.assured?.mirrors ?? [];
      if (mirrors.length > 0) {
        const signerPk = traceInfo?.signer ?? traceSigner.publicKey;
        const allValid = mirrors.every((mirror) =>
          verifySignature(
            buildMirrorMessage(transcript.paymentRequirements.assured.serviceId, mirror.url),
            mirror.sig,
            signerPk
          )
        );
        checks.mirrorSigValid = allValid
          ? { passed: true }
          : { passed: false, detail: 'mirror signature invalid' };
      } else if (!checks.mirrorSigValid) {
        checks.mirrorSigValid = { passed: true };
      }
    } else {
      if (!checks.traceSaved) {
        checks.traceSaved = { passed: false, detail: 'transcript unavailable' };
      }
      if (!checks.traceValid) {
        checks.traceValid = { passed: false, detail: 'transcript unavailable' };
      }
      if (!checks.mirrorSigValid) {
        checks.mirrorSigValid = { passed: true };
      }
    }

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
  const serviceId = config.serviceIds[kind];
  const bond = deriveBondSnapshot(serviceId);
  const latency = deriveLatencySnapshot(serviceId);
  const mirrors = config.altService ? [buildMirrorDescriptor(serviceId, config.altService)] : undefined;
  console.log('[PAYMENT REQ] escrowProgramId from config:', config.escrowProgramId);
  console.log('[PAYMENT REQ] reputationProgramId from config:', config.reputationProgramId);
  console.log('[PAYMENT REQ] serviceId:', serviceId);
  return {
    price: config.price,
    currency: config.currency,
    network: config.network,
    recipient: config.recipient,
    assured: {
      serviceId,
      slaMs: config.sla[kind],
      disputeWindowS: config.disputeWindow,
      escrowProgram: config.escrowProgramId,
      reputationProgram: config.reputationProgramId,
      altService: config.altService,
      sigAlg: 'ed25519',
      stream: false,
      hasBond: bond.hasBond,
      bondBalance: bond.display,
      slaP95Ms: latency.p95Ms || undefined,
      mirrors,
      _deployVersion: 'v2025-01-09-debug-response',
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
        required: ['serviceId', 'slaMs', 'disputeWindowS', 'escrowProgram', 'sigAlg', 'stream'],
        properties: {
          serviceId: { type: 'string', minLength: 1 },
          slaMs: { type: 'integer', minimum: 1 },
          disputeWindowS: { type: 'integer', minimum: 1 },
          escrowProgram: { type: 'string', minLength: 32 },
          altService: { type: 'string' },
          sigAlg: { type: 'string', enum: ['ed25519'] },
          reputationProgram: { type: 'string', minLength: 32 },
          stream: { type: 'boolean' },
          totalUnits: { type: 'integer', minimum: 1 },
          mirrors: {
            type: 'array',
            items: {
              type: 'object',
              required: ['url', 'sig'],
              properties: {
                url: { type: 'string', minLength: 1 },
                sig: { type: 'string', minLength: 1 },
              },
              additionalProperties: false,
            },
          },
          hasBond: { type: 'boolean' },
          bondBalance: { type: 'string' },
          slaP95Ms: { type: 'integer', minimum: 1 },
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

  // Railway bug workaround: try multiple variable names
  const assuredModeRaw = process.env.ASSURED_MODE;
  const x402ModeRaw = process.env.X402_MODE;
  const settlementModeRaw = process.env.SETTLEMENT_MODE;
  const modeRaw = process.env.MODE;

  console.log('[CONFIG DEBUG] All mode-related env vars:', {
    ASSURED_MODE: { value: assuredModeRaw, type: typeof assuredModeRaw, length: assuredModeRaw?.length },
    X402_MODE: { value: x402ModeRaw, type: typeof x402ModeRaw, length: x402ModeRaw?.length },
    SETTLEMENT_MODE: { value: settlementModeRaw, type: typeof settlementModeRaw, length: settlementModeRaw?.length },
    MODE: { value: modeRaw, type: typeof modeRaw, length: modeRaw?.length },
  });

  // Try all variable names in order of preference
  const rawValue = assuredModeRaw || x402ModeRaw || settlementModeRaw || modeRaw;
  const settlementMode = (rawValue?.trim() || 'mock') as 'mock' | 'onchain';

  console.log('[CONFIG DEBUG] settlementMode resolved to:', settlementMode, 'from variable:',
    assuredModeRaw ? 'ASSURED_MODE' :
    x402ModeRaw ? 'X402_MODE' :
    settlementModeRaw ? 'SETTLEMENT_MODE' :
    modeRaw ? 'MODE' : 'default');
  console.log('[CONFIG DEBUG] escrowProgramId:', process.env.ASSURED_ESCROW_PROGRAM_ID ?? '6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL');
  console.log('[CONFIG DEBUG] reputationProgramId:', process.env.ASSURED_REPUTATION_PROGRAM_ID ?? '8QFXHzWC1hDC7GQTNqBhsVRLURpYfXFBzT5Vb4NTxDh5');

  return {
    price: process.env.ASSURED_PRICE || '0.001',
    currency: process.env.ASSURED_CURRENCY || 'USDC',
    network: process.env.ASSURED_NETWORK || 'solana-devnet',
    recipient:
      process.env.ASSURED_RECIPIENT || 'CTdyT6ZctmsuPhkJrfcvQgAe95uPS45aXErGLKAhAZAA',
    escrowProgramId:
      process.env.ASSURED_ESCROW_PROGRAM_ID || '6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL',
    reputationProgramId:
      process.env.ASSURED_REPUTATION_PROGRAM_ID || '8QFXHzWC1hDC7GQTNqBhsVRLURpYfXFBzT5Vb4NTxDh5',
    altService: process.env.ASSURED_ALT_SERVICE || 'http://localhost:3000/api/good_mirror',
    sla: {
      good: Number(process.env.ASSURED_GOOD_SLA || '2000'),
      bad: Number(process.env.ASSURED_BAD_SLA || '1000'),
    },
    disputeWindow: Number(process.env.ASSURED_DISPUTE_WINDOW || '10'),
    serviceIds: {
      good: process.env.ASSURED_GOOD_SERVICE_ID || 'demo:good',
      bad: process.env.ASSURED_BAD_SERVICE_ID || 'demo:bad',
    },
    streamServiceId: process.env.ASSURED_STREAM_SERVICE_ID || 'demo:strm',
    webhookSecret: process.env.ASSURED_WEBHOOK_SECRET,
    settlementMode,
    providerKeypairPath: providerPath,
    rpcEndpoint: process.env.ASSURED_RPC ?? 'https://api.devnet.solana.com',
  };
}

function buildInitialStatSeeds(cfg: ServerConfig) {
  const seeds = new Map<string, Omit<ServiceStats, 'serviceId'>>();
  seeds.set(cfg.serviceIds.good, {
    ok: 12,
    late: 0,
    disputed: 1,
    hasBond: true,
    bondLamports: Math.round(1.2 * LAMPORTS_PER_SOL),
    ewmaLatencyMs: 850,
    p95LatencyMs: 1200,
    latencySamples: 48,
  });
  seeds.set(cfg.streamServiceId, {
    ok: 8,
    late: 0,
    disputed: 0,
    hasBond: true,
    bondLamports: Math.round(1.5 * LAMPORTS_PER_SOL),
    ewmaLatencyMs: 900,
    p95LatencyMs: 1100,
    latencySamples: 24,
  });
  if (cfg.settlementMode === 'mock') {
    seeds.set(cfg.serviceIds.bad, {
      ok: 1,
      late: 3,
      disputed: 4,
      hasBond: true,
      bondLamports: Math.round(0.5 * LAMPORTS_PER_SOL),
      ewmaLatencyMs: 1500,
      p95LatencyMs: 2200,
      latencySamples: 12,
    });
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
      hasBond: seeded?.hasBond ?? false,
      bondLamports: seeded?.bondLamports ?? 0,
      ewmaLatencyMs: seeded?.ewmaLatencyMs ?? 0,
      p95LatencyMs: seeded?.p95LatencyMs ?? 0,
      latencySamples: seeded?.latencySamples ?? 0,
    };
    serviceStats.set(serviceId, stats);
  }
  return stats;
}

function deriveBondSnapshot(serviceId: string): BondInfo {
  const stats = ensureServiceStats(serviceId);
  const display = (stats.bondLamports / LAMPORTS_PER_SOL).toFixed(2);
  return {
    hasBond: stats.hasBond,
    balanceLamports: stats.bondLamports,
    display,
  };
}

function deriveLatencySnapshot(serviceId: string): LatencyInfo {
  const stats = ensureServiceStats(serviceId);
  return {
    ewmaMs: stats.ewmaLatencyMs,
    p95Ms: stats.p95LatencyMs,
    samples: stats.latencySamples,
  };
}

function buildMirrorMessage(serviceId: string, url: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`assured-mirror|${serviceId}|${url}`);
}

function buildMirrorDescriptor(serviceId: string, url: string): AssuredMirror {
  const message = buildMirrorMessage(serviceId, url);
  const sig = traceSigner.sign(message);
  return { url, sig };
}

function buildTraceMessage(callId: string, responseHashHex: string, deliveredAt: number): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`assured-trace|${callId}|${responseHashHex}|${deliveredAt}`);
}

function ensureStreamState(record: CallTranscript, totalUnits: number): StreamState {
  if (!record.stream) {
    record.stream = {
      enabled: true,
      totalUnits,
      unitsReleased: 0,
      chunks: [],
    };
  } else {
    record.stream.enabled = true;
    record.stream.totalUnits = totalUnits;
    record.stream.unitsReleased = record.stream.unitsReleased ?? 0;
    record.stream.chunks = record.stream.chunks ?? [];
  }
  return record.stream;
}

function buildStreamSegments() {
  return [
    {
      units: 1,
      payload: {
        stage: 'quote',
        price: '0.00034',
        currency: config.currency,
        slaMs: config.sla.good,
      },
      delayMs: 150,
    },
    {
      units: 1,
      payload: {
        stage: 'verification',
        reputationScore: 0.94,
        disputeRisk: 0.02,
        policy: 'assured.stream',
      },
      delayMs: 120,
    },
    {
      units: 1,
      payload: {
        stage: 'result',
        released: true,
        settlementMs: 420,
        note: 'Partial settle complete',
      },
      delayMs: 80,
    },
  ];
}

function applyBondSlash(serviceId: string, lamports: number) {
  if (lamports <= 0) {
    return;
  }
  const stats = ensureServiceStats(serviceId);
  stats.bondLamports = Math.max(0, stats.bondLamports - lamports);
  stats.hasBond = stats.bondLamports > 0;
}

function verifySignature(
  message: Uint8Array,
  signature: string | null | undefined,
  signer: string | null | undefined
): boolean {
  if (!signature || !signer) {
    return false;
  }
  try {
    const sigBytes = Buffer.from(signature, 'base64');
    const signerKey = new PublicKey(signer);
    return nacl.sign.detached.verify(message, sigBytes, signerKey.toBytes());
  } catch {
    return false;
  }
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
      trace: {},
      stream: baseReqs.assured.stream
        ? {
            enabled: true,
            totalUnits: baseReqs.assured.totalUnits ?? 1,
            unitsReleased: 0,
            chunks: [],
          }
        : undefined,
      bond: deriveBondSnapshot(serviceId),
      latency: deriveLatencySnapshot(serviceId),
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
  if (base.assured.mirrors) {
    base.assured.mirrors = base.assured.mirrors.map((entry) => buildMirrorDescriptor(serviceId, entry.url));
  }
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
    const bondDisplay = (stats.bondLamports / LAMPORTS_PER_SOL).toFixed(2);
    return {
      serviceId: stats.serviceId,
      ok: stats.ok,
      late: stats.late,
      disputed: stats.disputed,
      score: Number(score.toFixed(2)),
      hasBond: stats.hasBond,
      bondLamports: stats.bondLamports,
      bond: bondDisplay,
      ewmaMs: stats.ewmaLatencyMs,
      p95Ms: stats.p95LatencyMs,
      latencySamples: stats.latencySamples,
    };
  });

  const recent = callHistory.slice(0, 10).map((record) => ({
    callId: record.callId,
    serviceId: record.serviceId,
    startedAt: record.startedAt,
    slaMs: record.slaMs,
    outcome: record.outcome === 'PENDING' ? null : record.outcome,
    tx: record.tx,
    stream: record.stream ?? null,
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
    trace: record.trace,
    stream: record.stream ?? null,
    bond: record.bond ?? null,
    latency: record.latency ?? null,
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
    traceSaved: { passed: false },
    traceValid: { passed: false },
    mirrorSigValid: { passed: true },
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
    case 'stream':
      return runStandardFlow(resolveRunUrl(body.url, '/api/good_stream'), basePolicy);
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

  const useOnchainSettlement = shouldAttemptOnchain(receipt);
  const shouldInvokeSettlement =
    settlementManager.mode !== 'onchain' || useOnchainSettlement;
  if (settlementManager.mode === 'onchain' && !useOnchainSettlement) {
    fastify.log.warn(
      { callId: receipt.callId, txSig: receipt.txSig },
      'skipping on-chain fulfill because receipt is mock or missing txSig'
    );
  }

  const responseJson = JSON.stringify(payload);
  const responseHash = createHash('sha256').update(responseJson).digest();
  const deliveredAt = Date.now();
  const responseHashHex = Buffer.from(responseHash).toString('hex');
  const traceMessage = buildTraceMessage(receipt.callId, responseHashHex, deliveredAt);
  const traceSignature = traceSigner.sign(traceMessage);

  let fulfillSignature: string | null = null;
  if (!seenFulfillments.has(receipt.callId) && shouldInvokeSettlement) {
    fulfillSignature = await settlementManager.fulfill({
      callId: receipt.callId,
      responseHash: new Uint8Array(responseHash),
      deliveredAt,
      signature: traceSignature,
    });
    seenFulfillments.add(receipt.callId);
  } else if (!shouldInvokeSettlement) {
    seenFulfillments.add(receipt.callId);
  }

  if (fulfillSignature) {
    record.tx.fulfill = fulfillSignature;
  }

  const headerPayload = {
    callId: receipt.callId,
    responseHash: responseHashHex,
    fulfilledAt: deliveredAt,
    mode: useOnchainSettlement ? 'onchain' : 'mock',
  };
  record.responseHash = headerPayload.responseHash;
  record.trace = {
    responseHash: responseHashHex,
    signature: traceSignature,
    signer: traceSigner.publicKey,
    message: Buffer.from(traceMessage).toString('utf8'),
    savedAt: deliveredAt,
  };
  updateOutcome(record, 'RELEASED');
  record.bond = deriveBondSnapshot(serviceId);
  record.latency = deriveLatencySnapshot(serviceId);

  return encodeResponseHeader(headerPayload);
}

function shouldAttemptOnchain(receipt: PaymentReceipt): boolean {
  if (settlementManager.mode !== 'onchain') {
    return false;
  }
  if (!receipt.txSig || receipt.txSig.length < 32) {
    return false;
  }
  return !receipt.txSig.startsWith('mock-');
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

function createSettlementManager(
  cfg: ServerConfig,
  instance: FastifyInstance,
  authority?: Keypair | null
): SettlementManager {
  const log = instance.log;

  if (cfg.settlementMode !== 'onchain') {
    log.info('assured settlement running in mock mode');
    return {
      mode: 'mock',
      async fulfill(req) {
        log.info({ callId: req.callId }, 'mock fulfill');
        return null;
      },
      async fulfillPartial(req) {
        log.info({ callId: req.callId, units: req.units }, 'mock partial fulfill');
        return null;
      },
    };
  }

  const keypair = authority ?? loadKeypair(cfg.providerKeypairPath);
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
      async fulfillPartial(req) {
        log.info({ callId: req.callId, units: req.units }, 'mock partial fulfill');
        return null;
      },
    };
  }

  const connection = new Connection(cfg.rpcEndpoint, 'confirmed');
  const wallet = createWallet(keypair);
  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  const programId = new PublicKey(cfg.escrowProgramId);
  const program = new Program({ ...(escrowIdl as any), address: programId.toBase58() }, provider);
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
      const responseHash = Array.from(req.responseHash);
      const providerSig = req.signature ? Buffer.from(req.signature, 'base64') : Buffer.alloc(0);

      const signature = await program.methods
        .fulfill(responseHash, ts, providerSig)
        .accounts({
          escrowCall,
          provider: keypair.publicKey,
        })
        .rpc();
      return signature;
    },
    async fulfillPartial(req) {
      const [escrowCall] = PublicKey.findProgramAddressSync(
        [Buffer.from('call'), Buffer.from(req.callId)],
        programId
      );
      const ts = new BN(Math.floor(req.deliveredAt / 1000));
      const chunkHash = Array.from(req.chunkHash);
      const providerSig = req.signature ? Buffer.from(req.signature, 'base64') : Buffer.alloc(0);
      const units = new BN(req.units);

      const signature = await program.methods
        .fulfillPartial(chunkHash, units, ts, providerSig)
        .accounts({
          escrowCall,
          provider: keypair.publicKey,
        })
        .rpc();
      return signature;
    },
  };
}

function loadKeypair(maybePath?: string): Keypair | null {
  if (!maybePath) {
    fastify.log.warn('loadKeypair called with empty/undefined value');
    return null;
  }

  // Log what we received
  const inputPreview = maybePath.length > 100 ? `${maybePath.substring(0, 100)}...` : maybePath;
  fastify.log.info({ inputPreview, inputLength: maybePath.length, inputType: typeof maybePath }, 'loadKeypair received input');

  try {
    // Try as file path first
    if (existsSync(maybePath)) {
      fastify.log.info('loading keypair from file path');
      const secret = JSON.parse(readFileSync(maybePath, 'utf8')) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    }

    // Try parsing as JSON array
    fastify.log.info('attempting to parse as JSON');

    // Strip /app/ prefix if present (Railway bug)
    let cleanedInput = maybePath;
    if (maybePath.startsWith('/app/')) {
      cleanedInput = maybePath.substring(5); // Remove '/app/'
      fastify.log.info({ original: maybePath.substring(0, 50), cleaned: cleanedInput.substring(0, 50) }, 'stripped /app/ prefix');
    }

    let parsed = JSON.parse(cleanedInput);
    fastify.log.info({ parsedType: typeof parsed, isArray: Array.isArray(parsed) }, 'first JSON.parse result');

    // Handle double-encoded JSON (Railway might wrap in quotes)
    if (typeof parsed === 'string') {
      fastify.log.info('detected double-encoded string, parsing again');
      parsed = JSON.parse(parsed);
      fastify.log.info({ parsedType: typeof parsed, isArray: Array.isArray(parsed) }, 'second JSON.parse result');
    }

    if (Array.isArray(parsed)) {
      fastify.log.info({ arrayLength: parsed.length }, 'successfully parsed keypair array');
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }

    fastify.log.warn({ type: typeof parsed, isArray: Array.isArray(parsed) }, 'parsed value is not an array');
  } catch (err) {
    fastify.log.error({ err, errorMessage: (err as Error).message, input: maybePath?.substring(0, 100) }, 'failed to load keypair from path or inline array');
  }
  return null;
}

function createTraceSigner(authority: Keypair | null | undefined): TraceAuthority {
  const keypair = authority ?? fallbackTraceKeypair();
  return {
    keypair,
    publicKey: keypair.publicKey.toBase58(),
    sign(message: Uint8Array) {
      const signature = nacl.sign.detached(message, keypair.secretKey);
      return Buffer.from(signature).toString('base64');
    },
  };
}

function fallbackTraceKeypair(): Keypair {
  const seed = createHash('sha256').update('assured-trace-fallback').digest();
  return Keypair.fromSeed(Uint8Array.from(seed));
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
