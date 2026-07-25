let wasmReady = false;
let loadPromise = null;
let activityHandle = null;
let activityOpen = null;
let activityGeneration = 0;

// The client sends the runtime base URL as this worker's first message (see the
// $init handler below). The bundler fingerprints the worker's own URL, so the
// base can no longer ride in as a query param the way the self-hosted worker's
// did.
let runtimeBaseUrl = "";

// debug mirrors the client's debug option, set from the $init message. When on,
// every RPC request/response is logged - payloads can include addresses and
// amounts, so it stays off unless the consumer opts in.
let debug = false;
let performanceEnabled = false;
function debugTs() {
  return new Date().toISOString().split("T").join(" ").slice(0, -1);
}

function performanceNow() {
  return self.performance?.now?.() ?? Date.now();
}

function postPerformance(phase, startedAt, detail) {
  if (!performanceEnabled || startedAt === undefined) {
    return;
  }

  self.postMessage({
    performance: {
      stage: "runtime",
      phase,
      durationMs: performanceNow() - startedAt,
      detail,
    },
  });
}

function resolveRuntimeAsset(name) {
  if (!runtimeBaseUrl) {
    return name;
  }
  return new URL(
    name,
    runtimeBaseUrl.endsWith("/") ? runtimeBaseUrl : runtimeBaseUrl + "/",
  ).href;
}

function postEvent(type, payload) {
  self.postMessage({
    event: {
      type,
      payload,
    },
  });
}

function rejectAllPending(error) {
  const message = String(error?.message || error);
  postEvent("log", { level: "error", message });
  // go.run() rejecting means the daemon runtime has exited; signal the main
  // thread so it can reject every in-flight RPC instead of hanging forever.
  self.postMessage({ fatal: { message } });
}

self.addEventListener("wavewalletdk-ready", () => {
  wasmReady = true;
  postEvent("runtimeReady");
});

self.onmessage = async (event) => {
  const data = event.data || {};

  // $init carries the runtime base URL and arrives before any RPC. Handle it
  // ahead of ensureLoaded() so asset resolution sees the base on first load.
  if (data.$init) {
    runtimeBaseUrl = data.$init.runtimeBaseUrl || "";
    debug = !!data.$init.debug;
    performanceEnabled = !!data.$init.performance;

    return;
  }

  const { id, method, params } = data;

  try {
    await ensureLoaded();

    if (method === "$ready") {
      self.postMessage({ id, ok: true, result: { ready: true } });

      return;
    }

    // The wasm bridge's `subscribe` verb resolves to a handle whose JS callbacks
    // cannot cross postMessage, so the worker owns the pull loop and forwards
    // each entry to the main thread as an 'activity' event.
    if (method === "$startActivity") {
      const generation = activityGeneration;
      const pending = activityOpen;
      if (!activityHandle && pending?.generation === generation) {
        await pending.promise;
      } else if (!activityHandle) {
        let open;
        const promise = self.wavewalletdkCall("subscribe", params || {})
          .then((handle) => {
            if (activityGeneration !== generation) {
              handle.close();

              return;
            }
            activityHandle = handle;
            pumpActivity(handle);
          })
          .finally(() => {
            if (activityOpen === open) {
              activityOpen = null;
            }
          });
        open = { generation, promise };
        activityOpen = open;
        await promise;
      }
      self.postMessage({ id, ok: true, result: { subscribed: true } });

      return;
    }

    if (method === "$stopActivity") {
      activityGeneration += 1;
      const handle = activityHandle;
      activityHandle = null;
      if (handle) {
        handle.close();
      }
      self.postMessage({ id, ok: true, result: { stopped: true } });

      return;
    }

    if (debug) {
      console.log(`${debugTs()} Executing ${method}:`, params);
    }
    const result = await self.wavewalletdkCall(method, params || {});
    if (debug) {
      console.log(`${debugTs()} Executed ${method} result:`, result);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: String(err?.message || err),
    });
  }
};

async function ensureLoaded() {
  if (wasmReady) {
    return;
  }

  if (!loadPromise) {
    loadPromise = loadRuntime();
  }

  await loadPromise;
}

async function loadRuntime() {
  if (typeof self.CustomEvent !== "function") {
    self.CustomEvent = class CustomEvent extends Event {
      constructor(type, params = {}) {
        super(type, params);
        this.detail = params.detail;
      }
    };
  }

  // sqlite-bridge.js derives the nested sqlite-worker.js URL from
  // document.currentScript, which does not exist in a worker; point it (and the
  // sqlite3.js URL it forwards) at the hosted copies so the nested worker and its
  // wasm load from runtimeBaseUrl rather than relative to this worker's URL.
  self.sqliteBridgeWorkerURL = resolveRuntimeAsset("sqlite-worker.js");
  self.sqliteBridgeSQLiteJSURL = resolveRuntimeAsset("sqlite3.js");

  const sqliteStartedAt = performanceEnabled ? performanceNow() : undefined;
  importScripts(resolveRuntimeAsset("sqlite-bridge.js"));
  postPerformance("sqliteBridgeScript", sqliteStartedAt, {
    transport: "worker",
  });

  const goScriptStartedAt = performanceEnabled ? performanceNow() : undefined;
  importScripts(resolveRuntimeAsset("wasm_exec.js"));
  postPerformance("wasmExecScript", goScriptStartedAt, {
    transport: "worker",
  });

  const go = new Go();
  const result = await instantiateWasm(go.importObject);
  const goReadyStartedAt = performanceEnabled ? performanceNow() : undefined;
  const runPromise = go.run(result.instance);
  runPromise.catch(rejectAllPending);

  await waitForWASMReady();
  postPerformance("goReady", goReadyStartedAt, { transport: "worker" });
}

function waitForWASMReady() {
  if (wasmReady) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    self.addEventListener("wavewalletdk-ready", () => resolve(), { once: true });
  });
}

// The runtime cache below mirrors runtime-cache.ts. This worker ships as a
// standalone file the consumer's bundler emits, so it cannot import from the
// package; keep the two in sync. See that module for why the cache exists at
// all (short version: the browser refuses to keep a 20 MB wasm module in the
// HTTP cache, so every load re-downloads it) and for the release-pruning rules.
const RUNTIME_CACHE_NAME = "wavelength-runtime-v1";
const RUNTIME_CACHE_PREFIX = "wavelength-runtime-";

function absoluteRuntimeUrl(url) {
  try {
    return new Request(url).url;
  } catch {
    return url;
  }
}

async function openRuntimeCache() {
  let caches;
  try {
    caches = self.caches;
  } catch {
    return undefined;
  }
  if (!caches) {
    return undefined;
  }

  try {
    const cache = await caches.open(RUNTIME_CACHE_NAME);
    void dropSupersededCaches(caches);

    return cache;
  } catch {
    return undefined;
  }
}

async function dropSupersededCaches(caches) {
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(
          (name) =>
            name.startsWith(RUNTIME_CACHE_PREFIX) &&
            name !== RUNTIME_CACHE_NAME,
        )
        .map((name) => caches.delete(name)),
    );
  } catch {
    // A cache we cannot enumerate is one we cannot clean up. Harmless.
  }
}

async function storeRuntimeAsset(cache, url, response) {
  try {
    await cache.put(url, response);
  } catch {
    // An origin over quota rejects the write; there is nothing to be done.
    return false;
  }

  try {
    const keep = absoluteRuntimeUrl(url);
    const stale = (await cache.keys()).filter(
      (request) => request.url !== keep,
    );
    await Promise.all(stale.map((request) => cache.delete(request)));
  } catch {
    // Leaving a stale runtime behind costs disk, not correctness.
  }

  return true;
}

// instantiateCachedWasm instantiates a copy stored by an earlier visit, or
// returns undefined when there is nothing usable cached. The cache always holds
// decompressed wasm, whatever encoding it arrived in, so this is a plain read
// and instantiate. Bytes that fail to instantiate are evicted and reported as a
// miss so a broken entry cannot wedge every later load.
async function instantiateCachedWasm(cache, url, path, importObject) {
  let cached;
  try {
    cached = await cache.match(url);
  } catch {
    return undefined;
  }
  if (!cached) {
    return undefined;
  }

  const readStartedAt = performanceEnabled ? performanceNow() : undefined;
  try {
    const bytes = await cached.arrayBuffer();
    postPerformance("wasmCacheRead", readStartedAt, {
      path,
      bytes: bytes.byteLength,
    });

    const compileStartedAt = performanceEnabled ? performanceNow() : undefined;
    try {
      return await WebAssembly.instantiate(bytes, importObject);
    } finally {
      postPerformance("wasmCompileInstantiate", compileStartedAt, {
        path,
        streaming: false,
        source: "cache",
      });
    }
  } catch (err) {
    postEvent("log", {
      level: "warn",
      message: `cached wasm load failed: ${String(err?.message || err)}`,
    });
    try {
      await cache.delete(url);
    } catch {
      // An entry we cannot delete is one the next load will retry.
    }

    return undefined;
  }
}

async function instantiateWasm(importObject) {
  const startedAt = performanceEnabled ? performanceNow() : undefined;
  let path = "raw";
  try {
    if ("DecompressionStream" in self) {
      try {
        path = "gzip";
        return await instantiateCompressedWasm(importObject);
      } catch (err) {
        postEvent("log", {
          level: "warn",
          message: `compressed wasm load failed: ${String(err?.message || err)}`,
        });
        path = "raw";
      }
    }

    return await instantiateRawWasm(importObject);
  } finally {
    postPerformance("wasmTotal", startedAt, { path });
  }
}

async function instantiateCompressedWasm(importObject) {
  const url = resolveRuntimeAsset("wavewalletdk.wasm.gz");
  const cache = await openRuntimeCache();
  if (cache) {
    const cached = await instantiateCachedWasm(cache, url, "gzip", importObject);
    if (cached) {
      return cached;
    }
  }

  const fetchStartedAt = performanceEnabled ? performanceNow() : undefined;
  const response = await fetch(url);
  postPerformance("wasmFetchHeaders", fetchStartedAt, { path: "gzip" });
  if (!response.ok) {
    throw new Error(
      `Wavelength runtime asset could not be loaded from ${url}. Host the ` +
        "daemon runtime assets and point runtimeBaseUrl at them.",
    );
  }

  const contentEncoding =
    response.headers.get("content-encoding")?.toLowerCase() || "";
  const contentType =
    response.headers.get("content-type")?.split(";", 1)[0].trim() || "";
  // Content-Encoding is not exposed by every cross-origin host. The wasm MIME
  // type is also a signal because a raw .gz asset is normally application/gzip.
  if (contentEncoding.includes("gzip") || contentType === "application/wasm") {
    // The transport already inflated the body, so the clone we stash is exactly
    // the wasm the warm path wants. The write is not awaited: filling the cache
    // must not slow down the load that fills it.
    if (cache) {
      void storeRuntimeAsset(cache, url, response.clone());
    }

    const compileStartedAt = performanceEnabled ? performanceNow() : undefined;
    try {
      return await WebAssembly.instantiateStreaming(response, importObject);
    } finally {
      postPerformance("wasmCompileInstantiate", compileStartedAt, {
        path: "gzip",
        streaming: true,
        decompression: "http",
      });
    }
  }

  if (!response.body) {
    throw new Error(`Wavelength compressed wasm response from ${url} is empty.`);
  }

  const decompressStartedAt = performanceEnabled ? performanceNow() : undefined;
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = await new Response(stream).arrayBuffer();
  postPerformance("wasmDecompress", decompressStartedAt, {
    path: "gzip",
    bytes: bytes.byteLength,
    streaming: false,
  });

  // Here the host served a plain .gz that we inflated ourselves, so we store the
  // inflated bytes rather than the response. That keeps one invariant for the
  // warm path: whatever the encoding on the wire, the cache holds wasm.
  if (cache) {
    void storeRuntimeAsset(cache, url, new Response(bytes));
  }

  const compileStartedAt = performanceEnabled ? performanceNow() : undefined;
  try {
    return await WebAssembly.instantiate(bytes, importObject);
  } finally {
    postPerformance("wasmCompileInstantiate", compileStartedAt, {
      path: "gzip",
      streaming: false,
    });
  }
}

async function instantiateRawWasm(importObject) {
  const url = resolveRuntimeAsset("wavewalletdk.wasm");
  const cache = await openRuntimeCache();
  if (cache) {
    const cached = await instantiateCachedWasm(cache, url, "raw", importObject);
    if (cached) {
      return cached;
    }
  }

  const fetchStartedAt = performanceEnabled ? performanceNow() : undefined;
  const response = await fetch(url);
  postPerformance("wasmFetchHeaders", fetchStartedAt, { path: "raw" });
  if (!response.ok) {
    throw new Error(
      `Wavelength runtime asset could not be loaded from ${url}. Host the ` +
        "daemon runtime assets and point runtimeBaseUrl at them.",
    );
  }

  // An uncompressed host serves the wasm as-is, so the body is already what the
  // warm path wants to instantiate.
  if (cache) {
    void storeRuntimeAsset(cache, url, response.clone());
  }

  const compileStartedAt = performanceEnabled ? performanceNow() : undefined;
  try {
    return await WebAssembly.instantiateStreaming(response, importObject);
  } catch {
    // instantiateStreaming requires the host to serve the wasm as
    // application/wasm; fall back to ArrayBuffer instantiation so a
    // misconfigured MIME type does not break self-hosted runtimes.
    const retry = await fetch(url);
    if (!retry.ok) {
      throw new Error(
        `Wavelength runtime asset could not be loaded from ${url}. Host the ` +
          "daemon runtime assets and point runtimeBaseUrl at them.",
      );
    }
    const bytes = await retry.arrayBuffer();
    return WebAssembly.instantiate(bytes, importObject);
  } finally {
    postPerformance("wasmCompileInstantiate", compileStartedAt, {
      path: "raw",
    });
  }
}

// pumpActivity drains the subscription handle, forwarding each entry to the
// main thread until the stream ends (next() resolves null) or $stopActivity
// swaps the handle out.
async function pumpActivity(handle) {
  try {
    for (
      let entry = await handle.next();
      entry !== null && activityHandle === handle;
      entry = await handle.next()
    ) {
      postEvent("activity", entry);
    }
    // A stream that ends while this is still the active handle was not closed
    // by $stopActivity; signal it so the host can resubscribe. A handle
    // swapped out by $stopActivity is an expected close and stays silent.
    if (activityHandle === handle) {
      activityHandle = null;
      postEvent("activityStream", { state: "ended" });
    }
  } catch (err) {
    // An error after a client-initiated close is expected; only surface a
    // failure the consumer did not cause.
    if (activityHandle === handle) {
      activityHandle = null;
      postEvent("activityStream", {
        state: "failed",
        message: String(err?.message || err),
      });
    }
  }
}
