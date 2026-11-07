import {
  CHAIN_IDS,
  formatKvnc,
  type KovanicaClient,
  isValidAddress,
  type RequestOptions,
} from "kovanica-sdk";

export interface MethodParam {
  name: string;
  label: string;
  type: "address" | "hex32" | "quantity" | "number" | "boolean" | "slot";
  required?: boolean;
  defaultValue?: string | number | boolean;
  placeholder?: string;
  description?: string;
}

export interface MethodDefinition {
  method: string;
  category: "Chain" | "Account" | "Transaction" | "Staking" | "Diagnostics" | "Mining & DAG";
  description: string;
  params: MethodParam[];
  execute: (
    client: KovanicaClient,
    params: Record<string, any>,
    options?: RequestOptions,
  ) => Promise<unknown>;
}

export const ALLOWLISTED_METHODS: MethodDefinition[] = [
  {
    method: "kovanica_blockNumber",
    category: "Chain",
    description: "Returns the latest committed leader block height as a bigint.",
    params: [],
    execute: async (client, _params, options) => {
      const height = await client.blockNumber(options);
      return {
        committed_leader_height: height.toString(),
        hex_quantity: `0x${height.toString(16)}`,
      };
    },
  },
  {
    method: "kovanica_getBlockByNumber",
    category: "Chain",
    description: "Returns a committed block by height or round number.",
    params: [
      {
        name: "blockNumber",
        label: "Block Number / Round",
        type: "quantity",
        required: true,
        defaultValue: "0x0",
        placeholder: "e.g. 0 or 0x0",
        description: "Block round number as decimal or 0x-prefixed hex string.",
      },
      {
        name: "fullTransactions",
        label: "Full Transactions",
        type: "boolean",
        defaultValue: false,
        description: "Include full transaction objects or hashes only.",
      },
    ],
    execute: async (client, params, options) => {
      return client.getBlockByNumber(
        params.blockNumber,
        Boolean(params.fullTransactions),
        options,
      );
    },
  },
  {
    method: "kovanica_getBlockByHash",
    category: "Chain",
    description: "Returns a block by its 32-byte digest hash.",
    params: [
      {
        name: "hash",
        label: "Block Digest Hash",
        type: "hex32",
        required: true,
        placeholder: "0x...",
        description: "32-byte hexadecimal block digest hash.",
      },
      {
        name: "fullTransactions",
        label: "Full Transactions",
        type: "boolean",
        defaultValue: false,
        description: "Include full transaction objects or hashes only.",
      },
    ],
    execute: async (client, params, options) => {
      return client.getBlockByHash(
        params.hash,
        Boolean(params.fullTransactions),
        options,
      );
    },
  },
  {
    method: "kovanica_getBalance",
    category: "Account",
    description: "Returns the account balance in atomic units (atoms) and formatted KVNC.",
    params: [
      {
        name: "address",
        label: "Account Address",
        type: "address",
        required: true,
        placeholder: "kvnc...dag or 0x...",
        description: "Canonical PRO-21 base32 address (or legacy hex on dev chains).",
      },
    ],
    execute: async (client, params, options) => {
      const atoms = await client.getBalance(params.address, options);
      return {
        atoms: atoms.toString(),
        kvnc: `${formatKvnc(atoms)} KVNC`,
        hex_quantity: `0x${atoms.toString(16)}`,
      };
    },
  },
  {
    method: "kovanica_getNonce",
    category: "Account",
    description: "Returns the current sequence transaction nonce of an account.",
    params: [
      {
        name: "address",
        label: "Account Address",
        type: "address",
        required: true,
        placeholder: "kvnc...dag or 0x...",
        description: "Canonical PRO-21 base32 address.",
      },
    ],
    execute: async (client, params, options) => {
      const nonce = await client.getNonce(params.address, options);
      return {
        nonce: nonce.toString(),
        hex_quantity: `0x${nonce.toString(16)}`,
      };
    },
  },
  {
    method: "kovanica_getCode",
    category: "Account",
    description: "Returns compiled Wasm contract bytecode for an address.",
    params: [
      {
        name: "address",
        label: "Contract Address",
        type: "address",
        required: true,
        placeholder: "kvnc...dag",
        description: "Address of the deployed contract account.",
      },
    ],
    execute: async (client, params, options) => {
      return client.getCode(params.address, options);
    },
  },
  {
    method: "kovanica_getStorageAt",
    category: "Account",
    description: "Reads a storage slot from an account contract state.",
    params: [
      {
        name: "address",
        label: "Contract Address",
        type: "address",
        required: true,
        placeholder: "kvnc...dag",
      },
      {
        name: "slot",
        label: "Storage Slot",
        type: "slot",
        required: true,
        defaultValue: "0x0",
        placeholder: "0x0 or 32-byte hex",
      },
    ],
    execute: async (client, params, options) => {
      return client.getStorageAt(params.address, params.slot, options);
    },
  },
  {
    method: "kovanica_getTransactionByHash",
    category: "Transaction",
    description: "Returns transaction details by its 32-byte transaction hash.",
    params: [
      {
        name: "hash",
        label: "Transaction Hash",
        type: "hex32",
        required: true,
        placeholder: "0x...",
      },
    ],
    execute: async (client, params, options) => {
      return client.getTransactionByHash(params.hash, options);
    },
  },
  {
    method: "kovanica_getTransactionReceipt",
    category: "Transaction",
    description: "Returns execution receipt for a committed transaction.",
    params: [
      {
        name: "hash",
        label: "Transaction Hash",
        type: "hex32",
        required: true,
        placeholder: "0x...",
      },
    ],
    execute: async (client, params, options) => {
      return client.getTransactionReceipt(params.hash, options);
    },
  },
  {
    method: "kovanica_getPendingTransactions",
    category: "Transaction",
    description: "Returns list of transaction hashes currently in the node mempool.",
    params: [],
    execute: async (client, _params, options) => {
      return client.getPendingTransactions(options);
    },
  },
  {
    method: "kovanica_estimateFee",
    category: "Transaction",
    description: "Returns suggested minimum transaction fee rate in atoms per byte.",
    params: [],
    execute: async (client, _params, options) => {
      const rate = await client.estimateFee(options);
      return {
        atoms_per_byte: rate.toString(),
        hex_quantity: `0x${rate.toString(16)}`,
      };
    },
  },
  {
    method: "kovanica_getValidators",
    category: "Staking",
    description: "Returns all registered validators, active status, and bonded stakes.",
    params: [],
    execute: async (client, _params, options) => {
      return client.getValidators(options);
    },
  },
  {
    method: "kovanica_getStake",
    category: "Staking",
    description: "Returns the bonded validator stake for a specific address in atoms and KVNC.",
    params: [
      {
        name: "address",
        label: "Validator Address",
        type: "address",
        required: true,
        placeholder: "kvnc...dag",
      },
    ],
    execute: async (client, params, options) => {
      const stake = await client.getStake(params.address, options);
      return {
        stake_atoms: stake.toString(),
        stake_kvnc: `${formatKvnc(stake)} KVNC`,
        hex_quantity: `0x${stake.toString(16)}`,
      };
    },
  },
  {
    method: "kovanica_getRewards",
    category: "Staking",
    description: "Returns cumulative earned rewards for an address in atoms and KVNC.",
    params: [
      {
        name: "address",
        label: "Account Address",
        type: "address",
        required: true,
        placeholder: "kvnc...dag",
      },
    ],
    execute: async (client, params, options) => {
      const rewards = await client.getRewards(params.address, options);
      return {
        rewards_atoms: rewards.toString(),
        rewards_kvnc: `${formatKvnc(rewards)} KVNC`,
        hex_quantity: `0x${rewards.toString(16)}`,
      };
    },
  },
  {
    method: "kovanica_getLeaderSchedule",
    category: "Staking",
    description: "Returns upcoming leader slots schedule.",
    params: [
      {
        name: "count",
        label: "Number of Rounds",
        type: "number",
        defaultValue: 16,
        placeholder: "16",
        description: "Number of rounds to project (max 1024).",
      },
    ],
    execute: async (client, params, options) => {
      return client.getLeaderSchedule(
        params.count ? Number(params.count) : 16,
        options,
      );
    },
  },
  {
    method: "kovanica_syncStatus",
    category: "Diagnostics",
    description: "Returns node peer count, tip round, height, and catch-up status.",
    params: [],
    execute: async (client, _params, options) => {
      return client.syncStatus(options);
    },
  },
  {
    method: "kovanica_getMiningInfo",
    category: "Mining & DAG",
    description: "Returns PoW mining metrics, difficulty, and DAA target (Hybrid PoW / Chain 5).",
    params: [],
    execute: async (client, _params, options) => {
      return client.getMiningInfo(options);
    },
  },
  {
    method: "kovanica_getDagTips",
    category: "Mining & DAG",
    description: "Returns active DAG tip block hashes (Hybrid PoW / Chain 5).",
    params: [],
    execute: async (client, _params, options) => {
      return client.getDagTips(options);
    },
  },
];

/**
 * Validates a single parameter value given its schema definition and target chain ID.
 */
export function validateParam(
  param: MethodParam,
  value: any,
  chainId: number = CHAIN_IDS.MAINNET,
): { valid: boolean; error?: string } {
  if (param.required && (value === undefined || value === null || value === "")) {
    return { valid: false, error: `${param.label} is required` };
  }

  if (value === undefined || value === null || value === "") {
    return { valid: true };
  }

  const str = String(value).trim();

  if (param.type === "address") {
    if (!isValidAddress(str, chainId)) {
      return {
        valid: false,
        error: `Invalid address for chain ${chainId}. Expected 64-char PRO-21 base32 address (kvnc...dag).`,
      };
    }
  }

  if (param.type === "hex32") {
    const raw = str.startsWith("0x") ? str.slice(2) : str;
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      return { valid: false, error: "Must be a 32-byte hexadecimal string (64 hex characters)." };
    }
  }

  if (param.type === "number") {
    const num = Number(str);
    if (Number.isNaN(num) || !Number.isFinite(num)) {
      return { valid: false, error: "Must be a valid number." };
    }
  }

  return { valid: true };
}
