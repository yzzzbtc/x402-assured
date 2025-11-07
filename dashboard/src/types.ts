export type ServiceSummary = {
  serviceId: string;
  ok: number;
  late: number;
  disputed: number;
  score: number;
  hasBond?: boolean;
  bondLamports?: number;
  bond?: string;
  ewmaMs?: number | null;
  p95Ms?: number | null;
  latencySamples?: number;
};

export type StreamState = {
  enabled: boolean;
  totalUnits: number;
  unitsReleased: number;
  timeline?: Array<{ index: number; at: number; txSig?: string }>;
};

export type RecentCall = {
  callId: string;
  serviceId: string;
  startedAt: number;
  slaMs: number;
  outcome: 'RELEASED' | 'REFUNDED' | null;
  tx: {
    init: string | null;
    fulfill: string | null;
    settle: string | null;
  };
  stream?: StreamState | null;
};

export type SummaryResponse = {
  services: ServiceSummary[];
  recent: RecentCall[];
};

export type TraceInfo = {
  responseHash: string;
  signature: string;
  signer: string;
  message: string;
  savedAt: number;
};

export type BondSnapshot = {
  hasBond: boolean;
  bondLamports: number;
  bond: string;
};

export type LatencySnapshot = {
  ewmaMs: number | null;
  p95Ms: number | null;
  samples: number;
};

export type MirrorInfo = {
  url: string;
  sig: string;
};

export type CallTranscript = {
  callId: string;
  serviceId: string;
  startedAt: number;
  slaMs: number;
  disputeWindowS: number;
  paymentRequirements: Record<string, unknown>;
  retryHeaders: Record<string, string>;
  responseHash: string | null;
  programIds: {
    escrow: string;
    reputation: string;
  };
  tx: {
    init: string | null;
    fulfill: string | null;
    settle: string | null;
  };
  outcome: 'RELEASED' | 'REFUNDED' | null;
  evidence: Record<string, unknown>[];
  webhookVerified: boolean | null;
  webhookReceivedAt: number | null;
  trace?: TraceInfo | null;
  stream?: StreamState | null;
  bond?: BondSnapshot | null;
  latency?: LatencySnapshot | null;
  mirrors?: MirrorInfo[];
};

export type RunType = 'good' | 'bad' | 'fallback' | 'stream';

export type RunRequest = {
  type: RunType;
  policy?: {
    minReputation?: number;
    maxPrice?: number;
    requireSLA?: boolean;
  };
  url?: string;
};

export type ConformanceCheck = {
  passed: boolean;
  detail?: string | null;
};

export type ConformanceChecks = {
  has402: ConformanceCheck;
  validSchema: ConformanceCheck;
  hasAssured: ConformanceCheck;
  acceptsRetry: ConformanceCheck;
  returns200: ConformanceCheck;
  settlesWithinSLA: ConformanceCheck;
  traceSaved?: ConformanceCheck;
  traceValid?: ConformanceCheck;
  mirrorSigValid?: ConformanceCheck;
};

export type ConformanceResult = {
  ok: boolean;
  checks: ConformanceChecks;
  receipt?: {
    callId: string;
    txSig?: string;
    headerValue: string;
  } | null;
  paymentResponse?: string | null;
};
