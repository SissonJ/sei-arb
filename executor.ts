import { Contract, JsonRpcProvider } from "ethers";
import { fmtAmt, loadWallet } from "./lib";
import type { Hop } from "./lib";

// DragonSwap 0.01% USDC pools to borrow from, in order of preference.
// A route cannot borrow from one of its own pools, because the flash locks that pool.
const FLASH_POOLS = [
  "0xc1b96fa8421807c5bac89ba699c75737c81feea5", // USDY/USDC, about 525k USDC
  "0xf62bd525e82577a162de88bd70de032a62675237", // USDT0/USDC, about 68k USDC
];
// The fee of every pool in FLASH_POOLS
export const FLASH_FEE = 0.0001;

const SEI_MAINNET_CHAIN_ID = 1329n;
// A 3-hop execute used 670k gas on a fork with a 39k USDC size. Large sizes cross more ticks and use more gas.
const GAS_LIMIT = 1_500_000n;
// The local model assumes constant liquidity and can overestimate the best size,
// so the executor also simulates smaller sizes and sends the one with the highest real profit
const SIZE_DIVISORS = [1n, 2n, 4n, 8n];

const ABI = [
  "function execute(address flashPool, address token, uint256 amount, (address pool, bool zeroForOne)[] hops, uint256 minProfit) returns (uint256 profit)",
  "error Unprofitable(uint256 balance, uint256 required)",
  "error NotOwner()",
];

export interface ExecutorConfig {
  rpc: string;
  contract: string;
  privateKey: string; // a private key or a mnemonic
  token: { addr: string; dec: number };
  minProfit: bigint; // raw token units; the contract reverts below this
  send: boolean;     // false: simulate only
  notify: (title: string, message: string) => void;
}

type SimResult = { amount: bigint; profit: bigint } | { amount: bigint; error: string };

export async function createExecutor(cfg: ExecutorConfig) {
  const provider = new JsonRpcProvider(cfg.rpc);
  const { chainId } = await provider.getNetwork();
  if (chainId !== SEI_MAINNET_CHAIN_ID) {
    throw new Error(`Executor RPC is on chain ${chainId}, expected Sei mainnet (${SEI_MAINNET_CHAIN_ID})`);
  }

  const wallet = loadWallet(cfg.privateKey).connect(provider);
  const execute = new Contract(cfg.contract, ABI, wallet).getFunction("execute");
  const fmt = (x: bigint) => fmtAmt(x, cfg.token.dec);
  let busy = false;

  async function simulate(flashPool: string, hops: object[], amount: bigint): Promise<SimResult> {
    try {
      const profit: bigint = await execute.staticCall(flashPool, cfg.token.addr, amount, hops, cfg.minProfit);
      return { amount, profit };
    } catch (err) {
      return { amount, error: (err as { shortMessage?: string }).shortMessage ?? String(err) };
    }
  }

  // Simulates the route at several sizes and sends the most profitable one.
  // Skips the opportunity if a previous one is still in flight.
  async function tryExecute(label: string, hops: Hop[], modelAmount: bigint) {
    if (busy) return;
    busy = true;
    try {
      const flashPool = FLASH_POOLS.find((f) => !hops.some((h) => h.pool.address === f));
      if (!flashPool) {
        console.log(`[exec] no flash pool off the route | ${label}`);
        return;
      }
      const callHops = hops.map((h) => ({
        pool: h.pool.address,
        zeroForOne: h.tokenIn.toLowerCase() === h.pool.token0.toLowerCase(),
      }));

      const sims = await Promise.all(SIZE_DIVISORS.map((d) => simulate(flashPool, callHops, modelAmount / d)));
      let best: { amount: bigint; profit: bigint } | undefined;
      for (const s of sims) {
        if ("profit" in s && (!best || s.profit > best.profit)) best = s;
      }
      if (!best) {
        const first = sims[0];
        console.log(`[exec] no profitable size | ${label} | ${first && "error" in first ? first.error : ""}`);
        return;
      }

      const summary = `size ${fmt(best.amount)} USDC → +${fmt(best.profit)} USDC | ${label}`;
      if (!cfg.send) {
        console.log(`[exec] simulated (send disabled) ${summary}`);
        cfg.notify("Sei Arb SIMULATED", summary);
        return;
      }

      const tx = await execute(flashPool, cfg.token.addr, best.amount, callHops, cfg.minProfit, { gasLimit: GAS_LIMIT });
      console.log(`[exec] sent ${tx.hash} ${summary}`);
      // wait() throws if the transaction reverts
      const receipt = await tx.wait();
      console.log(`[exec] confirmed ${tx.hash} gasUsed=${receipt?.gasUsed}`);
      cfg.notify("Sei Arb EXECUTED", `${summary}\ntx ${tx.hash}`);
    } catch (err) {
      console.error("[exec] error:", (err as { shortMessage?: string }).shortMessage ?? err);
    } finally {
      busy = false;
    }
  }

  console.log(`[exec] ready  wallet=${wallet.address}  contract=${cfg.contract}  send=${cfg.send}`);
  return tryExecute;
}
