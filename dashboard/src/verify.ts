// dashboard/src/verify.ts - Browser-compatible verification functions
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';

/**
 * Verify a trace signature from the server
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
    const sigBytes = base64ToUint8Array(signature);
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
 */
export function verifyMirrorSig(
  serviceId: string,
  url: string,
  signature: string,
  signerPublicKey: string
): boolean {
  try {
    const message = buildMirrorMessage(serviceId, url);
    const sigBytes = base64ToUint8Array(signature);
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

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
