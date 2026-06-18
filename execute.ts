/**
 * Execute a detected arb opportunity on-chain via AtomicArb.
 *
 * Required env vars:
 *   ARB_CONTRACT_ADDRESS  — deployed AtomicArb address
 *   PRIVATE_KEY           — executor's private key
 *   SEI_RPC               — (optional) defaults to the hardcoded endpoint
 *
 * Usage (one-shot):
 *   bun execute.ts
 */

import { ethers } from "ethers";
import {
  POOLS,
  buildAllPoolAddrs,
  fetchPools,
  buildRoutes,
  findOptimalInput,
  computeRoute,
  getBySymbol,
  type PoolInfo,
} from "./lib";

const SEI_RPC = process.env.SEI_RPC ?? "https://misty-chaotic-energy.sei-pacific.quiknode.pro/ee4fe2a7c05a4f87ed6048a930fa4292c820de9b/";
const CONTRACT_ADDRESS = process.env.ARB_CONTRACT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!CONTRACT_ADDRESS) throw new Error("ARB_CONTRACT_ADDRESS env var required");
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env var required");

const ABI = [
  "function executeArb(address flashPool, address flashToken, uint256 borrowAmount, tuple(address pool, bool zeroForOne, address tokenIn)[] route, uint256 minProfit) external",
];

// Minimum profit in USDC units (6 decimals) — tune to cover gas cost
const MIN_PROFIT_USDC = 1_000_000n; // 1 USDC

async function main() {
  const provider = new ethers.JsonRpcProvider(SEI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS!, ABI, wallet);

  console.log("Fetching pool state…");
  const poolAddrs = buildAllPoolAddrs();
  const pools = await fetchPools(poolAddrs);

  const [dsUsdcWsei, dsWseiWbtc, dsWbtcUsdc, ssUsdcWsei1, ssUsdcWsei2] = pools;

  const usdc = getBySymbol(dsUsdcWsei, "USDC");
  const wsei = getBySymbol(dsUsdcWsei, "WSEI");
  const wbtc = getBySymbol(dsWseiWbtc, "WBTC");

  const routes = buildRoutes(
    dsUsdcWsei, dsWseiWbtc, dsWbtcUsdc, ssUsdcWsei1, ssUsdcWsei2,
    usdc, wsei, wbtc,
  );

  // Find the single most profitable route and its optimal input
  let best: {
    label: string;
    profit: number;
    optimalInput: bigint;
    hops: typeof routes[0]["hops"];
  } | null = null;

  for (const { label, hops } of routes) {
    const { optimalInput, maxProfit } = findOptimalInput(hops, usdc.dec);
    if (maxProfit > (best?.profit ?? 0)) {
      best = { label, profit: maxProfit, optimalInput, hops };
    }
  }

  if (!best || best.profit <= 0) {
    console.log("No profitable route found.");
    return;
  }

  console.log(`Best route: ${best.label}`);
  console.log(`  Optimal input: ${best.optimalInput} (${usdc.dec} decimals)`);
  console.log(`  Expected profit: ${best.profit.toFixed(4)} USDC`);

  // Translate hops to on-chain SwapStep structs
  const route = best.hops.map((hop) => {
    const zeroForOne = hop.tokenIn.toLowerCase() === hop.pool.token0.toLowerCase();
    return {
      pool: hop.pool.address,
      zeroForOne,
      tokenIn: hop.tokenIn,
    };
  });

  // Pick the flash pool: USDC pool with most liquidity (first USDC pool in route or DS_USDC_WSEI)
  const flashPool = best.hops[0].pool.address;
  const flashToken = usdc.addr;
  const borrowAmount = best.optimalInput;

  // Convert min profit to on-chain units with a 10% safety buffer
  const profitUnits = BigInt(Math.floor(best.profit * 10 ** usdc.dec));
  const minProfit = (profitUnits * 9n) / 10n; // 90% of expected, buffer for price movement

  if (minProfit < MIN_PROFIT_USDC) {
    console.log(`Profit ${minProfit} below minimum threshold ${MIN_PROFIT_USDC}. Skipping.`);
    return;
  }

  console.log(`Executing arb: flashPool=${flashPool}, borrow=${borrowAmount}, minProfit=${minProfit}`);
  const tx = await contract.executeArb(flashPool, flashToken, borrowAmount, route, minProfit);
  const receipt = await tx.wait();
  console.log(`Executed in tx ${receipt.hash} (block ${receipt.blockNumber})`);
}

main().catch(console.error);
