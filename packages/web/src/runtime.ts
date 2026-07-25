import {
  errorMessage,
  WavelengthError,
  type WavelengthPerformanceListener,
} from '@lightninglabs/wavelength-core';
import { performanceNow, reportPerformance } from './performance.ts';
import {
  evictRuntimeAsset,
  matchRuntimeAsset,
  openRuntimeCache,
  storeRuntimeAsset,
} from './runtime-cache.ts';
import { RUNTIME_ASSETS } from './runtime-manifest.ts';

/**
 * Resolves a runtime asset name against an optional base URL. With no base the
 * bare name is returned so it resolves relative to the page; otherwise the name
 * is resolved against the base (a trailing slash is added when missing).
 */
export function resolveRuntimeAsset(
  base: string | undefined,
  name: string,
): string {
  if (!base) {
    return name;
  }

  return new URL(name, base.endsWith('/') ? base : base + '/').href;
}

/**
 * Builds an actionable failure for a runtime binary that could not be loaded: it
 * names the URL that failed and points at runtimeBaseUrl, which is almost always
 * the cause (assets not hosted, or the base set wrong). The daemon binaries to
 * host are listed in RUNTIME_ASSET_FILES.
 */
export function runtimeAssetError(url: string): WavelengthError {
  return new WavelengthError(
    `Wavelength runtime asset could not be loaded from ${url}. Host the daemon ` +
      'runtime assets (RUNTIME_ASSET_FILES) and point runtimeBaseUrl at them.',
    'asset_load_failed',
  );
}

/**
 * Injects a `<script>` tag for the given source and resolves once it loads. A
 * second call for an already-present src resolves immediately, so the same asset
 * is never loaded twice.
 */
export function loadScript(src: string): Promise<void> {
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(runtimeAssetError(src));
    document.head.append(script);
  });
}

/**
 * Resolves once the wasm runtime is ready, either immediately when the global
 * wavewalletdkCall hook is already installed or on the next 'wavewalletdk-ready'
 * event.
 */
export function waitForReadyEvent(): Promise<void> {
  if (typeof wavewalletdkCall() === 'function') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    globalThis.addEventListener('wavewalletdk-ready', () => resolve(), {
      once: true,
    });
  });
}

/**
 * Returns the global wavewalletdkCall hook the wasm runtime installs, or
 * undefined before the runtime has booted.
 */
export function wavewalletdkCall() {
  return (
    globalThis as typeof globalThis & {
      wavewalletdkCall?: (method: string, params?: unknown) => Promise<unknown>;
    }
  ).wavewalletdkCall;
}

/**
 * Instantiates the wasm module, preferring the gzip-compressed binary when the
 * browser supports DecompressionStream and falling back to the raw binary
 * (logging a warning) if the compressed path fails.
 */
export async function instantiateWasm(
  importObject: WebAssembly.Imports,
  base: string | undefined,
  onPerformance?: WavelengthPerformanceListener,
) {
  const startedAt = onPerformance ? performanceNow() : undefined;
  let path = 'raw';
  try {
    if ('DecompressionStream' in globalThis) {
      try {
        path = 'gzip';
        return await instantiateCompressedWasm(importObject, base, onPerformance);
      } catch (err) {
        console.warn(`compressed wasm load failed: ${errorMessage(err)}`);
        path = 'raw';
      }
    }

    return await instantiateRawWasm(importObject, base, onPerformance);
  } finally {
    if (startedAt !== undefined) {
      reportPerformance(onPerformance, {
        stage: 'runtime',
        phase: 'wasmTotal',
        durationMs: performanceNow() - startedAt,
        detail: { path },
      });
    }
  }
}

/**
 * Instantiates the module from a copy stored by an earlier visit, or returns
 * undefined when nothing is cached.
 *
 * The cache always holds decompressed wasm, whatever encoding it arrived in, so
 * this is a plain read and instantiate. Bytes that fail to instantiate are
 * evicted and reported as a miss, which lets the caller fall back to the
 * network: a truncated or otherwise broken entry must not be able to wedge the
 * wallet on every subsequent load.
 */
async function instantiateCachedWasm(
  cache: Cache,
  url: string,
  path: string,
  importObject: WebAssembly.Imports,
  onPerformance?: WavelengthPerformanceListener,
) {
  const cached = await matchRuntimeAsset(cache, url);
  if (!cached) {
    return undefined;
  }

  const readStartedAt = onPerformance ? performanceNow() : undefined;
  try {
    const bytes = await cached.arrayBuffer();
    if (readStartedAt !== undefined) {
      reportPerformance(onPerformance, {
        stage: 'runtime',
        phase: 'wasmCacheRead',
        durationMs: performanceNow() - readStartedAt,
        detail: { path, bytes: bytes.byteLength },
      });
    }

    const compileStartedAt = onPerformance ? performanceNow() : undefined;
    try {
      return await WebAssembly.instantiate(bytes, importObject);
    } finally {
      if (compileStartedAt !== undefined) {
        reportPerformance(onPerformance, {
          stage: 'runtime',
          phase: 'wasmCompileInstantiate',
          durationMs: performanceNow() - compileStartedAt,
          detail: { path, streaming: false, source: 'cache' },
        });
      }
    }
  } catch (err) {
    console.warn(`cached wasm load failed: ${errorMessage(err)}`);
    await evictRuntimeAsset(cache, url);

    return undefined;
  }
}

/**
 * Fetches the gzip-compressed wasm binary, inflates it through a
 * DecompressionStream, and instantiates the resulting bytes.
 */
export async function instantiateCompressedWasm(
  importObject: WebAssembly.Imports,
  base: string | undefined,
  onPerformance?: WavelengthPerformanceListener,
) {
  const url = resolveRuntimeAsset(base, RUNTIME_ASSETS.wasmGz);
  const cache = await openRuntimeCache();
  if (cache) {
    const cached = await instantiateCachedWasm(
      cache,
      url,
      'gzip',
      importObject,
      onPerformance,
    );
    if (cached) {
      return cached;
    }
  }

  const fetchStartedAt = onPerformance ? performanceNow() : undefined;
  const response = await fetch(url);
  if (fetchStartedAt !== undefined) {
    reportPerformance(onPerformance, {
      stage: 'runtime',
      phase: 'wasmFetchHeaders',
      durationMs: performanceNow() - fetchStartedAt,
      detail: { path: 'gzip' },
    });
  }
  if (!response.ok) {
    throw runtimeAssetError(url);
  }

  const contentEncoding =
    response.headers.get('content-encoding')?.toLowerCase() ?? '';
  const contentType =
    response.headers.get('content-type')?.split(';', 1)[0].trim() ?? '';
  // Content-Encoding is not exposed by every cross-origin host. The wasm MIME
  // type is also a signal because a raw .gz asset is normally application/gzip.
  if (contentEncoding.includes('gzip') || contentType === 'application/wasm') {
    // The transport already inflated the body, so the clone we stash is exactly
    // the wasm the warm path wants. We deliberately don't await the write:
    // filling the cache must not slow down the load that fills it.
    if (cache) {
      void storeRuntimeAsset(cache, url, response.clone());
    }

    const compileStartedAt = onPerformance ? performanceNow() : undefined;
    try {
      return await WebAssembly.instantiateStreaming(response, importObject);
    } finally {
      if (compileStartedAt !== undefined) {
        reportPerformance(onPerformance, {
          stage: 'runtime',
          phase: 'wasmCompileInstantiate',
          durationMs: performanceNow() - compileStartedAt,
          detail: {
            path: 'gzip',
            streaming: true,
            decompression: 'http',
          },
        });
      }
    }
  }

  const body = response.body;
  if (!body) {
    throw new WavelengthError('Wavelength compressed wasm response is empty');
  }

  const decompressStartedAt = onPerformance ? performanceNow() : undefined;
  const stream = body.pipeThrough(new DecompressionStream('gzip'));
  const bytes = await new Response(stream).arrayBuffer();
  if (decompressStartedAt !== undefined) {
    reportPerformance(onPerformance, {
      stage: 'runtime',
      phase: 'wasmDecompress',
      durationMs: performanceNow() - decompressStartedAt,
      detail: {
        path: 'gzip',
        bytes: bytes.byteLength,
        streaming: false,
      },
    });
  }

  // Here the host served a plain .gz that we inflated ourselves, so we store the
  // inflated bytes rather than the response. That keeps one invariant for the
  // warm path: whatever the encoding on the wire, the cache holds wasm.
  if (cache) {
    void storeRuntimeAsset(cache, url, new Response(bytes));
  }

  const compileStartedAt = onPerformance ? performanceNow() : undefined;
  try {
    return await WebAssembly.instantiate(bytes, importObject);
  } finally {
    if (compileStartedAt !== undefined) {
      reportPerformance(onPerformance, {
        stage: 'runtime',
        phase: 'wasmCompileInstantiate',
        durationMs: performanceNow() - compileStartedAt,
        detail: { path: 'gzip', streaming: false },
      });
    }
  }
}

/**
 * Fetches the uncompressed wasm binary and instantiates it via streaming
 * compilation.
 */
export async function instantiateRawWasm(
  importObject: WebAssembly.Imports,
  base: string | undefined,
  onPerformance?: WavelengthPerformanceListener,
) {
  const url = resolveRuntimeAsset(base, RUNTIME_ASSETS.wasm);
  const cache = await openRuntimeCache();
  if (cache) {
    const cached = await instantiateCachedWasm(
      cache,
      url,
      'raw',
      importObject,
      onPerformance,
    );
    if (cached) {
      return cached;
    }
  }

  const fetchStartedAt = onPerformance ? performanceNow() : undefined;
  const response = await fetch(url);
  if (fetchStartedAt !== undefined) {
    reportPerformance(onPerformance, {
      stage: 'runtime',
      phase: 'wasmFetchHeaders',
      durationMs: performanceNow() - fetchStartedAt,
      detail: { path: 'raw' },
    });
  }
  if (!response.ok) {
    throw runtimeAssetError(url);
  }

  // An uncompressed host serves the wasm as-is, so the body is already what the
  // warm path wants to instantiate.
  if (cache) {
    void storeRuntimeAsset(cache, url, response.clone());
  }

  const compileStartedAt = onPerformance ? performanceNow() : undefined;
  try {
    return await WebAssembly.instantiateStreaming(response, importObject);
  } catch {
    // instantiateStreaming requires the host to serve the wasm as
    // application/wasm; fall back to ArrayBuffer instantiation so a
    // misconfigured MIME type does not break self-hosted runtimes.
    const retry = await fetch(url);
    if (!retry.ok) {
      throw runtimeAssetError(url);
    }
    const bytes = await retry.arrayBuffer();
    return WebAssembly.instantiate(bytes, importObject);
  } finally {
    if (compileStartedAt !== undefined) {
      reportPerformance(onPerformance, {
        stage: 'runtime',
        phase: 'wasmCompileInstantiate',
        durationMs: performanceNow() - compileStartedAt,
        detail: { path: 'raw' },
      });
    }
  }
}

/**
 * The base the worker resolves daemon assets against when the consumer leaves
 * runtimeBaseUrl unset. The worker resolves bare asset names against its own
 * bundled URL rather than the page, so to match main-thread mode (which resolves
 * page-relative) we hand it the document's directory. Falls back to '' off the
 * main thread, where the worker cannot run.
 */
export function defaultWorkerRuntimeBaseUrl(): string {
  if (typeof document !== 'undefined' && document.baseURI) {
    return new URL('.', document.baseURI).href;
  }

  return '';
}
