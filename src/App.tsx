import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHAIN_IDS,
  getChainConfig,
  isNodeSynced,
  type KovanicaClient,
  KovanicaClient as SdkClient,
  type MiningInfo,
  type SyncStatus,
} from "kovanica-sdk";
import {
  ALLOWLISTED_METHODS,
  type MethodDefinition,
  validateParam,
} from "./methods";

// Safe JSON serializer that handles BigInt without throwing
function formatJson(data: unknown): string {
  if (data === undefined) return "undefined";
  return JSON.stringify(
    data,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

interface FetchErrorInfo {
  hasCorsEvidence: boolean;
  message: string;
}

export type SyncBadgeState = "synced" | "catching-up" | "unknown" | "connection-error" | "offline";

export default function App() {
  // Target Network & Endpoint
  const [selectedChainId, setSelectedChainId] = useState<number>(CHAIN_IDS.HYBRID_TESTNET);
  const [rpcUrl, setRpcUrl] = useState<string>("http://127.0.0.1:8545/rpc");
  const [connectedNodeChainId, setConnectedNodeChainId] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [miningInfo, setMiningInfo] = useState<MiningInfo | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [isProbing, setIsProbing] = useState<boolean>(false);
  const [fetchErrorInfo, setFetchErrorInfo] = useState<FetchErrorInfo | null>(null);

  // Method Explorer state
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [selectedMethodName, setSelectedMethodName] = useState<string>("kovanica_blockNumber");
  const [paramValues, setParamValues] = useState<Record<string, any>>({});
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});

  // Execution state
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [requestPayload, setRequestPayload] = useState<string | null>(null);
  const [responsePayload, setResponsePayload] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState<string | null>(null);

  // Tab visibility
  const [isTabVisible, setIsTabVisible] = useState<boolean>(true);

  // In-flight request controller
  const activeAbortController = useRef<AbortController | null>(null);
  const activeProbeAbortController = useRef<AbortController | null>(null);
  const probeSequenceRef = useRef<number>(0);

  // Selected method definition
  const currentMethod: MethodDefinition = useMemo(() => {
    return (
      ALLOWLISTED_METHODS.find((m) => m.method === selectedMethodName) ||
      ALLOWLISTED_METHODS[0]
    );
  }, [selectedMethodName]);

  // Client instance
  const client: KovanicaClient = useMemo(() => {
    return new SdkClient(rpcUrl);
  }, [rpcUrl]);

  // Distinct sync state computation
  const syncState: SyncBadgeState = useMemo(() => {
    if (nodeError) return "connection-error";
    if (!syncStatus) return "offline";
    if (syncStatus.catchingUp === true) return "catching-up";
    const confirmed = isNodeSynced(syncStatus);
    if (confirmed === true) return "synced";
    if (confirmed === false) return "catching-up";
    return "unknown";
  }, [nodeError, syncStatus]);

  // Clear stale network and mining diagnostics
  const clearDiagnostics = useCallback(() => {
    setSyncStatus(null);
    setMiningInfo(null);
    setConnectedNodeChainId(null);
    setNodeError(null);
    setFetchErrorInfo(null);
  }, []);

  // Probe node health and capabilities
  const probeNode = useCallback(async () => {
    if (!rpcUrl || !isTabVisible) return;

    // Abort in-flight probe if any
    if (activeProbeAbortController.current) {
      activeProbeAbortController.current.abort();
    }

    const currentSequence = ++probeSequenceRef.current;
    const probeController = new AbortController();
    activeProbeAbortController.current = probeController;

    setIsProbing(true);
    setNodeError(null);
    setFetchErrorInfo(null);

    try {
      // Probe syncStatus using canonical SDK contract
      const sync = await client.syncStatus({
        timeoutMs: 4000,
        signal: probeController.signal,
      });

      // Guard against delayed responses from previous probes or endpoints
      if (currentSequence !== probeSequenceRef.current) return;

      setSyncStatus(sync);

      // Probe miningInfo (Chain 5 Hybrid PoW)
      try {
        const mining = await client.getMiningInfo({
          timeoutMs: 3000,
          signal: probeController.signal,
        });

        if (currentSequence !== probeSequenceRef.current) return;

        setMiningInfo(mining);
        setConnectedNodeChainId(mining.chain_id);
      } catch {
        if (currentSequence !== probeSequenceRef.current) return;

        setMiningInfo(null);
        // If sync has network tag (e.g. "5-xxx"), parse chain ID from it
        if (sync.networkTag) {
          const cid = Number.parseInt(sync.networkTag.split("-")[0], 10);
          if (!Number.isNaN(cid)) {
            setConnectedNodeChainId(cid);
          }
        }
      }
    } catch (err: any) {
      if (currentSequence !== probeSequenceRef.current) return;
      if (probeController.signal.aborted) return;

      setSyncStatus(null);
      setMiningInfo(null);
      setConnectedNodeChainId(null);

      const msg = err?.message || String(err);
      setNodeError(msg);

      // Honest diagnosis of browser fetch failure
      const isNetworkError =
        msg.includes("Failed to fetch") ||
        msg.includes("NetworkError") ||
        msg.includes("fetch failed") ||
        err?.name === "TypeError";
      const hasCorsEvidence =
        msg.toLowerCase().includes("cors") && !msg.includes("Failed to fetch");

      if (isNetworkError || hasCorsEvidence) {
        setFetchErrorInfo({
          hasCorsEvidence,
          message: msg,
        });
      }
    } finally {
      if (currentSequence === probeSequenceRef.current) {
        setIsProbing(false);
        activeProbeAbortController.current = null;
      }
    }
  }, [client, isTabVisible, rpcUrl]);

  // Handle explicit endpoint change: clear stale diagnostics immediately and cancel in-flight work
  const handleEndpointChange = (newUrl: string) => {
    // Abort in-flight probe
    if (activeProbeAbortController.current) {
      activeProbeAbortController.current.abort();
      activeProbeAbortController.current = null;
    }
    // Abort in-flight method execution
    if (activeAbortController.current) {
      activeAbortController.current.abort();
      activeAbortController.current = null;
      setIsLoading(false);
    }
    // Invalidate sequence so delayed in-flight responses are dropped
    probeSequenceRef.current++;

    // Clear stale diagnostics immediately
    clearDiagnostics();
    setRpcUrl(newUrl);
  };

  // Track tab visibility to prevent aggressive polling when hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = document.visibilityState === "visible";
      setIsTabVisible(visible);
      if (visible) {
        probeNode();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [probeNode]);

  // Resource-conscious background polling: pauses when tab is hidden
  useEffect(() => {
    if (!isTabVisible || !rpcUrl) return;

    const interval = setInterval(() => {
      probeNode();
    }, 10_000);

    return () => {
      clearInterval(interval);
    };
  }, [isTabVisible, rpcUrl, probeNode]);

  // Probe whenever endpoint URL or client changes
  useEffect(() => {
    probeNode();
    return () => {
      if (activeProbeAbortController.current) {
        activeProbeAbortController.current.abort();
        activeProbeAbortController.current = null;
      }
    };
  }, [probeNode]);

  // Reset param defaults and cancel running requests when method changes
  useEffect(() => {
    if (activeAbortController.current) {
      activeAbortController.current.abort();
      activeAbortController.current = null;
      setIsLoading(false);
    }

    const defaults: Record<string, any> = {};
    for (const p of currentMethod.params) {
      defaults[p.name] = p.defaultValue ?? "";
    }
    setParamValues(defaults);
    setParamErrors({});
    setExecutionError(null);
    setResponsePayload(null);
    setElapsedMs(null);
  }, [currentMethod]);

  // Handle param input change with validation
  const handleParamChange = (name: string, value: any, paramDef: any) => {
    const updated = { ...paramValues, [name]: value };
    setParamValues(updated);

    const check = validateParam(paramDef, value, selectedChainId);
    if (!check.valid) {
      setParamErrors((prev) => ({ ...prev, [name]: check.error || "Invalid" }));
    } else {
      setParamErrors((prev) => {
        const copy = { ...prev };
        delete copy[name];
        return copy;
      });
    }
  };

  // Execute selected method
  const handleExecute = async () => {
    // Abort previous in-flight request if any
    if (activeAbortController.current) {
      activeAbortController.current.abort();
    }
    const controller = new AbortController();
    activeAbortController.current = controller;

    // Validate all params
    let hasError = false;
    const errors: Record<string, string> = {};
    for (const p of currentMethod.params) {
      const val = paramValues[p.name];
      const check = validateParam(p, val, selectedChainId);
      if (!check.valid) {
        errors[p.name] = check.error || "Invalid";
        hasError = true;
      }
    }
    setParamErrors(errors);
    if (hasError) return;

    setIsLoading(true);
    setExecutionError(null);
    setResponsePayload(null);

    // Build preview request payload
    const wireParams = currentMethod.params.map((p) => paramValues[p.name]);
    const reqJson = {
      jsonrpc: "2.0",
      id: 1,
      method: currentMethod.method,
      params: wireParams.length > 0 ? wireParams : [],
    };
    setRequestPayload(formatJson(reqJson));

    const startTime = performance.now();
    try {
      const result = await currentMethod.execute(client, paramValues, {
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      const endTime = performance.now();
      setElapsedMs(Math.round(endTime - startTime));
      setResponsePayload(formatJson(result));
    } catch (err: any) {
      const endTime = performance.now();
      setElapsedMs(Math.round(endTime - startTime));
      setExecutionError(err?.message || String(err));
    } finally {
      setIsLoading(false);
      activeAbortController.current = null;
    }
  };

  // Cancel currently running request
  const handleCancel = () => {
    if (activeAbortController.current) {
      activeAbortController.current.abort();
      activeAbortController.current = null;
    }
    setIsLoading(false);
  };

  // Filtered methods
  const filteredMethods = useMemo(() => {
    if (selectedCategory === "All") return ALLOWLISTED_METHODS;
    return ALLOWLISTED_METHODS.filter((m) => m.category === selectedCategory);
  }, [selectedCategory]);

  const categories = ["All", "Chain", "Account", "Transaction", "Staking", "Diagnostics", "Mining & DAG"];

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopySuccess(label);
    setTimeout(() => setCopySuccess(null), 2000);
  };

  const selectedChainConfig = getChainConfig(selectedChainId);

  // Network mismatch detection
  const hasNetworkMismatch =
    connectedNodeChainId !== null && connectedNodeChainId !== selectedChainId;

  return (
    <div className="min-h-screen bg-bg text-fg flex flex-col font-sans">
      {/* Top Navigation */}
      <header className="bg-surface border-b border-border px-6 py-4 sticky top-0 z-30 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gold flex items-center justify-center font-bold text-bg text-sm">
            K
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold tracking-wide text-fg">
                Kovanica Playground
              </h1>
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-surface-2 border border-border text-gold">
                Developer Preview
              </span>
            </div>
            <p className="text-xs text-muted">Read-Only RPC Explorer & Developer Console</p>
          </div>
        </div>

        {/* Global Connection Status Pill */}
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface-2 border border-border">
            <span
              className={`w-2 h-2 rounded-full ${
                isProbing
                  ? "bg-amber-400 animate-pulse"
                  : syncState === "synced"
                  ? "bg-emerald-400"
                  : syncState === "catching-up"
                  ? "bg-amber-400"
                  : syncState === "unknown"
                  ? "bg-blue-400"
                  : "bg-red-400"
              }`}
            />
            <span className="text-muted">Node Status:</span>
            <span data-testid="header-node-status" className="font-medium text-fg">
              {isProbing
                ? "Probing..."
                : syncState === "synced"
                ? "Online (Synced)"
                : syncState === "catching-up"
                ? "Online (Catching Up)"
                : syncState === "unknown"
                ? "Online (Sync Unknown)"
                : nodeError
                ? "Connection Error"
                : "Disconnected"}
            </span>
            {syncStatus && syncStatus.peerCount !== undefined && (
              <span data-testid="header-peer-count" className="text-muted ml-1 font-mono">
                ({syncStatus.peerCount} peers)
              </span>
            )}
          </div>

          <button
            onClick={probeNode}
            disabled={isProbing}
            className="px-3 py-1.5 rounded-md bg-surface-2 hover:bg-border text-fg border border-border transition-colors disabled:opacity-50"
            title="Probe node connection"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 flex flex-col gap-6">
        {/* Network & Endpoint Bar */}
        <section className="bg-surface rounded-xl border border-border p-5 flex flex-col md:flex-row items-stretch md:items-center gap-4">
          <div className="flex-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="w-full sm:w-56">
              <label htmlFor="target-network-select" className="block text-xs font-medium text-muted mb-1">
                Target Network
              </label>
              <select
                id="target-network-select"
                aria-label="Target Network"
                value={selectedChainId}
                onChange={(e) => setSelectedChainId(Number(e.target.value))}
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-gold"
              >
                <option value={CHAIN_IDS.MAINNET}>Mainnet (Chain 1)</option>
                <option value={CHAIN_IDS.TESTNET}>Testnet (Chain 2 - Legacy)</option>
                <option value={CHAIN_IDS.DEVNET}>Devnet (Chain 3)</option>
                <option value={CHAIN_IDS.TESTNET_V2}>Testnet V2 (Chain 4)</option>
                <option value={CHAIN_IDS.HYBRID_TESTNET}>Hybrid PoW Testnet (Chain 5)</option>
                <option value={CHAIN_IDS.LOCAL}>Local Devnet (Chain 1337)</option>
              </select>
            </div>

            <div className="flex-1">
              <label htmlFor="rpc-endpoint-input" className="block text-xs font-medium text-muted mb-1">
                RPC Endpoint URL
              </label>
              <div className="flex gap-2">
                <input
                  id="rpc-endpoint-input"
                  type="text"
                  value={rpcUrl}
                  onChange={(e) => handleEndpointChange(e.target.value)}
                  placeholder="http://127.0.0.1:8545/rpc"
                  className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm font-mono text-fg focus:outline-none focus:border-gold"
                />
                <button
                  type="button"
                  onClick={() => handleEndpointChange("http://127.0.0.1:8545/rpc")}
                  className="px-3 py-2 text-xs bg-surface-2 hover:bg-border rounded-lg border border-border text-muted hover:text-fg whitespace-nowrap transition-colors"
                >
                  Local Default
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Chain Mismatch Warning */}
        {hasNetworkMismatch && (
          <div className="bg-amber-950/40 border border-amber-700/50 rounded-xl p-4 flex items-start gap-3 text-amber-200">
            <span className="text-xl">⚠️</span>
            <div>
              <h2 className="font-semibold text-sm">Chain Identity Mismatch Detected</h2>
              <p className="text-xs mt-1 text-amber-300">
                You selected <strong>{selectedChainConfig?.name}</strong> (Chain ID: {selectedChainId}),
                but the connected node identified itself as <strong>Chain ID {connectedNodeChainId}</strong>.
                Addresses or transactions may be rejected due to chain mismatch.
              </p>
            </div>
          </div>
        )}

        {/* Honest Network / Connection Error Banner */}
        {fetchErrorInfo && (
          <div data-testid="network-error-banner" className="bg-red-950/40 border border-red-700/50 rounded-xl p-4 flex items-start gap-3 text-red-200">
            <span className="text-xl">⚠️</span>
            <div>
              <h2 className="font-semibold text-sm">
                {fetchErrorInfo.hasCorsEvidence
                  ? "Browser Cross-Origin (CORS) Restriction"
                  : "Browser Network / Connection Failure"}
              </h2>
              <p className="text-xs mt-1 text-red-300">
                The browser could not reach <code className="bg-surface-2 px-1 rounded">{rpcUrl}</code>.
                {fetchErrorInfo.hasCorsEvidence
                  ? " Cross-Origin Resource Sharing (CORS) restrictions blocked the request."
                  : " Browser fetch failures can have multiple causes and do not prove a CORS policy issue without explicit evidence."}
              </p>
              <ul className="text-xs mt-2 list-disc list-inside space-y-1 text-red-300">
                <li><strong>Node Offline / Port Closed:</strong> Ensure the Kovanica node is actively running and listening on the specified port.</li>
                <li><strong>Endpoint Reachability:</strong> Check hostname, IP address, and network connectivity to the target node.</li>
                <li><strong>Cross-Origin Policy (CORS):</strong> If the node is on a different origin, it must supply <code className="text-fg">Access-Control-Allow-Origin</code> headers (e.g. run with <code className="text-fg">--rpc-cors</code>).</li>
                <li><strong>Direct Architecture:</strong> This playground operates directly from your browser without an intermediary server-side proxy.</li>
              </ul>
              {fetchErrorInfo.message && (
                <p className="text-[11px] mt-2 text-red-400/80 font-mono">
                  Reported error: {fetchErrorInfo.message}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Multi-Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Main Column: RPC Method Explorer (7 cols) */}
          <section className="lg:col-span-7 flex flex-col gap-6">
            <div className="bg-surface rounded-xl border border-border p-6 flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                <div>
                  <h2 className="text-base font-semibold text-fg">RPC Explorer</h2>
                  <p className="text-xs text-muted">Execute verified read-only calls against node handlers</p>
                </div>

                {/* Category Pills */}
                <div className="flex flex-wrap gap-1">
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors ${
                        selectedCategory === cat
                          ? "bg-gold text-bg font-semibold"
                          : "bg-surface-2 text-muted hover:text-fg"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Method Selector */}
              <div>
                <label htmlFor="rpc-method-select" className="block text-xs font-medium text-muted mb-1.5">
                  Method
                </label>
                <select
                  id="rpc-method-select"
                  aria-label="RPC Method"
                  value={selectedMethodName}
                  onChange={(e) => setSelectedMethodName(e.target.value)}
                  className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm font-mono text-fg focus:outline-none focus:border-gold"
                >
                  {filteredMethods.map((m) => (
                    <option key={m.method} value={m.method}>
                      {m.method} — {m.category}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted mt-1.5">{currentMethod.description}</p>
              </div>

              {/* Parameter Form */}
              {currentMethod.params.length > 0 && (
                <div className="flex flex-col gap-3.5 bg-surface-2/60 p-4 rounded-lg border border-border/80">
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                    Parameters
                  </h3>
                  {currentMethod.params.map((param) => {
                    const hasError = Boolean(paramErrors[param.name]);
                    const inputId = `param-input-${param.name}`;
                    return (
                      <div key={param.name} className="flex flex-col gap-1">
                        <label htmlFor={inputId} className="text-xs font-medium text-fg flex items-center justify-between">
                          <span>
                            {param.label}
                            {param.required && <span className="text-gold ml-1">*</span>}
                          </span>
                          <span className="text-[10px] text-muted font-mono uppercase">
                            {param.type}
                          </span>
                        </label>
                        {param.type === "boolean" ? (
                          <select
                            id={inputId}
                            value={paramValues[param.name] ? "true" : "false"}
                            onChange={(e) =>
                              handleParamChange(param.name, e.target.value === "true", param)
                            }
                            className="bg-surface border border-border rounded-md px-3 py-1.5 text-xs text-fg focus:outline-none focus:border-gold"
                          >
                            <option value="false">false</option>
                            <option value="true">true</option>
                          </select>
                        ) : (
                          <input
                            id={inputId}
                            type="text"
                            value={paramValues[param.name] ?? ""}
                            onChange={(e) => handleParamChange(param.name, e.target.value, param)}
                            placeholder={param.placeholder || ""}
                            className={`bg-surface border rounded-md px-3 py-1.5 text-xs font-mono text-fg focus:outline-none ${
                              hasError ? "border-red-500 focus:border-red-500" : "border-border focus:border-gold"
                            }`}
                          />
                        )}
                        {hasError && (
                          <span className="text-[11px] text-red-400">{paramErrors[param.name]}</span>
                        )}
                        {param.description && (
                          <span className="text-[10px] text-muted">{param.description}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleExecute}
                  disabled={isLoading}
                  className="px-5 py-2.5 bg-gold hover:bg-gold/90 text-bg font-semibold rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading && (
                    <span className="w-3.5 h-3.5 border-2 border-bg border-t-transparent rounded-full animate-spin" />
                  )}
                  <span>{isLoading ? "Executing..." : "Execute Call"}</span>
                </button>

                {isLoading && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="px-4 py-2.5 bg-surface-2 hover:bg-border border border-border text-xs text-muted hover:text-fg rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>

              {/* Request Payload Preview */}
              {requestPayload && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span className="font-medium">JSON-RPC Request</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(requestPayload, "req")}
                      className="text-subtle hover:text-fg"
                    >
                      {copySuccess === "req" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <pre className="bg-surface-2 p-3 rounded-lg border border-border text-xs font-mono text-muted overflow-x-auto">
                    {requestPayload}
                  </pre>
                </div>
              )}

              {/* Response or Error */}
              {executionError && (
                <div className="bg-red-950/40 border border-red-700/50 rounded-lg p-4 text-xs font-mono text-red-200">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-red-400">RPC Error</span>
                    {elapsedMs !== null && <span>{elapsedMs} ms</span>}
                  </div>
                  <p className="break-all">{executionError}</p>
                </div>
              )}

              {responsePayload && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span className="font-medium">
                      Response Result {elapsedMs !== null && `(${elapsedMs} ms)`}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(responsePayload, "res")}
                      className="text-subtle hover:text-fg"
                    >
                      {copySuccess === "res" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <pre className="bg-surface-2 p-4 rounded-lg border border-border text-xs font-mono text-fg overflow-x-auto max-h-96">
                    {responsePayload}
                  </pre>
                </div>
              )}
            </div>
          </section>

          {/* Side Column: Node Diagnostics & Mining Panels (5 cols) */}
          <aside className="lg:col-span-5 flex flex-col gap-6">
            {/* Node Sync & Status Card */}
            <div className="bg-surface rounded-xl border border-border p-5 flex flex-col gap-4">
              <h2 className="text-sm font-semibold text-fg flex items-center justify-between border-b border-border pb-3">
                <span>Node Diagnostics</span>
                <span
                  data-testid="sync-status-badge"
                  className={`text-xs font-normal font-mono ${
                    syncState === "synced"
                      ? "text-emerald-400"
                      : syncState === "catching-up"
                      ? "text-amber-400"
                      : syncState === "connection-error"
                      ? "text-red-400"
                      : "text-muted"
                  }`}
                >
                  {syncState === "synced"
                    ? "Synced"
                    : syncState === "catching-up"
                    ? "Catching Up"
                    : syncState === "connection-error"
                    ? "Connection Error"
                    : syncState === "unknown"
                    ? "Unknown"
                    : "Offline"}
                </span>
              </h2>

              {syncStatus ? (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px]">Committed Height</span>
                    <span data-testid="diagnostic-committed-height" className="font-mono text-base font-semibold text-fg">
                      {syncStatus.committedHeight !== undefined ? syncStatus.committedHeight.toString() : "—"}
                    </span>
                  </div>

                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px]">Local Tip Round</span>
                    <span data-testid="diagnostic-tip-round" className="font-mono text-base font-semibold text-fg">
                      {syncStatus.localTipRound !== undefined ? syncStatus.localTipRound.toString() : "—"}
                    </span>
                  </div>

                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px]">Peer Count</span>
                    <span data-testid="diagnostic-peer-count" className="font-mono text-base font-semibold text-fg">
                      {syncStatus.peerCount !== undefined ? syncStatus.peerCount.toString() : "—"}
                    </span>
                  </div>

                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px]">Catching Up</span>
                    <span
                      data-testid="diagnostic-catching-up"
                      className={`font-mono text-sm font-semibold ${
                        syncStatus.catchingUp === true
                          ? "text-amber-400"
                          : syncStatus.catchingUp === false
                          ? "text-emerald-400"
                          : "text-muted"
                      }`}
                    >
                      {syncStatus.catchingUp === true
                        ? "Active"
                        : syncStatus.catchingUp === false
                        ? "No"
                        : "Unknown"}
                    </span>
                  </div>

                  {syncStatus.behindBy !== undefined && syncStatus.behindBy > 0n && (
                    <div className="col-span-2 bg-surface-2 p-3 rounded-lg border border-border/60 flex items-center justify-between">
                      <span className="text-muted text-[11px]">Behind By</span>
                      <span data-testid="diagnostic-behind-by" className="font-mono text-xs text-amber-400 font-semibold">
                        {syncStatus.behindBy.toString()} rounds
                      </span>
                    </div>
                  )}

                  {syncStatus.networkTag && (
                    <div className="col-span-2 bg-surface-2 p-3 rounded-lg border border-border/60">
                      <span className="text-muted block text-[11px]">Network Identity Tag</span>
                      <span data-testid="diagnostic-network-tag" className="font-mono text-xs text-gold break-all">
                        {syncStatus.networkTag}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div data-testid="diagnostic-empty-state" className="text-xs text-muted p-4 text-center">
                  {nodeError ? `Cannot reach node: ${nodeError}` : "Connect to a Kovanica node to view status"}
                </div>
              )}
            </div>

            {/* Hybrid PoW & DAG Tips Panel */}
            <div className="bg-surface rounded-xl border border-border p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <div>
                  <h2 className="text-sm font-semibold text-fg">Hybrid PoW & DAG Info</h2>
                  <p className="text-[11px] text-muted">Chain 5 testnet metrics (ADR 0003)</p>
                </div>
                <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-gold/10 text-gold border border-gold/20">
                  Chain 5
                </span>
              </div>

              {miningInfo ? (
                <div className="flex flex-col gap-3 text-xs">
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="bg-surface-2 p-2.5 rounded-lg border border-border/60">
                      <span className="text-muted block text-[10px]">Target Block Time</span>
                      <span className="font-mono text-sm font-semibold text-fg">
                        {miningInfo.target_block_time_ms} ms (4 s)
                      </span>
                    </div>

                    <div className="bg-surface-2 p-2.5 rounded-lg border border-border/60">
                      <span className="text-muted block text-[10px]">GHOSTDAG K</span>
                      <span className="font-mono text-sm font-semibold text-fg">
                        {miningInfo.ghostdag_k}
                      </span>
                    </div>

                    <div className="bg-surface-2 p-2.5 rounded-lg border border-border/60">
                      <span className="text-muted block text-[10px]">Target Bits</span>
                      <span className="font-mono text-xs font-semibold text-gold">
                        {miningInfo.target_bits}
                      </span>
                    </div>

                    <div className="bg-surface-2 p-2.5 rounded-lg border border-border/60">
                      <span className="text-muted block text-[10px]">Mining Difficulty</span>
                      <span className="font-mono text-xs font-semibold text-fg">
                        {miningInfo.difficulty.toString()}
                      </span>
                    </div>

                    <div className="bg-surface-2 p-2.5 rounded-lg border border-border/60 col-span-2">
                      <span className="text-muted block text-[10px]">Network Hashrate Estimate</span>
                      <span className="font-mono text-sm font-semibold text-emerald-400">
                        {miningInfo.network_hashrate_estimate.toString()} H/s
                      </span>
                    </div>
                  </div>

                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px] mb-1">
                      Active DAG Tips ({miningInfo.dag_tips_count})
                    </span>
                    <span className="text-[11px] text-muted font-mono">
                      Target Bits: {miningInfo.target_bits} | Mining Threads: {miningInfo.mining_threads}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="bg-surface-2/60 p-4 rounded-lg border border-border/60 text-xs text-muted text-center">
                  <p>PoW Mining info is available on Chain 5 (Hybrid PoW testnet).</p>
                  <p className="mt-1 text-[11px] text-subtle">
                    Chains 1–4 operate under Mysticeti consensus.
                  </p>
                </div>
              )}
            </div>

            {/* Security Boundaries & Preview Notice */}
            <div className="bg-surface-2/40 rounded-xl border border-border/60 p-4 text-xs text-muted space-y-1.5">
              <span className="font-semibold text-fg block text-[11px] uppercase tracking-wider">
                Console Security Boundaries
              </span>
              <p className="text-[11px]">
                This developer console strictly executes read-only JSON-RPC queries. It does not import seed phrases, store private keys, sign transactions, or execute mining algorithms.
              </p>
            </div>
          </aside>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-auto py-4 px-6 text-xs text-muted flex flex-wrap justify-between items-center gap-4 bg-surface">
        <div>
          <span>Kovanica Layer-1 Blockchain &copy; 2026. KVNC (9 decimals).</span>
        </div>
        <div className="flex items-center gap-4">
          <span>Target Block: 4 s | GHOSTDAG K: 5</span>
          <a
            href="https://github.com/KovanicaDAG/kovanica"
            target="_blank"
            rel="noreferrer"
            className="text-gold hover:underline"
          >
            kovanica on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
