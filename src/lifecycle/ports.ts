import { createServer } from "node:net";

export async function assertPortAvailable(options: {
  port: number;
  serviceName: string;
  portEnv?: string;
  externalModeEnv?: string;
  stopCommand?: string;
  host?: string;
}): Promise<void> {
  const {
    port,
    serviceName,
    portEnv,
    externalModeEnv,
    stopCommand = "pnpm e2e:stop",
    host = "127.0.0.1",
  } = options;
  if (await isPortAvailable(port, host)) return;

  const hints = [
    `${serviceName} port ${port} is already in use.`,
    `  Stop the existing local services with: ${stopCommand}`,
  ];
  if (externalModeEnv) hints.push(`  Or set ${externalModeEnv}=true to attach to the existing service intentionally.`);
  if (portEnv) hints.push(`  Or set ${portEnv}=<open-port> to use a different local port.`);
  throw new Error(hints.join("\n"));
}

export async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}