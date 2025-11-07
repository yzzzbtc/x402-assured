import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  fetchSummary,
  fetchCall,
  runFlow,
  runConformance,
} from './api';
import type {
  CallTranscript,
  SummaryResponse,
  RunRequest,
  RunType,
  ConformanceResult,
  ConformanceChecks,
} from './types.js';
import { verifyTrace, verifyMirrorSig } from '../../sdk/ts/index.js';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';
const ESCROW_PROGRAM_ID = import.meta.env.VITE_ESCROW_PROGRAM_ID ?? '6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL';
const REPUTATION_PROGRAM_ID = import.meta.env.VITE_REPUTATION_PROGRAM_ID ?? '8QFXHzWC1hDC7GQTNqBhsVRLURpYfXFBzT5Vb4NTxDh5';

const FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatTime(ms: number) {
  return FORMATTER.format(new Date(ms));
}

function scoreColor(score: number) {
  if (score >= 0.75) return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
  if (score >= 0.4) return 'bg-amber-500/20 text-amber-300 border border-amber-500/40';
  return 'bg-rose-500/20 text-rose-300 border border-rose-500/40';
}

function outcomeChip(outcome: string | null) {
  if (outcome === 'RELEASED') {
    return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
  }
  if (outcome === 'REFUNDED') {
    return 'bg-rose-500/20 text-rose-300 border border-rose-500/40';
  }
  return 'bg-slate-600/40 text-slate-200 border border-slate-600/60';
}

const RUN_LABELS: Record<RunType, string> = {
  good: 'Call Good',
  bad: 'Call Bad',
  fallback: 'Call Fallback',
  stream: 'Call Good (Stream)',
};

const RUN_DEFAULT_PATH: Record<RunType, string> = {
  good: '/api/good',
  bad: '/api/bad',
  fallback: '/api/good',
  stream: '/api/good_stream',
};

const ABOUT_POINTS = [
  {
    title: 'Escrow before compute',
    body: 'Every 402 request hits a Solana escrow first; fulfillment only releases after the provider proves delivery.',
  },
  {
    title: 'Structured disputes',
    body: 'Late or bad responses raise typed evidence (LATE / BAD_PROOF / MISMATCH_HASH) on-chain and trigger refunds.',
  },
  {
    title: 'Shared reputation',
    body: 'Agents query the registry before paying. Policies (min rep, max price, SLA required) keep flows safe.',
  },
];

function quoteForCurl(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveCurlUrl(request: RunRequest): string {
  const basePath = RUN_DEFAULT_PATH[request.type];
  const raw = (request.url ?? '').trim() || basePath;
  try {
    return new URL(raw).toString();
  } catch {
    return new URL(raw, API_BASE).toString();
  }
}

function buildCurlCommands(url: string) {
  const quotedUrl = quoteForCurl(url);
  return {
    initial: `curl -i ${quotedUrl}`,
    retry: `curl -i ${quotedUrl} \\\n  -H 'X-PAYMENT: <base64-receipt>'`,
};
}

const CHECK_ITEMS: Array<{ key: keyof ConformanceChecks; label: string }> = [
  { key: 'has402', label: 'Returns HTTP 402' },
  { key: 'validSchema', label: 'Valid PaymentRequirements schema' },
  { key: 'hasAssured', label: 'Includes assured namespace' },
  { key: 'acceptsRetry', label: 'Accepts X-PAYMENT retry' },
  { key: 'returns200', label: 'Returns 200 OK' },
  { key: 'settlesWithinSLA', label: 'Publishes settlement header' },
];

function maskHeader(value: string, visible = 8) {
  if (value.length <= visible * 2) return value;
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}

function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-transparent" />;
}

function checkStatusClass(passed: boolean) {
  return passed
    ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
    : 'border border-rose-500/40 bg-rose-500/10 text-rose-200';
}

function copyToClipboard(text: string) {
  if (navigator?.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
  }
}

function ExplorerLink({ signature }: { signature: string | null }) {
  if (!signature) return <span className="text-slate-500">—</span>;
  const href = `https://solscan.io/tx/${signature}?cluster=devnet`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-sky-300 hover:text-sky-200 underline"
    >
      {signature}
    </a>
  );
}

export default function App() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<CallTranscript | null>(null);
  const [loadingCall, setLoadingCall] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playgroundOpen, setPlaygroundOpen] = useState(true);
  const [playgroundType, setPlaygroundType] = useState<RunType>('good');
  const [playgroundUrl, setPlaygroundUrl] = useState('/api/good');
  const [playgroundMinReputation, setPlaygroundMinReputation] = useState(0.6);
  const [playgroundMaxPrice, setPlaygroundMaxPrice] = useState(0.05);
  const [playgroundRequireSLA, setPlaygroundRequireSLA] = useState(true);
  const [lastRunInfo, setLastRunInfo] = useState<{ url: string; callId: string; header: string | null } | null>(null);
  const [conformanceUrl, setConformanceUrl] = useState('/api/good');
  const [conformancePolicy, setConformancePolicy] = useState<'strict' | 'balanced' | 'cheap'>('balanced');
  const [conformanceResult, setConformanceResult] = useState<ConformanceResult | null>(null);
  const [conformanceRunning, setConformanceRunning] = useState(false);
  const [traceVerified, setTraceVerified] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'docs'>('dashboard');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoadingSummary(true);
        const data = await fetchSummary();
        if (!active) return;
        setSummary(data);
      } catch (err) {
        if (!active) return;
        console.error(err);
        setError('Failed to load summary');
      } finally {
        if (active) {
          setLoadingSummary(false);
        }
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!selectedCallId) return;
    let active = true;
    async function loadCall() {
      try {
        setLoadingCall(true);
        const data = await fetchCall(selectedCallId);
        if (!active) return;
        setSelectedCall(data);
      } catch (err) {
        if (!active) return;
        console.error(err);
        setError('Failed to load transcript');
      } finally {
        if (active) {
          setLoadingCall(false);
        }
      }
    }
    loadCall();
    return () => {
      active = false;
    };
  }, [selectedCallId]);

  const triggerRun = async (request: RunRequest, runKey: string) => {
    try {
      setRunning(runKey);
      setError(null);
      const transcript = await runFlow(request);
      setSelectedCallId(transcript.callId);
      setSelectedCall(transcript);
      const latest = await fetchSummary();
      setSummary(latest);
      const retryHeaderValue = transcript.retryHeaders?.['X-PAYMENT'] ?? null;
      setLastRunInfo({ url: resolveCurlUrl(request), callId: transcript.callId, header: retryHeaderValue ?? null });
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to run flow');
    } finally {
      setRunning(null);
    }
  };

  const handleQuickRun = (type: RunType) => {
    void triggerRun({ type }, type);
  };

  const handlePlaygroundSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const policy = {
      minReputation: Number(playgroundMinReputation),
      maxPrice: Number(playgroundMaxPrice),
      requireSLA: playgroundRequireSLA,
    };
    await triggerRun(
      {
        type: playgroundType,
        url: playgroundUrl.trim() || undefined,
        policy,
      },
      'playground'
    );
  };

  const handleConformanceTest = async () => {
    try {
      setConformanceRunning(true);
      setError(null);
      const result = await runConformance({ url: conformanceUrl.trim() || undefined, policy: conformancePolicy });
      setConformanceResult(result);
      const latest = await fetchSummary();
      setSummary(latest);
      if (result.receipt?.callId) {
        setSelectedCallId(result.receipt.callId);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Conformance test failed');
    } finally {
      setConformanceRunning(false);
    }
  };

  const services = summary?.services ?? [];
  const recent = summary?.recent ?? [];

  const transcriptJSON = useMemo(() => {
    if (!selectedCall) return '';
    return JSON.stringify(selectedCall.paymentRequirements, null, 2);
  }, [selectedCall]);

  const retryHeader = selectedCall?.retryHeaders?.['X-PAYMENT'] ?? null;
  const maskedRetryHeader = useMemo(() => (retryHeader ? maskHeader(retryHeader) : null), [retryHeader]);
  const [showFullHeader, setShowFullHeader] = useState(false);
  useEffect(() => {
    setShowFullHeader(false);
  }, [selectedCallId]);
  const curlCommands = useMemo(() => {
    if (!lastRunInfo) return null;
    return buildCurlCommands(lastRunInfo.url);
  }, [lastRunInfo]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-white">x402-Assured</h1>
            <p className="text-slate-300">Spec-compatible SLA escrow with disputes & reputation — devnet live.</p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm text-slate-400">
            <span className="rounded-full border border-slate-700 px-3 py-1">Escrow: {ESCROW_PROGRAM_ID}</span>
            <span className="rounded-full border border-slate-700 px-3 py-1">Reputation: {REPUTATION_PROGRAM_ID}</span>
          </div>
        </header>

        <nav className="flex gap-2 border-b border-slate-800 pb-2">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-4 py-2 text-sm font-semibold transition-colors rounded-t-lg ${
              activeTab === 'dashboard'
                ? 'bg-slate-800 text-white border-b-2 border-cyan-500'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab('docs')}
            className={`px-4 py-2 text-sm font-semibold transition-colors rounded-t-lg ${
              activeTab === 'docs'
                ? 'bg-slate-800 text-white border-b-2 border-cyan-500'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Documentation
          </button>
        </nav>

        {activeTab === 'dashboard' && (
        <>
        <div className="grid gap-4 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-lg xl:col-span-3">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.35em] text-slate-500">Why assured?</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Escrow + disputes + reputation without breaking 402.</h2>
              </div>
              <div className="hidden rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-300 md:block">
                <span className="font-semibold text-white">Problem:</span> plain x402 wires funds instantly with no recourse.
                <br />
                <span className="font-semibold text-white">Solution:</span> route through escrow, enforce SLAs, and publish outcomes.
              </div>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {ABOUT_POINTS.map((point) => (
                <article key={point.title} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-sm font-semibold text-white">{point.title}</p>
                  <p className="mt-2 text-sm text-slate-400">{point.body}</p>
                </article>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 text-sm text-slate-300 shadow-lg">
            <h3 className="text-base font-semibold text-white">Trust cues</h3>
            <ul className="mt-3 space-y-2">
              <li>
                <span className="font-semibold text-white">Modes:</span> mock for demos, on-chain for devnet (`ASSURED_MODE`).
              </li>
              <li>
                <span className="font-semibold text-white">Policies:</span> strict/balanced/cheap guard rails wired into the SDK.
              </li>
              <li>
                <span className="font-semibold text-white">Memory:</span> every call → transcript, dispute evidence, and reputation tally.
              </li>
            </ul>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-rose-200">
            {error}
          </div>
        )}

        <section className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl">
              <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
                <h2 className="text-lg font-medium text-white">Services</h2>
                {loadingSummary && <span className="text-xs text-slate-400">Refreshing…</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="bg-slate-900/80 text-slate-400">
                    <tr>
                      <th className="px-6 py-3 text-left font-medium">Service ID</th>
                      <th className="px-6 py-3 text-left font-medium">Score</th>
                      <th className="px-6 py-3 text-left font-medium">OK</th>
                      <th className="px-6 py-3 text-left font-medium">Late</th>
                      <th className="px-6 py-3 text-left font-medium">Disputed</th>
                      <th className="px-6 py-3 text-left font-medium">Bond</th>
                      <th className="px-6 py-3 text-left font-medium">P95</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {services.map((service) => (
                      <tr key={service.serviceId} className="hover:bg-slate-800/60">
                        <td className="px-6 py-3 font-medium text-slate-100">{service.serviceId}</td>
                        <td className="px-6 py-3">
                          <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${scoreColor(service.score)}`}>
                            {(service.score * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="px-6 py-3 text-slate-200">{service.ok}</td>
                        <td className="px-6 py-3 text-slate-200">{service.late}</td>
                        <td className="px-6 py-3 text-slate-200">{service.disputed}</td>
                        <td className="px-6 py-3">
                          {service.hasBond ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-300">
                              ◆ {service.bond ?? '0.00'} SOL
                            </span>
                          ) : (
                            <span className="text-xs text-slate-600">—</span>
                          )}
                        </td>
                        <td className="px-6 py-3">
                          {service.p95Ms ? (
                            <span className="inline-flex items-center rounded-full border border-cyan-500/40 bg-cyan-500/20 px-3 py-1 text-xs font-semibold text-cyan-300">
                              ~{service.p95Ms}ms
                            </span>
                          ) : (
                            <span className="text-xs text-slate-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {services.length === 0 && !loadingSummary && (
                      <tr>
                        <td colSpan={7} className="px-6 py-6 text-center text-slate-500">
                          No services tracked yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl">
              <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
                <h2 className="text-lg font-medium text-white">Recent Calls</h2>
              </div>
              <ul className="divide-y divide-slate-800">
                {recent.map((call) => (
                  <li key={call.callId}>
                    <button
                      type="button"
                      onClick={() => setSelectedCallId(call.callId)}
                      className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left hover:bg-slate-800/60"
                    >
                      <div>
                        <div className="text-sm text-slate-300">{call.serviceId}</div>
                        <div className="text-xs text-slate-500">{call.callId}</div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-xs text-slate-500">{formatTime(call.startedAt)}</span>
                        <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${outcomeChip(call.outcome)}`}>
                          {call.outcome ?? 'PENDING'}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
                {recent.length === 0 && (
                  <li className="px-6 py-6 text-center text-slate-500">No calls yet. Trigger one below.</li>
                )}
              </ul>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-medium text-white">Playground</h2>
                  <p className="mt-1 text-sm text-slate-400">Target any endpoint and override policy.</p>
                </div>
                <button
                  type="button"
                  className="text-xs uppercase tracking-wide text-slate-400 hover:text-slate-200"
                  onClick={() => setPlaygroundOpen((open) => !open)}
                >
                  {playgroundOpen ? 'Hide' : 'Show'}
                </button>
              </div>
              {playgroundOpen && (
                <form onSubmit={handlePlaygroundSubmit} className="mt-4 space-y-4 text-sm">
                  <label className="flex flex-col gap-2 text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Endpoint</span>
                    <div className="flex gap-2">
                      <select
                        value={playgroundType}
                        onChange={(e) => setPlaygroundType(e.target.value as RunType)}
                        className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      >
                        <option value="good">Good</option>
                        <option value="bad">Bad</option>
                        <option value="fallback">Fallback</option>
                      </select>
                      <input
                        type="text"
                        value={playgroundUrl}
                        onChange={(e) => setPlaygroundUrl(e.target.value)}
                        placeholder="/api/good"
                        className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 font-mono text-xs text-slate-100 focus:border-slate-500 focus:outline-none"
                      />
                    </div>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="flex flex-col gap-2 text-slate-300">
                      <span className="text-xs uppercase tracking-wide text-slate-500">Min reputation</span>
                      <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        value={playgroundMinReputation}
                        onChange={(e) => setPlaygroundMinReputation(Number(e.target.value))}
                        className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-slate-500 focus:outline-none"
                      />
                    </label>
                    <label className="flex flex-col gap-2 text-slate-300">
                      <span className="text-xs uppercase tracking-wide text-slate-500">Max price</span>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={playgroundMaxPrice}
                        onChange={(e) => setPlaygroundMaxPrice(Number(e.target.value))}
                        className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-slate-500 focus:outline-none"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-slate-300">
                      <input
                        type="checkbox"
                        checked={playgroundRequireSLA}
                        onChange={(e) => setPlaygroundRequireSLA(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-950 accent-slate-300"
                      />
                      <span className="text-xs uppercase tracking-wide text-slate-500">Require SLA</span>
                    </label>
                  </div>
                <button
                  type="submit"
                  disabled={running !== null}
                  className="w-full rounded-xl bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                >
                  {running === 'playground' ? (
                    <span className="flex items-center justify-center gap-2 text-slate-900">
                      <Spinner /> Running…
                    </span>
                  ) : (
                    'Run custom flow'
                  )}
                </button>
                </form>
              )}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl">
              <h2 className="text-lg font-medium text-white">Quick Actions</h2>
              <p className="mt-1 text-sm text-slate-400">Simulate requests via the SDK.</p>
              <div className="mt-4 flex flex-col gap-3">
                {(Object.keys(RUN_LABELS) as RunType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleQuickRun(type)}
                    disabled={running !== null}
                    className="rounded-xl bg-slate-800 px-4 py-3 text-left font-medium text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-900 disabled:text-slate-500"
                  >
                    {running === type ? (
                      <span className="flex items-center gap-2 text-slate-200">
                        <Spinner /> Running…
                      </span>
                    ) : (
                      RUN_LABELS[type]
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl">
              <h2 className="text-lg font-medium text-white">curl Snippets</h2>
              {curlCommands ? (
                <div className="mt-4 space-y-4 text-xs text-slate-300">
                  <div>
                    <span className="text-slate-400">1 — Request requirements</span>
                    <pre className="mt-1 whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950 p-3">
                      {curlCommands.initial}
                    </pre>
                  </div>
                  <div>
                    <span className="text-slate-400">2 — Retry with receipt</span>
                    <pre className="mt-1 whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950 p-3">
                      {curlCommands.retry}
                    </pre>
                    {lastRunInfo?.header && (
                      <button
                        type="button"
                        className="mt-2 rounded border border-slate-700 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200"
                        onClick={() => copyToClipboard(lastRunInfo.header ?? '')}
                      >
                        Copy last receipt
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500">Receipt headers rotate per run; inspect the transcript drawer for the exact base64 payload.</p>
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-400">Trigger a flow to generate curl commands.</p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl">
              <h2 className="text-lg font-medium text-white">Conformance Tester</h2>
              <form
                className="mt-3 space-y-4 text-sm"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleConformanceTest();
                }}
              >
                <label className="flex flex-col gap-2 text-slate-300">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Endpoint</span>
                  <input
                    type="text"
                    value={conformanceUrl}
                    onChange={(e) => setConformanceUrl(e.target.value)}
                    placeholder="http://localhost:3000/api/good"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 font-mono text-xs text-slate-100 focus:border-slate-500 focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-2 text-slate-300">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Policy preset</span>
                  <select
                    value={conformancePolicy}
                    onChange={(e) => setConformancePolicy(e.target.value as 'strict' | 'balanced' | 'cheap')}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  >
                    <option value="strict">Strict</option>
                    <option value="balanced">Balanced</option>
                    <option value="cheap">Cheap</option>
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={conformanceRunning}
                  className="w-full rounded-xl bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                >
                  {conformanceRunning ? (
                    <span className="flex items-center justify-center gap-2 text-slate-900">
                      <Spinner /> Testing…
                    </span>
                  ) : (
                    'Test endpoint'
                  )}
                </button>
              </form>
              {conformanceResult && (
                <div className="mt-4 space-y-3 text-xs text-slate-300">
                  <div className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold ${checkStatusClass(conformanceResult.ok)}`}>
                    {conformanceResult.ok ? 'Pass' : 'Check failures'}
                  </div>
                  <ul className="space-y-2">
                    {CHECK_ITEMS.map(({ key, label }) => {
                      const status = conformanceResult.checks[key];
                      return (
                        <li
                          key={key}
                          className="flex items-center justify-between rounded-xl border border-slate-800/70 bg-slate-950/40 px-3 py-2"
                        >
                          <div className="flex items-center gap-2 text-slate-200">
                            <span
                              className={`h-2.5 w-2.5 rounded-full ${status.passed ? 'bg-emerald-400' : 'bg-rose-400'}`}
                            />
                            <span>{label}</span>
                          </div>
                          {status.detail && <span className="text-[11px] text-slate-400">{status.detail}</span>}
                        </li>
                      );
                    })}
                  </ul>
                  {conformanceResult.receipt?.callId && (
                    <button
                      type="button"
                      className="rounded border border-slate-700 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200"
                      onClick={() => setSelectedCallId(conformanceResult.receipt?.callId ?? null)}
                    >
                      View transcript ({conformanceResult.receipt.callId})
                    </button>
                  )}
                  {conformanceResult.paymentResponse && (
                    <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-[11px] text-slate-300">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Settlement header</p>
                      <div className="mt-2 flex items-center gap-3 font-mono">
                        <span className="break-all text-[10px]">
                          {maskHeader(conformanceResult.paymentResponse)}
                        </span>
                        <button
                          type="button"
                          className="rounded border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200"
                          onClick={() => copyToClipboard(conformanceResult.paymentResponse ?? '')}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {selectedCall && (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-medium text-white">Transcript</h2>
                    {loadingCall && <p className="text-xs text-slate-500">Updating…</p>}
                  </div>
                  <button
                    type="button"
                    className="text-xs uppercase tracking-wide text-slate-400 hover:text-slate-200"
                    onClick={() => copyToClipboard(JSON.stringify(selectedCall, null, 2))}
                  >
                    Copy JSON
                  </button>
                </div>
                <dl className="mt-4 grid gap-4 text-sm text-slate-300 md:grid-cols-2">
                  <div className="space-y-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Call ID</dt>
                    <dd className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-100">
                      <span className="break-all">{selectedCall.callId}</span>
                      <button
                        type="button"
                        className="rounded border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200"
                        onClick={() => copyToClipboard(selectedCall.callId)}
                      >
                        Copy
                      </button>
                    </dd>
                  </div>
                  <div className="space-y-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Outcome</dt>
                    <dd className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${outcomeChip(selectedCall.outcome)}`}>
                      {selectedCall.outcome ?? 'PENDING'}
                    </dd>
                  </div>
                  <div className="space-y-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Program IDs</dt>
                    <dd className="grid gap-2 text-xs text-slate-200">
                      {(['escrow', 'reputation'] as const).map((key) => (
                        <div key={key} className="rounded-xl border border-slate-800/70 bg-slate-950/50 p-3">
                          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
                            <span>{key}</span>
                            <button
                              type="button"
                              className="rounded border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200"
                              onClick={() => copyToClipboard(selectedCall.programIds[key])}
                            >
                              Copy
                            </button>
                          </div>
                          <span className="mt-1 block break-all font-mono text-[11px]">{selectedCall.programIds[key]}</span>
                        </div>
                      ))}
                    </dd>
                  </div>
                  <div className="space-y-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Init / Fulfill / Settle</dt>
                    <dd className="grid gap-2 text-xs text-slate-200">
                      {([
                        { label: 'Init', sig: selectedCall.tx.init },
                        { label: 'Fulfill', sig: selectedCall.tx.fulfill },
                        { label: 'Settle', sig: selectedCall.tx.settle },
                      ] as const).map(({ label, sig }) => (
                        <div key={label} className="rounded-xl border border-slate-800/70 bg-slate-950/50 p-3">
                          <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
                          {sig ? (
                            <a
                              href={`https://solscan.io/tx/${sig}?cluster=devnet`}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-flex break-all font-mono text-[11px] text-sky-300 hover:text-sky-200"
                            >
                              {sig}
                            </a>
                          ) : (
                            <span className="mt-1 text-slate-500">—</span>
                          )}
                        </div>
                      ))}
                    </dd>
                  </div>
                  {retryHeader && (
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-500">X-PAYMENT header</dt>
                      <dd className="mt-1 flex items-center gap-2 font-mono text-[10px] text-slate-200">
                        <span className="break-all">{maskedRetryHeader}</span>
                        <button
                          type="button"
                          className="rounded border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200"
                          onClick={() => copyToClipboard(retryHeader)}
                        >
                          Copy
                        </button>
                        <button
                          type="button"
                          className="rounded border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200"
                          onClick={() => setShowFullHeader((prev) => !prev)}
                        >
                          {showFullHeader ? 'Collapse' : 'Expand'}
                        </button>
                      </dd>
                      {showFullHeader && (
                        <dd className="mt-1 break-all font-mono text-[10px] text-slate-200">{retryHeader}</dd>
                      )}
                    </div>
                  )}
                  {selectedCall.responseHash && (
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-500">Response hash</dt>
                      <dd className="mt-1 break-all font-mono text-[10px] text-slate-200">{selectedCall.responseHash}</dd>
                    </div>
                  )}
                </dl>
                {selectedCall.trace && (
                  <div className="mt-6">
                    <h3 className="text-xs uppercase tracking-wide text-slate-500">Assured-Trace</h3>
                    <dl className="mt-2 grid grid-cols-1 gap-4 text-xs">
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-slate-500">Signature</dt>
                        <dd className="mt-1 break-all font-mono text-[10px] text-slate-200">{selectedCall.trace.signature}</dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-slate-500">Signer</dt>
                        <dd className="mt-1 break-all font-mono text-[10px] text-slate-200">{selectedCall.trace.signer}</dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-slate-500">Saved At</dt>
                        <dd className="mt-1 font-mono text-[10px] text-slate-200">{new Date(selectedCall.trace.savedAt).toLocaleString()}</dd>
                      </div>
                    </dl>
                    <div className="mt-4 flex items-center gap-3">
                      <button
                        onClick={() => {
                          if (selectedCall.trace) {
                            const isValid = verifyTrace(
                              selectedCall.callId,
                              selectedCall.trace.responseHash,
                              selectedCall.trace.savedAt,
                              selectedCall.trace.signature,
                              selectedCall.trace.signer
                            );
                            setTraceVerified(isValid);
                          }
                        }}
                        className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-200 hover:bg-blue-500/20 transition-colors"
                      >
                        Verify Trace Signature
                      </button>
                      {traceVerified !== null && (
                        <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                          traceVerified
                            ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                            : 'border border-rose-500/40 bg-rose-500/20 text-rose-300'
                        }`}>
                          {traceVerified ? '✓ Valid Signature' : '✗ Invalid Signature'}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {selectedCall.stream && selectedCall.stream.enabled && (
                  <div className="mt-6">
                    <h3 className="text-xs uppercase tracking-wide text-slate-500">Assured-Stream</h3>
                    <div className="mt-2 text-xs text-slate-300">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-400">Progress:</span>
                        <span className="font-semibold text-cyan-300">
                          {selectedCall.stream.unitsReleased} / {selectedCall.stream.totalUnits} units released
                        </span>
                      </div>
                      {selectedCall.stream.timeline && selectedCall.stream.timeline.length > 0 && (
                        <div className="mt-4">
                          <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Timeline</h4>
                          <div className="space-y-2">
                            {selectedCall.stream.timeline.map((release, idx) => (
                              <div
                                key={idx}
                                className="flex items-center gap-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3"
                              >
                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/20 text-xs font-bold text-cyan-300">
                                  {release.index}
                                </span>
                                <div className="flex-1">
                                  <div className="text-[11px] text-slate-400">
                                    {new Date(release.at).toLocaleString()}
                                  </div>
                                  {release.txSig && (
                                    <div className="mt-1">
                                      <ExplorerLink signature={release.txSig} />
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {selectedCall.mirrors && selectedCall.mirrors.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-xs uppercase tracking-wide text-slate-500">Assured-Mirrors (Fallback Mesh)</h3>
                    <div className="mt-2 space-y-3">
                      {selectedCall.mirrors.map((mirror, idx) => {
                        const signerPk = selectedCall.trace?.signer;
                        const isValid = signerPk
                          ? verifyMirrorSig(selectedCall.serviceId, mirror.url, mirror.sig, signerPk)
                          : null;
                        return (
                          <div
                            key={idx}
                            className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Mirror URL</div>
                                <div className="break-all font-mono text-[11px] text-slate-200">{mirror.url}</div>
                                <div className="text-xs uppercase tracking-wide text-slate-500 mt-3 mb-1">Signature</div>
                                <div className="break-all font-mono text-[10px] text-slate-300">{mirror.sig}</div>
                              </div>
                              {isValid !== null && (
                                <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${
                                  isValid
                                    ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                                    : 'border border-rose-500/40 bg-rose-500/20 text-rose-300'
                                }`}>
                                  {isValid ? '✓' : '✗'}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {(selectedCall.webhookVerified !== null || selectedCall.webhookReceivedAt) && (
                  <div className="mt-6">
                    <h3 className="text-xs uppercase tracking-wide text-slate-500">Settlement webhook</h3>
                    <div className="mt-2 flex items-center gap-3 text-xs">
                      {selectedCall.webhookVerified ? (
                        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-emerald-200">
                          HMAC verified
                        </span>
                      ) : (
                        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-200">
                          Received
                        </span>
                      )}
                      {selectedCall.webhookReceivedAt && (
                        <span className="text-slate-400">
                          {new Date(selectedCall.webhookReceivedAt).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {selectedCall.evidence.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-xs uppercase tracking-wide text-slate-500">Evidence</h3>
                    <ul className="mt-2 space-y-2 text-xs text-amber-200">
                      {selectedCall.evidence.map((ev, idx) => (
                        <li key={idx} className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                          <pre className="whitespace-pre-wrap font-mono text-[11px] text-amber-100">{JSON.stringify(ev, null, 2)}</pre>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="mt-6">
                  <h3 className="text-xs uppercase tracking-wide text-slate-500">PaymentRequirements</h3>
                  <pre className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs text-slate-300">
                    {transcriptJSON}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </section>
        </>
        )}

        {activeTab === 'docs' && (
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-xl">
              <h2 className="text-2xl font-semibold text-white mb-6">x402-Assured Documentation</h2>

              <section className="space-y-8">
                <div>
                  <h3 className="text-xl font-semibold text-cyan-400 mb-3">What is x402-Assured?</h3>
                  <p className="text-slate-300 leading-relaxed">
                    x402-Assured extends the HTTP 402 Payment Required protocol with Solana-based escrow, SLA enforcement,
                    reputation tracking, and dispute resolution. It enables trustless micropayments for API calls while
                    maintaining wire-compatibility with the x402 spec.
                  </p>
                </div>

                <div>
                  <h3 className="text-xl font-semibold text-cyan-400 mb-3">Five Differentiating Features</h3>
                  <div className="space-y-4">
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                      <h4 className="font-semibold text-emerald-300 mb-2">1. Assured-Trace (Cryptographic Audit Trail)</h4>
                      <p className="text-sm text-slate-300 leading-relaxed">
                        Every response is signed with Ed25519 signatures, creating an unforgeable audit trail.
                        Clients can verify that the server actually delivered the claimed response hash at the claimed time.
                      </p>
                      <div className="mt-2 text-xs font-mono text-slate-400">
                        PaymentRequirements: trace.signature, trace.signer, trace.responseHash
                      </div>
                    </div>

                    <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4">
                      <h4 className="font-semibold text-cyan-300 mb-2">2. Assured-Stream (Incremental Payment Releases)</h4>
                      <p className="text-sm text-slate-300 leading-relaxed">
                        For long-running operations, funds are released incrementally as progress milestones are reached.
                        Reduces risk for both parties during streaming responses or multi-step workflows.
                      </p>
                      <div className="mt-2 text-xs font-mono text-slate-400">
                        PaymentRequirements: stream=true, totalUnits=N → partial releases via fulfill_partial
                      </div>
                    </div>

                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                      <h4 className="font-semibold text-emerald-300 mb-2">3. Assured-Bond (Stake-Based Reputation)</h4>
                      <p className="text-sm text-slate-300 leading-relaxed">
                        Providers can lock SOL on-chain as collateral, signaling commitment to quality.
                        Bonds are slashed on disputes, creating economic incentive for good behavior.
                      </p>
                      <div className="mt-2 text-xs font-mono text-slate-400">
                        Reputation contract: bond_create, bond_withdraw → visible in dashboard Bond column
                      </div>
                    </div>

                    <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-4">
                      <h4 className="font-semibold text-purple-300 mb-2">4. SLA Scorecards (P95 Latency Tracking)</h4>
                      <p className="text-sm text-slate-300 leading-relaxed">
                        On-chain reputation tracks EWMA and P95 latency estimates. Clients can enforce maximum latency
                        policies before payment, filtering out slow or unreliable providers.
                      </p>
                      <div className="mt-2 text-xs font-mono text-slate-400">
                        Reputation contract: report_latency → p95Ms, ewmaMs → SDK: policy.slaP95MaxMs
                      </div>
                    </div>

                    <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-4">
                      <h4 className="font-semibold text-purple-300 mb-2">5. Signed Fallback Mesh (Verified Mirrors)</h4>
                      <p className="text-sm text-slate-300 leading-relaxed">
                        Providers advertise signed mirror URLs for redundancy. Clients verify signatures before routing,
                        ensuring mirrors are authentic and not malicious redirects.
                      </p>
                      <div className="mt-2 text-xs font-mono text-slate-400">
                        PaymentRequirements: mirrors=[{"{url, sig}"}] → SDK: verifyMirrorSig()
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-xl font-semibold text-cyan-400 mb-3">Architecture</h3>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
                      <h4 className="font-semibold text-white mb-2">On-Chain Components</h4>
                      <ul className="space-y-1 text-sm text-slate-300">
                        <li>• <span className="font-mono text-cyan-300">Escrow Program</span> - Payment locks, SLA enforcement, disputes</li>
                        <li>• <span className="font-mono text-cyan-300">Reputation Program</span> - Scores, bonds, latency tracking</li>
                        <li>• <span className="text-slate-400">Deployed on Solana Devnet</span></li>
                      </ul>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
                      <h4 className="font-semibold text-white mb-2">Off-Chain Components</h4>
                      <ul className="space-y-1 text-sm text-slate-300">
                        <li>• <span className="font-mono text-cyan-300">SDK</span> - Client library with policy enforcement</li>
                        <li>• <span className="font-mono text-cyan-300">Server</span> - Provider API with settlement automation</li>
                        <li>• <span className="font-mono text-cyan-300">CLI</span> - Conformance testing & demos</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-xl font-semibold text-cyan-400 mb-3">Quick Start</h3>
                  <div className="rounded-xl border border-slate-700 bg-slate-950 p-4">
                    <pre className="text-sm text-slate-300 overflow-x-auto">
<code>{`# Install dependencies
pnpm install

# Start server & dashboard
pnpm dev

# Run demos (in separate terminal)
pnpm demo:good    # Successful payment flow
pnpm demo:bad     # Disputed payment flow
pnpm demo:stream  # Streaming payment with partial releases

# Test conformance
pnpm conf http://localhost:3000/api/good`}</code>
                    </pre>
                  </div>
                </div>

                <div>
                  <h3 className="text-xl font-semibold text-cyan-400 mb-3">Usage Example</h3>
                  <div className="rounded-xl border border-slate-700 bg-slate-950 p-4">
                    <pre className="text-sm text-slate-300 overflow-x-auto">
<code>{`import { Assured402Client, balanced } from 'x402-assured/sdk';
import { Connection, Keypair } from '@solana/web3.js';

const client = new Assured402Client({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: loadWallet(),
  escrowProgramId: '...',
  policy: balanced() // minReputation: 0.6, maxPrice: 0.05
});

// Make a payment-required request with automatic policy enforcement
const response = await client.fetch('http://provider.com/api/compute');
const data = await response.json();

// SDK automatically:
// - Checks provider reputation & p95 latency
// - Verifies bond status if required
// - Handles payment via escrow
// - Validates trace signatures
// - Routes to mirrors on failure`}</code>
                    </pre>
                  </div>
                </div>

                <div>
                  <h3 className="text-xl font-semibold text-cyan-400 mb-3">Dashboard Features</h3>
                  <ul className="space-y-2 text-slate-300">
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-1">✓</span>
                      <span><strong className="text-white">Services Table</strong> - View all providers with reputation scores, bond status, and P95 latency</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-1">✓</span>
                      <span><strong className="text-white">Recent Calls</strong> - Track payment flows with transaction links and outcomes</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-1">✓</span>
                      <span><strong className="text-white">Transcript Drawer</strong> - Inspect full payment lifecycle with trace verification</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-1">✓</span>
                      <span><strong className="text-white">Playground</strong> - Test different endpoints with custom policies</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-1">✓</span>
                      <span><strong className="text-white">Conformance Testing</strong> - Validate x402 spec compliance</span>
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="text-xl font-semibold text-cyan-400 mb-3">Resources</h3>
                  <div className="grid md:grid-cols-2 gap-3">
                    <a href="https://github.com/youruser/x402-assured" target="_blank" rel="noreferrer" className="block rounded-lg border border-slate-700 bg-slate-800/50 p-4 hover:border-cyan-500/50 transition-colors">
                      <div className="font-semibold text-white mb-1">GitHub Repository</div>
                      <div className="text-sm text-slate-400">Full source code, contracts, and examples</div>
                    </a>
                    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                      <div className="font-semibold text-white mb-1">x402 Spec</div>
                      <div className="text-sm text-slate-400">Wire-compatible with HTTP 402 protocol</div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
