import { createHash, randomBytes } from 'node:crypto';
import type { FetchLike } from '../../src/internal/http.js';
import { COMPONENT_ABI } from '../../src/publication.js';

export const ISSUER = 'https://control.example.test/api';

export function randomId(): string {
  return randomBytes(16).toString('base64url');
}

export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function homeKey(): string {
  return `mhk1_${randomId()}_${randomSecret()}`;
}

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

interface Upload {
  readonly uploadId: string;
  readonly token: string;
  readonly release: string;
  readonly sha256: string;
  readonly size: number;
  readonly requires: unknown;
  status: 'awaiting_upload' | 'delivered' | 'finalized';
}

export interface FakeControlPlaneOptions {
  readonly homeId: string;
  /** Generation the component pointer currently holds; 0 means never published. */
  readonly generation?: number;
  /** Forces one response, by exact `${method} ${path}` key, for failure tests. */
  readonly fail?: ReadonlyMap<string, { status: number; code: string }>;
}

export interface FakeControlPlane {
  readonly fetch: FetchLike;
  readonly requests: string[];
  generation: number;
  readonly uploads: Map<string, Upload>;
  readonly releases: Map<string, { release: string; sha256: string; size: number; requires: unknown }>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function failure(status: number, code: string): Response {
  return json(status, {
    error: { code, message: `synthetic ${code}`, retryable: false, request_id: randomId() },
  });
}

/**
 * An in-memory control plane that answers exactly the RFC 0004 §13.2 surface.
 *
 * It is deliberately strict: every response carries the closed schema and the
 * exact field set the CLI decoders demand, so a test failure means the CLI
 * changed, not that the double drifted.
 */
export function fakeControlPlane(options: FakeControlPlaneOptions): FakeControlPlane {
  const base = `${ISSUER}/v1/homes/${options.homeId}`;
  const plane: FakeControlPlane = {
    fetch: async (input, init) => handle(input, init),
    requests: [],
    generation: options.generation ?? 0,
    uploads: new Map(),
    releases: new Map(),
  };

  async function handle(input: string, init: RequestInit): Promise<Response> {
    const method = init.method ?? 'GET';
    const path = input.startsWith(ISSUER) ? input.slice(ISSUER.length) : input;
    const key = `${method} ${path}`;
    plane.requests.push(key);
    const forced = options.fail?.get(key);
    if (forced !== undefined) return failure(forced.status, forced.code);

    if (key === 'GET /.well-known/miakapp-control-plane') {
      return json(200, {
        schema: 'miakapp.control-plane-discovery/1',
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        exchange_endpoint: `${ISSUER}/v1/access-tokens:exchange`,
        user_relay_exchange_endpoint: `${ISSUER}/v1/user-relay-tokens:exchange`,
        push_audience: `${ISSUER}/v1/push`,
        components_audience: `${ISSUER}/v1/components`,
      });
    }

    if (key === 'POST /v1/access-tokens:exchange') {
      const authorization = (init.headers as Record<string, string>)['authorization'] ?? '';
      const keyId = /^Bearer mhk1_([A-Za-z0-9_-]{22})_/.exec(authorization)?.[1];
      if (keyId === undefined) return failure(401, 'invalid_home_key');
      return json(200, {
        schema: 'miakapp.access-token/1',
        access_token: 'header.payload.signature',
        token_type: 'Bearer',
        expires_at_ms: Date.now() + 300_000,
        key: { id: keyId, label: 'test publisher' },
      }, {
        'cache-control': 'no-store',
        pragma: 'no-cache',
        'referrer-policy': 'no-referrer',
      });
    }

    const local = input.startsWith(base) ? input.slice(base.length) : undefined;
    if (local === undefined) return failure(404, 'not_found');

    if (method === 'POST' && local === '/component-uploads') {
      const body = JSON.parse(String(init.body)) as {
        release: string;
        sha256: string;
        size: number;
        requires: unknown;
      };
      const uploadId = randomId();
      plane.uploads.set(uploadId, {
        uploadId,
        token: randomSecret(),
        release: body.release,
        sha256: body.sha256,
        size: body.size,
        requires: body.requires,
        status: 'awaiting_upload',
      });
      const upload = plane.uploads.get(uploadId) as Upload;
      return json(201, {
        schema: 'miakapp.component-upload/1',
        upload_id: uploadId,
        upload_url: `${base}/component-uploads/${uploadId}`,
        upload_token: upload.token,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }

    const finalizeMatch = /^\/component-uploads\/([A-Za-z0-9_-]{22}):finalize$/.exec(local);
    if (method === 'POST' && finalizeMatch !== null) {
      const upload = plane.uploads.get(finalizeMatch[1] as string);
      if (upload === undefined) return failure(404, 'invalid_upload_capability');
      if (upload.status === 'awaiting_upload') return failure(409, 'invalid_artifact');
      upload.status = 'finalized';
      plane.releases.set(upload.sha256, upload);
      return json(200, releaseBody(upload));
    }

    const uploadMatch = /^\/component-uploads\/([A-Za-z0-9_-]{22})$/.exec(local);
    if (uploadMatch !== null) {
      const upload = plane.uploads.get(uploadMatch[1] as string);
      if (upload === undefined) return failure(404, 'invalid_upload_capability');
      if (method === 'PUT') {
        if ((init.headers as Record<string, string>)['authorization']
          !== `Bearer ${upload.token}`) {
          return failure(403, 'invalid_upload_capability');
        }
        const bytes = init.body as Uint8Array;
        if (digestOf(bytes) !== upload.sha256 || bytes.byteLength !== upload.size) {
          return failure(422, 'invalid_artifact');
        }
        upload.status = 'delivered';
        return new Response(null, { status: 204 });
      }
      return json(200, {
        schema: 'miakapp.component-upload-status/1',
        upload_id: upload.uploadId,
        status: upload.status,
        release: upload.release,
        abi: COMPONENT_ABI,
        sha256: upload.sha256,
        size: upload.size,
        requires: upload.requires,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }

    const releaseMatch = /^\/component-releases\/([A-Za-z0-9_-]{43})$/.exec(local);
    if (method === 'GET' && releaseMatch !== null) {
      const record = plane.releases.get(releaseMatch[1] as string);
      if (record === undefined) return failure(422, 'invalid_artifact');
      return json(200, releaseBody(record));
    }

    if (method === 'POST' && local === '/component-releases:activate') {
      const body = JSON.parse(String(init.body)) as {
        sha256: string;
        expected_generation: number;
        generation: number;
      };
      const record = plane.releases.get(body.sha256);
      if (record === undefined) return failure(422, 'invalid_artifact');
      if (body.expected_generation !== plane.generation) {
        return failure(409, 'generation_conflict');
      }
      plane.generation = body.generation;
      return json(200, {
        schema: 'miakapp.component-pointer/1',
        home_id: options.homeId,
        generation: body.generation,
        release: record.release,
        abi: COMPONENT_ABI,
        url: `${ISSUER}/v1/components/${record.sha256}.js`,
        sha256: record.sha256,
        size: record.size,
        requires: record.requires,
      });
    }

    return failure(404, 'not_found');
  }

  function releaseBody(record: {
    release: string;
    sha256: string;
    size: number;
    requires: unknown;
  }): unknown {
    return {
      schema: 'miakapp.component-release/1',
      release: record.release,
      abi: COMPONENT_ABI,
      sha256: record.sha256,
      size: record.size,
      requires: record.requires,
      finalized_at: new Date().toISOString(),
    };
  }

  return plane;
}
