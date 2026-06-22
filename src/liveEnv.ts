export interface LiveEnvironment {
  profile: string;
  isLumenProfile: boolean;
  externalCoordinator: boolean;
  coordinatorPort: number;
  consolePort: number;
  coordinatorUrl: string;
  chainId: string;
}

export function resolveLiveEnvironment(env: NodeJS.ProcessEnv = process.env): LiveEnvironment {
  const profile = env.VIBLY_E2E_PROFILE ?? "default";
  const isLumenProfile = profile === "lumen";
  const externalCoordinator = env.VIBLY_E2E_EXTERNAL_COORDINATOR === "true";
  const coordinatorPort = Number(env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
  const consolePort = Number(env.VIBLY_E2E_CONSOLE_PORT ?? "3001");
  const coordinatorUrl =
    env.COORDINATOR_URL ??
    (externalCoordinator || isLumenProfile ? env.LUMEN_COORDINATOR_URL : undefined) ??
    `http://127.0.0.1:${coordinatorPort}`;
  const chainId = externalCoordinator || isLumenProfile
    ? env.VIBLY_E2E_CHAIN_ID ?? "substrate:vibly-testnet"
    : env.VIBLY_E2E_LOCAL_CHAIN_ID ?? "substrate:vibly-solo";

  return {
    profile,
    isLumenProfile,
    externalCoordinator,
    coordinatorPort,
    consolePort,
    coordinatorUrl,
    chainId,
  };
}
