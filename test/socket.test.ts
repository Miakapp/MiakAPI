import { describe, expect, test } from 'bun:test';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { SocketHandlers } from '../src/internal/runtime.js';
import { createProductionRuntime, WsSocketFactory } from '../src/internal/socket.js';
import { LIMITS } from '../src/protocol/codec.js';

function bytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function listeningPort(server: WebSocketServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('WebSocket test server has no TCP address');
  }
  return address.port;
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  server.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('production WebSocket adapter', () => {
  test('rejects an already aborted connection attempt without opening a socket', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before connect');
    controller.abort(reason);
    const failure = await new WsSocketFactory().connect(
      'ws://127.0.0.1:1',
      { message() {}, close() {}, error() {} },
      controller.signal,
    ).catch((error: unknown) => error);

    expect(failure).toBe(reason);
  });

  test('rejects a failed WebSocket handshake', async () => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, complete) => complete(false, 401, 'Denied'),
    });
    const port = await listeningPort(server);
    const failure = await new WsSocketFactory().connect(
      `ws://127.0.0.1:${port}`,
      { message() {}, close() {}, error() {} },
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    await closeServer(server);
  });

  test('carries binary frames in both directions', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    const port = await listeningPort(server);
    let negotiatedProtocol: string | undefined;
    const receivedByServer = new Promise<Uint8Array>((resolve, reject) => {
      server.once('connection', (socket) => {
        negotiatedProtocol = socket.protocol;
        socket.once('message', (data, isBinary) => {
          if (!isBinary) reject(new Error('Client sent a text frame'));
          else resolve(bytes(data));
        });
        socket.send(new Uint8Array([4, 5, 6]), { binary: true });
      });
    });
    let resolveInbound: ((value: Uint8Array) => void) | undefined;
    const inbound = new Promise<Uint8Array>((resolve) => {
      resolveInbound = resolve;
    });
    const failures: Error[] = [];
    const handlers: SocketHandlers = {
      message: (value) => resolveInbound?.(value),
      close() {},
      error: (error) => failures.push(error),
    };
    const controller = new AbortController();
    const socket = await new WsSocketFactory().connect(
      `ws://127.0.0.1:${port}`,
      handlers,
      controller.signal,
    );

    expect([...await inbound]).toEqual([4, 5, 6]);
    await socket.write(new Uint8Array([1, 2, 3]));
    expect([...await receivedByServer]).toEqual([1, 2, 3]);
    expect(negotiatedProtocol).toBe('miakapp');
    expect(failures).toEqual([]);

    socket.terminate();
    socket.detach();
    await closeServer(server);
  });

  test('rejects text relay messages and terminates the connection', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    const port = await listeningPort(server);
    server.once('connection', (socket) => socket.send('not binary'));
    let resolveFailure: ((error: Error) => void) | undefined;
    const failure = new Promise<Error>((resolve) => {
      resolveFailure = resolve;
    });
    const socket = await new WsSocketFactory().connect(
      `ws://127.0.0.1:${port}`,
      {
        message() {},
        close() {},
        error: (error) => resolveFailure?.(error),
      },
      new AbortController().signal,
    );

    expect((await failure).message).toMatch(/non-binary/);
    socket.detach();
    await closeServer(server);
  });

  test('detaches callbacks while retaining safe late socket handling', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    const port = await listeningPort(server);
    let peer: WebSocket | undefined;
    server.once('connection', (socket) => {
      peer = socket;
    });
    const callbacks: string[] = [];
    const socket = await new WsSocketFactory().connect(
      `ws://127.0.0.1:${port}`,
      {
        message: () => callbacks.push('message'),
        close: () => callbacks.push('close'),
        error: () => callbacks.push('error'),
      },
      new AbortController().signal,
    );
    socket.detach();
    peer?.terminate();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(callbacks).toEqual([]);
    await closeServer(server);
  });

  test('bounds writes and terminates an active socket on abort', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    const port = await listeningPort(server);
    let resolveClose: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const controller = new AbortController();
    const socket = await new WsSocketFactory().connect(
      `ws://127.0.0.1:${port}`,
      {
        message() {},
        close: () => resolveClose?.(),
        error() {},
      },
      controller.signal,
    );

    await expect(socket.write(new Uint8Array(LIMITS.frameBytes + 1))).rejects.toThrow(/queue limit/);
    controller.abort(new Error('test abort'));
    await closed;
    socket.detach();
    await closeServer(server);
  });

  test('provides cancellable production timers', async () => {
    const runtime = createProductionRuntime();
    let cancelledTimerRan = false;
    const cancelled = runtime.setTimer(() => {
      cancelledTimerRan = true;
    }, 0);
    cancelled.cancel();
    await new Promise<void>((resolve) => runtime.setTimer(resolve, 0));

    expect(cancelledTimerRan).toBe(false);
    expect(Number.isFinite(runtime.now())).toBe(true);
    expect(runtime.random()).toBeGreaterThanOrEqual(0);
    expect(runtime.random()).toBeLessThan(1);
  });
});
