/**
 * The coordinator's persistent direct-transport identity: a self-signed ECDSA
 * P-256 certificate for DTLS (its SHA-256 fingerprint is what browsers pin),
 * a fixed ICE password and the key that signs local session tickets.
 *
 * Kept in one directory so the fingerprint survives restarts: browsers cache
 * it to connect while the internet is down.
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DirectIdentity {
  readonly certificatePath: string;
  readonly keyPath: string;
  readonly fingerprint: string;
  readonly pwd: string;
  readonly ticketKey: Buffer;
}

function der(tag: number, content: Buffer): Buffer {
  const length = content.length;
  let header: Buffer;
  if (length < 0x80) header = Buffer.from([tag, length]);
  else if (length < 0x100) header = Buffer.from([tag, 0x81, length]);
  else header = Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([header, content]);
}

const sequence = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes));
const ECDSA_SHA256 = sequence(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));

function name(commonName: string): Buffer {
  return sequence(der(0x31, sequence(oid([0x55, 0x04, 0x03]), der(0x0c, Buffer.from(commonName, 'utf8')))));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10)
    + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + 'Z';
  return der(0x17, Buffer.from(text, 'ascii'));
}

/** A minimal self-signed X.509 v3 certificate; DTLS peers only pin its fingerprint. */
export function selfSignedCertificate(privateKeyPem: string, commonName: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const serial = randomBytes(8);
  serial[0] = (serial[0] as number) & 0x7f;
  const notBefore = new Date(Date.now() - 86_400_000);
  const notAfter = new Date(Date.UTC(2049, 11, 31, 0, 0, 0));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ECDSA_SHA256,
    name(commonName),
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name(commonName),
    spki,
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, ECDSA_SHA256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const base64 = certificate.toString('base64').replace(/.{1,64}/g, '$&\n');
  return `-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----\n`;
}

export function certificateFingerprint(certificatePem: string): string {
  const body = certificatePem.replace(/-----[^-]+-----|\s/g, '');
  const digest = createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex').toUpperCase();
  return (digest.match(/../g) as string[]).join(':');
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on exotic file systems */ }
}

export function loadDirectIdentity(directory: string): DirectIdentity {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'cert.pem');
  const secretPath = join(directory, 'secret.json');
  if (!existsSync(keyPath) || !existsSync(certificatePath)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writePrivate(keyPath, pem);
    writeFileSync(certificatePath, selfSignedCertificate(pem, 'miakapp-coordinator'));
  }
  if (!existsSync(secretPath)) {
    writePrivate(secretPath, JSON.stringify({
      // ICE passwords are 22+ characters of [A-Za-z0-9+/].
      pwd: randomBytes(24).toString('base64').replace(/=/g, ''),
      ticketKey: randomBytes(32).toString('base64'),
    }));
  }
  const secret = JSON.parse(readFileSync(secretPath, 'utf8')) as { pwd: string; ticketKey: string };
  return Object.freeze({
    certificatePath,
    keyPath,
    fingerprint: certificateFingerprint(readFileSync(certificatePath, 'utf8')),
    pwd: secret.pwd,
    ticketKey: Buffer.from(secret.ticketKey, 'base64'),
  });
}

export interface TicketClaims {
  readonly userId: string;
  readonly verifiedEmail: string | null;
  readonly expiresAtMs: number;
}

const TICKET_PREFIX = 'mkt1.';

/** A local session ticket: who the relay said the resident was, signed by this coordinator. */
export function issueTicket(key: Buffer, claims: TicketClaims): string {
  const body = Buffer.from(JSON.stringify({ u: claims.userId, e: claims.verifiedEmail, x: claims.expiresAtMs }))
    .toString('base64url');
  const mac = createHmac('sha256', key).update(TICKET_PREFIX + body).digest('base64url');
  return `${TICKET_PREFIX}${body}.${mac}`;
}

export function verifyTicket(key: Buffer, ticket: string, nowMs: number): TicketClaims | undefined {
  if (!ticket.startsWith(TICKET_PREFIX) || ticket.length > 2_048) return undefined;
  const [body, mac] = ticket.slice(TICKET_PREFIX.length).split('.');
  if (body === undefined || mac === undefined) return undefined;
  const expected = createHmac('sha256', key).update(TICKET_PREFIX + body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown; x?: unknown };
    if (typeof parsed.u !== 'string' || typeof parsed.x !== 'number' || parsed.x <= nowMs) return undefined;
    return Object.freeze({
      userId: parsed.u,
      verifiedEmail: typeof parsed.e === 'string' ? parsed.e : null,
      expiresAtMs: parsed.x,
    });
  } catch {
    return undefined;
  }
}
