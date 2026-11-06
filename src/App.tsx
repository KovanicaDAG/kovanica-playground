import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHAIN_IDS,
  getChainConfig,
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

export default function App() {
  // Target Network & Endpoint
  const [selectedChainId, setSelectedChainId] = useState<number>(CHAIN_IDS.HYBRID_TESTNET);
  const [rpcUrl, setRpcUrl] = useState<string>("http://127.0.0.1:8545/rpc");
  const [connectedNodeChainId, setConnectedNodeChainId] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [miningInfo, setMiningInfo] = useState<MiningInfo | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [isProbing, setIsProbing] = useState<boolean>(false);
  const [isCorsError, setIsCorsError] = useState<boolean>(false);

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

  // Track tab visibility to prevent aggressive polling when hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsTabVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Probe node health and capabilities
  const probeNode = useCallback(async () => {
    if (!rpcUrl || !isTabVisible) return;
    setIsProbing(true);
    setNodeError(null);
    setIsCorsError(false);

    try {
      // Probe syncStatus
      const sync = await client.syncStatus({ timeoutMs: 4000 });
      setSyncStatus(sync);

      // Probe miningInfo (Chain 5 Hybrid PoW)
      try {
        const mining = await client.getMiningInfo({ timeoutMs: 3000 });
        setMiningInfo(mining);
        setConnectedNodeChainId(mining.chain_id);
      } catch {
        setMiningInfo(null);
        // If sync has network tag (e.g. "5-xxx"), parse chain ID from it
        if (sync.network_tag) {
          const cid = Number.parseInt(sync.network_tag.split("-")[0], 10);
          if (!Number.isNaN(cid)) {
            setConnectedNodeChainId(cid);
          }
        }
      }
    } catch (err: any) {
      setSyncStatus(null);
      setMiningInfo(null);
      setConnectedNodeChainId(null);

      const msg = err?.message || String(err);
      setNodeError(msg);

      // Check for browser CORS restriction
      if (
        msg.includes("Failed to fetch") ||
        msg.includes("NetworkError") ||
        msg.includes("CORS") ||
        err?.name === "TypeError"
      ) {
        setIsCorsError(true);
      }
    } finally {
      setIsProbing(false);
    }
  }, [client, isTabVisible, rpcUrl]);

  // Probe whenever endpoint changes
  useEffect(() => {
    probeNode();
  }, [probeNode]);

  // Reset param defaults when method changes
  useEffect(() => {
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
                  : syncStatus
                  ? "bg-emerald-400"
                  : "bg-red-400"
              }`}
            />
            <span className="text-muted">Node Status:</span>
            <span className="font-medium text-fg">
              {isProbing ? "Probing..." : syncStatus ? "Online" : "Disconnected"}
            </span>
            {syncStatus && (
              <span className="text-muted ml-1 font-mono">
                ({syncStatus.peer_count} peers)
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
                  onChange={(e) => setRpcUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8545/rpc"
                  className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm font-mono text-fg focus:outline-none focus:border-gold"
                />
                <button
                  type="button"
                  onClick={() => setRpcUrl("http://127.0.0.1:8545/rpc")}
                  className="px-3 py-2 text-xs bg-surface-2 hover:bg-border rounded-lg border border-border text-muted hover:text-fg whitespace-nowrap transition-colors"
                >
                  Local Default
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Warnings & Notices */}
        {hasNetworkMismatch && (
          <div className="bg-amber-950/40 border border-amber-600/50 rounded-xl p-4 flex items-start gap-3 text-amber-200">
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

        {isCorsError && (
          <div className="bg-red-950/40 border border-red-700/50 rounded-xl p-4 flex items-start gap-3 text-red-200">
            <span className="text-xl">🚫</span>
            <div>
              <h2 className="font-semibold text-sm">Browser Cross-Origin (CORS) Limitation</h2>
              <p className="text-xs mt-1 text-red-300">
                The browser could not reach <code className="bg-surface-2 px-1 rounded">{rpcUrl}</code> due to Cross-Origin Resource Sharing (CORS) restrictions.
              </p>
              <ul className="text-xs mt-2 list-disc list-inside space-y-1 text-red-300">
                <li>If connecting to a local node, ensure it allows browser origins via <code className="text-fg">--rpc-cors</code> or run on <code className="text-fg">127.0.0.1</code>.</li>
                <li>Browsers block cross-origin RPC calls unless the node explicitly sends <code className="text-fg">Access-Control-Allow-Origin</code>.</li>
                <li>This playground intentionally operates directly from your browser without an insecure backend proxy.</li>
              </ul>
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
                          <span className="text-muted text-[11px] font-mono lowercase">
                            {param.type}
                          </span>
                        </label>

                        {param.type === "boolean" ? (
                          <div className="flex items-center gap-3 mt-1">
                            <label className="flex items-center gap-2 text-xs cursor-pointer">
                              <input
                                id={inputId}
                                type="checkbox"
                                checked={Boolean(paramValues[param.name])}
                                onChange={(e) =>
                                  handleParamChange(param.name, e.target.checked, param)
                                }
                                className="rounded bg-surface border-border text-gold focus:ring-0"
                              />
                              <span className="text-muted">Enable / True</span>
                            </label>
                          </div>
                        ) : (
                          <input
                            id={inputId}
                            type="text"
                            value={paramValues[param.name] ?? ""}
                            onChange={(e) =>
                              handleParamChange(param.name, e.target.value, param)
                            }
                            placeholder={param.placeholder}
                            className={`w-full bg-surface border rounded-lg px-3 py-1.5 text-xs font-mono text-fg focus:outline-none ${
                              hasError
                                ? "border-red-500 focus:border-red-500"
                                : "border-border focus:border-gold"
                            }`}
                          />
                        )}

                        {hasError ? (
                          <span className="text-[11px] text-red-400">
                            {paramErrors[param.name]}
                          </span>
                        ) : param.description ? (
                          <span className="text-[11px] text-muted">
                            {param.description}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleExecute}
                  disabled={isLoading}
                  className="px-5 py-2.5 rounded-lg bg-gold hover:bg-gold-hover text-bg font-semibold text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {isLoading ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-bg border-t-transparent rounded-full animate-spin" />
                      Executing...
                    </>
                  ) : (
                    "Send Request"
                  )}
                </button>

                {isLoading && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="px-4 py-2.5 rounded-lg bg-surface-2 hover:bg-border text-muted hover:text-fg text-sm border border-border transition-colors"
                  >
                    Cancel
                  </button>
                )}

                {elapsedMs !== null && (
                  <span className="text-xs text-muted ml-auto font-mono">
                    Elapsed: <span className="text-fg font-medium">{elapsedMs}ms</span>
                  </span>
                )}
              </div>

              {/* Output Viewer: Request Payload */}
              {requestPayload && (
                <div className="flex flex-col gap-2 mt-2">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span className="font-semibold uppercase tracking-wider text-[11px]">Request Payload</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(requestPayload, "req")}
                      className="text-muted hover:text-fg transition-colors"
                    >
                      {copySuccess === "req" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <pre className="bg-surface-2 p-3.5 rounded-lg border border-border text-xs font-mono text-muted overflow-x-auto max-h-40">
                    {requestPayload}
                  </pre>
                </div>
              )}

              {/* Output Viewer: Response / Error */}
              {executionError && (
                <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-4 text-xs font-mono text-red-200 mt-2">
                  <div className="font-semibold text-red-300 mb-1">Execution Error:</div>
                  <div>{executionError}</div>
                </div>
              )}

              {responsePayload && (
                <div className="flex flex-col gap-2 mt-2">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span className="font-semibold uppercase tracking-wider text-[11px] text-emerald-400">Response</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(responsePayload, "res")}
                      className="text-muted hover:text-fg transition-colors"
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
                <span className="text-xs font-normal text-muted font-mono">
                  {syncStatus ? "Synced" : "Offline"}
                </span>
              </h2>

              {syncStatus ? (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px]">Committed Height</span>
                    <span className="font-mono text-base font-semibold text-fg">
                      {syncStatus.committed_height?.toString() ?? "0"}
                    </span>
                  </div>

                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px]">Local Tip Round</span>
                    <span className="font-mono text-base font-semibold text-fg">
                      {syncStatus.local_tip_round?.toString() ?? "0"}
                    </span>
                  </div>

                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px]">Peer Count</span>
                    <span className="font-mono text-base font-semibold text-fg">
                      {syncStatus.peer_count}
                    </span>
                  </div>

                  <div className="bg-surface-2 p-3 rounded-lg border border-border/60">
                    <span className="text-muted block text-[11px]">Catching Up</span>
                    <span
                      className={`font-mono text-sm font-semibold ${
                        syncStatus.catching_up ? "text-amber-400" : "text-emerald-400"
                      }`}
                    >
                      {syncStatus.catching_up ? "Active" : "No"}
                    </span>
                  </div>

                  {syncStatus.network_tag && (
                    <div className="col-span-2 bg-surface-2 p-3 rounded-lg border border-border/60">
                      <span className="text-muted block text-[11px]">Network Identity Tag</span>
                      <span className="font-mono text-xs text-gold break-all">
                        {syncStatus.network_tag}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted p-4 text-center">
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
