import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

import {
  createPublicClient,
  createWalletClient,
  http,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

// 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
export const anvilAccount = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

// 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
export const secondAnvilAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

type AnvilPublicClient = PublicClient<HttpTransport, typeof foundry>;
type AnvilWalletClient = WalletClient<HttpTransport, typeof foundry, typeof anvilAccount>;

function makePublicClient(url: string): AnvilPublicClient {
  return createPublicClient({ chain: foundry, pollingInterval: 10, transport: http(url) });
}

function makeWalletClient(url: string): AnvilWalletClient {
  return createWalletClient({ account: anvilAccount, chain: foundry, transport: http(url) });
}

export type AnvilTestContext = {
  port: number;
  url: string;
  process: ChildProcess;
  publicClient: AnvilPublicClient;
  walletClient: AnvilWalletClient;
  account: PrivateKeyAccount;
  secondAccount: PrivateKeyAccount;
  stop: () => void;
};

export async function startAnvil(): Promise<AnvilTestContext> {
  const port = await freePort();
  const process = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  const publicClient = makePublicClient(url);
  const walletClient = makeWalletClient(url);

  try {
    await waitForAnvil(publicClient, process);
  } catch (cause) {
    process.kill();
    throw cause;
  }

  return {
    port,
    url,
    process,
    publicClient,
    walletClient,
    account: anvilAccount,
    secondAccount: secondAnvilAccount,
    stop: () => {
      process.kill();
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate local port."));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
  });
}

async function waitForAnvil(client: AnvilPublicClient, process: ChildProcess): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (process.exitCode !== null) throw new Error(`anvil exited with code ${process.exitCode}`);
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error("Timed out waiting for anvil.");
}
