import type { SummaryResponse, CallTranscript, RunRequest, ConformanceResult } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function fetchSummary(): Promise<SummaryResponse> {
  const res = await fetch(`${API_BASE}/summary`);
  return handleResponse<SummaryResponse>(res);
}

export async function fetchCall(callId: string): Promise<CallTranscript> {
  const res = await fetch(`${API_BASE}/calls/${encodeURIComponent(callId)}`);
  return handleResponse<CallTranscript>(res);
}

export async function runFlow(body: RunRequest): Promise<CallTranscript> {
  const res = await fetch(`${API_BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse<CallTranscript>(res);
}

export async function runConformance(body: { url?: string; policy?: string }): Promise<ConformanceResult> {
  const res = await fetch(`${API_BASE}/conformance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse<ConformanceResult>(res);
}
