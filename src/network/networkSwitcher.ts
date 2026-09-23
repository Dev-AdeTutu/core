import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { NETWORK_DEFAULTS } from "./config";
import type { NetworkType } from "./config";
import { resolveNetwork } from "./resolveNetwork";
import type { NetworkOverrides } from "./resolveNetwork";
import type { ResolvedNetworkConfig } from "../shared/types";

export type { NetworkType };

export interface CustomNetwork {
  name: string;
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export interface NetworkOption {
  type: "preset" | "custom";
  label: string;
  networkType?: NetworkType;
  custom?: CustomNetwork;
}

export const NETWORK_STORAGE_KEY = "sorokit:selected-network";

export type NetworkStatus = "unknown" | "checking" | "healthy" | "degraded" | "down";

export interface NetworkInfo {
  network: string;
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
  status: NetworkStatus;
  isCustom: boolean;
}

export type NetworkSwitchListener = (network: NetworkInfo) => void;
export type NetworkStatusListener = (status: NetworkStatus) => void;
export type NetworkSwitchUnsubscribe = () => void;

export interface NetworkSwitcherConfig {
  initialNetwork?: NetworkType | string;
  initialOverrides?: NetworkOverrides;
  customNetworks?: CustomNetwork[];
  storageKey?: string;
  onNetworkChange?: NetworkSwitchListener;
  onStatusChange?: NetworkStatusListener;
}

const PRESET_LABELS: Record<NetworkType, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
  futurenet: "Futurenet",
};

function getDefaultNetworks(): NetworkOption[] {
  return [
    { type: "preset", label: "Mainnet", networkType: "mainnet" },
    { type: "preset", label: "Testnet", networkType: "testnet" },
    { type: "preset", label: "Futurenet", networkType: "futurenet" },
  ];
}

function getAriaLabelForNetwork(network: NetworkInfo): string {
  const statusLabel = network.status;
  const typeLabel = network.isCustom ? "custom network" : `${network.network} network`;
  return `${network.network} ${typeLabel}: ${statusLabel}. RPC: ${network.rpcUrl}`;
}

export class NetworkSwitcher {
  private _current: NetworkInfo;
  private _networks: NetworkOption[];
  private _customNetworks: CustomNetwork[];
  private _storageKey: string;
  private _networkListeners: Set<NetworkSwitchListener> = new Set();
  private _statusListeners: Set<NetworkStatusListener> = new Set();

  constructor(config?: NetworkSwitcherConfig) {
    this._customNetworks = config?.customNetworks ?? [];
    this._networks = [...getDefaultNetworks(), ...this._customNetworks.map((c) => ({
      type: "custom" as const,
      label: c.name,
      custom: c,
    }))];
    this._storageKey = config?.storageKey ?? NETWORK_STORAGE_KEY;

    const restored = this._restoreFromStorage();
    const initialNetwork = restored ?? config?.initialNetwork ?? "testnet";

    this._current = this._resolveNetworkInfo(initialNetwork, config?.initialOverrides);
    this._persist();
  }

  get current(): NetworkInfo {
    return { ...this._current };
  }

  get networks(): NetworkOption[] {
    return [...this._networks];
  }

  get customNetworks(): CustomNetwork[] {
    return [...this._customNetworks];
  }

  getAriaLabel(): string {
    return getAriaLabelForNetwork(this._current);
  }

  subscribe(listener: NetworkSwitchListener): NetworkSwitchUnsubscribe {
    this._networkListeners.add(listener);
    return () => { this._networkListeners.delete(listener); };
  }

  onStatusChange(listener: NetworkStatusListener): NetworkSwitchUnsubscribe {
    this._statusListeners.add(listener);
    return () => { this._statusListeners.delete(listener); };
  }

  private _emitNetworkChange(): void {
    const info = this._current;
    for (const listener of this._networkListeners) {
      listener(info);
    }
  }

  private _emitStatusChange(status: NetworkStatus): void {
    for (const listener of this._statusListeners) {
      listener(status);
    }
  }

  switchTo(network: NetworkType | string, overrides?: NetworkOverrides): SorokitResult<NetworkInfo> {
    const info = this._resolveNetworkInfo(network, overrides);
    if (info.status === "down") {
      return err(
        SorokitErrorCode.INVALID_NETWORK,
        `Failed to resolve network: ${network}`,
      );
    }
    this._current = info;
    this._persist();
    this._emitNetworkChange();
    return ok(info);
  }

  addCustomNetwork(custom: CustomNetwork): SorokitResult<void> {
    if (!custom.name || !custom.horizonUrl || !custom.rpcUrl || !custom.networkPassphrase) {
      return err(
        SorokitErrorCode.INVALID_NETWORK,
        "Custom network requires name, horizonUrl, rpcUrl, and networkPassphrase.",
      );
    }
    const exists = this._customNetworks.some(
      (c) => c.name === custom.name || c.rpcUrl === custom.rpcUrl,
    );
    if (exists) {
      return err(
        SorokitErrorCode.INVALID_NETWORK,
        `Custom network "${custom.name}" already exists.`,
      );
    }
    this._customNetworks.push(custom);
    this._networks.push({ type: "custom", label: custom.name, custom });
    return ok(undefined);
  }

  removeCustomNetwork(name: string): SorokitResult<void> {
    const idx = this._customNetworks.findIndex((c) => c.name === name);
    if (idx === -1) {
      return err(
        SorokitErrorCode.INVALID_NETWORK,
        `Custom network "${name}" not found.`,
      );
    }
    this._customNetworks.splice(idx, 1);
    this._networks = [...getDefaultNetworks(), ...this._customNetworks.map((c) => ({
      type: "custom" as const,
      label: c.name,
      custom: c,
    }))];
    if (this._current.network === name) {
      this.switchTo("testnet");
    }
    return ok(undefined);
  }

  async checkHealth(): Promise<NetworkStatus> {
    this._setStatus("checking");
    try {
      const fetchFn =
        typeof fetch !== "undefined" ? fetch : undefined;
      if (!fetchFn) {
        this._setStatus("unknown");
        return "unknown";
      }
      const horizonOk = await this._ping(fetchFn, this._current.horizonUrl);
      const rpcOk = await this._ping(fetchFn, this._current.rpcUrl);
      let status: NetworkStatus;
      if (horizonOk && rpcOk) {
        status = "healthy";
      } else if (!horizonOk && !rpcOk) {
        status = "down";
      } else {
        status = "degraded";
      }
      this._setStatus(status);
      return status;
    } catch {
      this._setStatus("down");
      return "down";
    }
  }

  private async _ping(fetchFn: typeof fetch, url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetchFn(url, { method: "GET", signal: controller.signal });
      clearTimeout(timeoutId);
      return res.ok;
    } catch {
      return false;
    }
  }

  private _setStatus(status: NetworkStatus): void {
    this._current = { ...this._current, status };
    this._emitStatusChange(status);
    this._emitNetworkChange();
  }

  private _resolveNetworkInfo(
    network: NetworkType | string,
    overrides?: NetworkOverrides,
  ): NetworkInfo {
    const isPreset = network in NETWORK_DEFAULTS;
    if (isPreset) {
      const result = resolveNetwork(network as NetworkType, overrides);
      if (result.status === "ok") {
        return {
          network: result.data.network,
          horizonUrl: result.data.horizonUrl,
          rpcUrl: result.data.rpcUrl,
          networkPassphrase: result.data.networkPassphrase,
          status: "unknown",
          isCustom: false,
        };
      }
    }
    const custom = this._customNetworks.find((c) => c.name === network);
    if (custom) {
      return {
        network: custom.name,
        horizonUrl: custom.horizonUrl,
        rpcUrl: custom.rpcUrl,
        networkPassphrase: custom.networkPassphrase,
        status: "unknown",
        isCustom: true,
      };
    }
    return {
      network: String(network),
      horizonUrl: overrides?.horizonUrl ?? "",
      rpcUrl: overrides?.rpcUrl ?? "",
      networkPassphrase: "Custom Network",
      status: "down",
      isCustom: true,
    };
  }

  private _restoreFromStorage(): string | null {
    try {
      const stored = localStorage.getItem(this._storageKey);
      return stored;
    } catch {
      return null;
    }
  }

  private _persist(): void {
    try {
      localStorage.setItem(this._storageKey, this._current.network);
    } catch {
      // localStorage may not be available
    }
  }
}
