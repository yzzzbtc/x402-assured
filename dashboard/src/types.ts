export type ServiceSummary = {
  serviceId: string;
  ok: number;
  late: number;
  disputed: number;
  score: number;
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
};

export type SummaryResponse = {
  services: ServiceSummary[];
  recent: RecentCall[];
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
};

export type RunType = 'good' | 'bad' | 'fallback';

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
