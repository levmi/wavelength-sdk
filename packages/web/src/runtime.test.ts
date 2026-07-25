import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, it, mock } from 'node:test';
import type { WavelengthPerformanceEvent } from '@lightninglabs/wavelength-core';
import { instantiateCompressedWasm } from './runtime.ts';

const savedFetch = globalThis.fetch;
const savedInstantiate = WebAssembly.instantiate;
const savedInstantiateStreaming = WebAssembly.instantiateStreaming;

function stubGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

function stubWebAssembly(name: string, value: unknown): void {
  Object.defineProperty(WebAssembly, name, {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  stubGlobal('fetch', savedFetch);
  stubWebAssembly('instantiate', savedInstantiate);
  stubWebAssembly('instantiateStreaming', savedInstantiateStreaming);
  delete (globalThis as { caches?: unknown }).caches;
});

const WASM_GZ_URL = 'https://runtime.example/wavewalletdk.wasm.gz';

// stubRuntimeCache installs a single-bucket Cache Storage seeded with `entries`,
// and hands back the live map plus the delete log so a test can assert on what
// the loader stored or evicted.
function stubRuntimeCache(entries: Record<string, Response> = {}) {
  const stored = new Map(Object.entries(entries));
  const deleted: string[] = [];
  const cache = {
    async match(url: string) {
      return stored.get(url);
    },
    async put(url: string, response: Response) {
      stored.set(url, response);
    },
    async keys() {
      return [...stored.keys()].map((url) => new Request(url));
    },
    async delete(request: Request | string) {
      const url = typeof request === 'string' ? request : request.url;
      deleted.push(url);

      return stored.delete(url);
    },
  };
  stubGlobal('caches', {
    async open() {
      return cache;
    },
    async keys() {
      return [];
    },
    async delete() {
      return false;
    },
  });

  return { stored, deleted };
}

describe('instantiateCompressedWasm', { concurrency: false }, () => {
  it('uses native streaming when the host serves gzip as wasm', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'application/wasm' },
    });
    stubGlobal('fetch', mock.fn(async () => response));
    const instantiateStreaming = mock.fn(async () => ({
      instance: {} as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    }));
    stubWebAssembly('instantiateStreaming', instantiateStreaming);
    stubWebAssembly('instantiate', mock.fn(async () => {
      throw new Error('buffered instantiation should not run');
    }));
    const samples: WavelengthPerformanceEvent[] = [];

    await instantiateCompressedWasm(
      {},
      'https://runtime.example/',
      (sample) => samples.push(sample),
    );

    assert.equal(instantiateStreaming.mock.callCount(), 1);
    assert.deepEqual(samples.at(-1)?.detail, {
      path: 'gzip',
      streaming: true,
      decompression: 'http',
    });
  });

  it('keeps buffered decompression for application/gzip hosts', async () => {
    const wasmBytes = new Uint8Array([0, 97, 115, 109]);
    const response = new Response(gzipSync(wasmBytes), {
      headers: { 'Content-Type': 'application/gzip' },
    });
    stubGlobal('fetch', mock.fn(async () => response));
    let instantiatedBytes = 0;
    const instantiate = mock.fn(async (bytes: BufferSource) => {
      instantiatedBytes = bytes.byteLength;

      return {
        instance: {} as WebAssembly.Instance,
        module: {} as WebAssembly.Module,
      };
    });
    stubWebAssembly('instantiate', instantiate);
    stubWebAssembly('instantiateStreaming', mock.fn(async () => {
      throw new Error('streaming instantiation should not run');
    }));
    const samples: WavelengthPerformanceEvent[] = [];

    await instantiateCompressedWasm(
      {},
      'https://runtime.example/',
      (sample) => samples.push(sample),
    );

    assert.equal(instantiate.mock.callCount(), 1);
    assert.equal(instantiatedBytes, wasmBytes.byteLength);
    assert.deepEqual(
      samples.find((sample) => sample.phase === 'wasmDecompress')?.detail,
      {
        path: 'gzip',
        bytes: wasmBytes.byteLength,
        streaming: false,
      },
    );
  });
});

describe('instantiateCompressedWasm caching', { concurrency: false }, () => {
  it('instantiates from the cache without touching the network', async () => {
    const wasmBytes = new Uint8Array([0, 97, 115, 109]);
    stubRuntimeCache({ [WASM_GZ_URL]: new Response(wasmBytes) });
    const fetchMock = mock.fn(async () => {
      throw new Error('a cache hit must not fetch');
    });
    stubGlobal('fetch', fetchMock);
    const instantiate = mock.fn(async () => ({
      instance: {} as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    }));
    stubWebAssembly('instantiate', instantiate);
    const samples: WavelengthPerformanceEvent[] = [];

    await instantiateCompressedWasm(
      {},
      'https://runtime.example/',
      (sample) => samples.push(sample),
    );

    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(instantiate.mock.callCount(), 1);
    assert.deepEqual(
      samples.find((sample) => sample.phase === 'wasmCacheRead')?.detail,
      { path: 'gzip', bytes: wasmBytes.byteLength },
    );
    assert.deepEqual(samples.at(-1)?.detail, {
      path: 'gzip',
      streaming: false,
      source: 'cache',
    });
  });

  it('stores the module on a cold load so the next one is warm', async () => {
    const response = new Response(new Uint8Array([0, 97, 115, 109]), {
      headers: { 'Content-Type': 'application/wasm' },
    });
    const { stored } = stubRuntimeCache();
    stubGlobal('fetch', mock.fn(async () => response));
    stubWebAssembly('instantiateStreaming', mock.fn(async () => ({
      instance: {} as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    })));

    await instantiateCompressedWasm({}, 'https://runtime.example/');

    assert.deepEqual([...stored.keys()], [WASM_GZ_URL]);
  });

  it('stores inflated bytes when it inflated them itself', async () => {
    const wasmBytes = new Uint8Array([0, 97, 115, 109]);
    const { stored } = stubRuntimeCache();
    stubGlobal(
      'fetch',
      mock.fn(async () =>
        new Response(gzipSync(wasmBytes), {
          headers: { 'Content-Type': 'application/gzip' },
        }),
      ),
    );
    stubWebAssembly('instantiate', mock.fn(async () => ({
      instance: {} as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    })));

    await instantiateCompressedWasm({}, 'https://runtime.example/');

    // The warm path instantiates whatever is in the cache directly, so a cached
    // entry has to be wasm even when the wire format was gzip.
    const cached = stored.get(WASM_GZ_URL);
    assert.ok(cached);
    assert.deepEqual(
      new Uint8Array(await cached.arrayBuffer()),
      wasmBytes,
    );
  });

  it('evicts unusable cached bytes and falls back to the network', async () => {
    const { deleted } = stubRuntimeCache({
      [WASM_GZ_URL]: new Response(new Uint8Array([9, 9, 9])),
    });
    const fetchMock = mock.fn(async () =>
      new Response(new Uint8Array([0, 97, 115, 109]), {
        headers: { 'Content-Type': 'application/wasm' },
      }),
    );
    stubGlobal('fetch', fetchMock);
    stubWebAssembly('instantiate', mock.fn(async () => {
      throw new Error('bad magic');
    }));
    const instantiateStreaming = mock.fn(async () => ({
      instance: {} as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    }));
    stubWebAssembly('instantiateStreaming', instantiateStreaming);

    await instantiateCompressedWasm({}, 'https://runtime.example/');

    // A corrupt entry must not be able to wedge every subsequent load.
    assert.deepEqual(deleted, [WASM_GZ_URL]);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(instantiateStreaming.mock.callCount(), 1);
  });
});
