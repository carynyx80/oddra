import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Abi,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db, hasDatabase } from "@oddra/db";
import { chainById } from "@oddra/shared";
import type { Env } from "./env";
import { errMsg, log } from "./log";

export interface Chain {
  pub: PublicClient;
  operator: WalletClient & { account: Account };
  keeper: WalletClient & { account: Account };
  /** Chain time in seconds: the latest block's timestamp plus monotonic time elapsed since it was read. */
  now(): number;
  refreshTime(): Promise<number>;
  send(opts: SendOpts): Promise<Hash>;
}

export interface SendOpts {
  purpose: string;
  matchId?: bigint;
  signer?: "operator" | "keeper";
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export function connect(env: Env): Chain {
  const chain = chainById(env.chainId);
  // RPC failover: requests move to the next endpoint when one fails
  const transport = fallback(
    env.rpcUrls.map((u) => http(u, { retryCount: 2, retryDelay: 500, timeout: 15_000 })),
    { rank: false },
  );
  const pub = createPublicClient({ chain, transport, pollingInterval: 1_000 }) as PublicClient;
  const operator = createWalletClient({ chain, transport, account: privateKeyToAccount(env.operatorKey) });
  const keeper = createWalletClient({ chain, transport, account: privateKeyToAccount(env.keeperKey) });

  let base = 0;
  let baseAt = 0;
  const now = () => (base === 0 ? 0 : base + (performance.now() - baseAt) / 1000);
  const refreshTime = async () => {
    const t0 = performance.now();
    const b = await pub.getBlock({ blockTag: "latest" });
    base = Number(b.timestamp);
    baseAt = (t0 + performance.now()) / 2;
    return now();
  };

  // Transactions go out one at a time per signer, so nonces never collide; every step re-checks chain state first,
  // so a failed or dropped transaction is simply retried on the next tick.
  const queues: Record<string, Promise<unknown>> = { operator: Promise.resolve(), keeper: Promise.resolve() };
  const send = (o: SendOpts): Promise<Hash> => {
    const who = o.signer ?? "operator";
    const wallet = who === "keeper" ? keeper : operator;
    const job = queues[who].then(async () => {
      const { request } = await pub.simulateContract({
        account: wallet.account,
        address: o.address,
        abi: o.abi,
        functionName: o.functionName,
        args: o.args,
      } as never);
      const hash = await wallet.writeContract(request as never);
      if (hasDatabase())
        await db()
          .blockchainTransaction.create({
            data: {
              hash,
              purpose: o.purpose,
              matchId: o.matchId ?? null,
              from: wallet.account.address,
              to: o.address,
              status: "sent",
            },
          })
          .catch(() => {});
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      const ok = receipt.status === "success";
      if (hasDatabase())
        await db()
          .blockchainTransaction.update({
            where: { hash },
            data: { status: ok ? "confirmed" : "reverted", gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber },
          })
          .catch(() => {});
      if (!ok) throw new Error(`${o.purpose} reverted in ${hash}`);
      log.info("tx confirmed", { purpose: o.purpose, matchId: o.matchId, hash, gas: receipt.gasUsed });
      return hash;
    });
    queues[who] = job.catch((e) => log.warn("tx failed", { purpose: o.purpose, matchId: o.matchId, error: errMsg(e) }));
    return job;
  };

  return { pub, operator, keeper, now, refreshTime, send };
}
