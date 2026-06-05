import process from "node:process";

export interface E2eNetworkProfile {
  id: string;
  label: string;
  stage: "local" | "testnet" | "mainnet";
  coordinatorUrls: string[];
  viblyRpcUrls: string[];
  paymentRpcUrls: string[];
  paymentTokenSymbol: string;
  paymentTokenDecimals: number;
  relayTokenSymbol: string;
}

const PASEO_PAYMENT_RPC_URLS = [
  "wss://rpc.ibp.network/paseo",
  "wss://paseo.dotters.network",
  "wss://paseo-rpc.dwellir.com",
];

const POLKADOT_PAYMENT_RPC_URLS = [
  "wss://rpc.polkadot.io",
  "wss://polkadot.api.onfinality.io/public-ws",
  "wss://polkadot-rpc.dwellir.com",
];

function splitUrls(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

export function localNetworkProfile(input: {
  coordinatorUrl: string;
  viblyRpcUrl: string;
  paymentRpcUrl: string;
}): E2eNetworkProfile {
  return {
    id: process.env.VIBLY_E2E_CHAIN_ID ?? "substrate:vibly-solo",
    label: process.env.VIBLY_E2E_NETWORK_NAME ?? "Local",
    stage: "local",
    coordinatorUrls: [input.coordinatorUrl],
    viblyRpcUrls: [input.viblyRpcUrl],
    paymentRpcUrls: [input.paymentRpcUrl],
    paymentTokenSymbol: process.env.VIBLY_E2E_PAYMENT_TOKEN_SYMBOL ?? "DOT",
    paymentTokenDecimals: Number(process.env.VIBLY_E2E_PAYMENT_TOKEN_DECIMALS ?? "10"),
    relayTokenSymbol: process.env.VIBLY_E2E_PAYMENT_TOKEN_SYMBOL ?? "DOT",
  };
}

export function remoteNetworkProfiles(): E2eNetworkProfile[] {
  const testnetCoordinator = firstNonEmpty(process.env.VIBLY_E2E_TESTNET_COORDINATOR_URL, process.env.COORDINATOR_URL);
  const incentivizedCoordinator = firstNonEmpty(process.env.VIBLY_E2E_INCENTIVIZED_COORDINATOR_URL, process.env.COORDINATOR_URL);
  const testnetVibly = splitUrls(process.env.VIBLY_E2E_TESTNET_VIBLY_RPC_URLS);
  const incentivizedVibly = splitUrls(process.env.VIBLY_E2E_INCENTIVIZED_VIBLY_RPC_URLS);

  return [
    {
      id: "substrate:vibly-testnet",
      label: "Lumen",
      stage: "testnet",
      coordinatorUrls: testnetCoordinator ? [testnetCoordinator] : [],
      viblyRpcUrls: testnetVibly,
      paymentRpcUrls: splitUrls(process.env.VIBLY_E2E_PASEO_RPC_URLS).concat(PASEO_PAYMENT_RPC_URLS),
      paymentTokenSymbol: "PAS",
      paymentTokenDecimals: 10,
      relayTokenSymbol: "PAS",
    },
    {
      id: "substrate:vibly-incentivized-testnet",
      label: "Monolith",
      stage: "mainnet",
      coordinatorUrls: incentivizedCoordinator ? [incentivizedCoordinator] : [],
      viblyRpcUrls: incentivizedVibly,
      paymentRpcUrls: splitUrls(process.env.VIBLY_E2E_POLKADOT_RPC_URLS).concat(POLKADOT_PAYMENT_RPC_URLS),
      paymentTokenSymbol: "DOT",
      paymentTokenDecimals: 10,
      relayTokenSymbol: "DOT",
    },
  ];
}

export function publicConsoleNetworkProfiles(local: E2eNetworkProfile): string {
  return JSON.stringify([local, ...remoteNetworkProfiles()]);
}

export function serverCoordinatorNetworkProfiles(local: E2eNetworkProfile): string {
  const profiles = [local, ...remoteNetworkProfiles()]
    .map((profile) => ({
      id: profile.id,
      coordinatorUrl: profile.coordinatorUrls[0],
      apiToken: process.env.COORDINATOR_API_TOKEN ?? "dev-token",
    }))
    .filter((profile) => Boolean(profile.coordinatorUrl));
  return JSON.stringify(profiles);
}
