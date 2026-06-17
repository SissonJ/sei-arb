const SEI_RPC = "https://misty-chaotic-energy.sei-pacific.quiknode.pro/ee4fe2a7c05a4f87ed6048a930fa4292c820de9b/";

export const POOLS = {
  // DragonSwap
  DS_USDC_WSEI: "0xcca2352200a63eb0aaba2d40ba69b1d32174f285",
  DS_WSEI_WBTC: "0x3e00dd875fef6ce2209007c1e625d9a656e32556",
  DS_WBTC_USDC: "0xe62fd4661c85e126744cc335e9bca8ae3d5d19d1",
  // SailorSwap
  SS_USDC_WSEI_1: "0x80fe558c54f1f43263e08f0e1fa3e02d8b897f93",
  SS_USDC_WSEI_2: "0x038aac60e1d17ce2229812eca8ee7800214baffc",
};

const DS_ADDRS = new Set([POOLS.DS_USDC_WSEI, POOLS.DS_WSEI_WBTC, POOLS.DS_WBTC_USDC]);

export const Q96 = 2n ** 96n;

let rpcId = 0;

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type BatchItem = { to: string; data: string };

export async function batchCall(calls: BatchItem[], retries = 5): Promise<string[]> {
  const batch = calls.map((c) => ({
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(SEI_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    const json = (await res.json()) as Array<{ result?: string; error?: { message: string } }>;

    const rateLimited = json.some((r) => r.error?.message?.includes("rate limit") || r.error?.message?.includes("server busy"));
    if (rateLimited) {
      await sleep(1500 * (attempt + 1));
      continue;
    }

    return json.map((r, i) => {
      if (r.error) throw new Error(`Call ${i} (${calls[i].data.slice(0, 10)}): ${r.error.message}`);
      return r.result!;
    });
  }
  throw new Error("Max retries exceeded");
}

function decodeAddress(hex: string): string {
  return "0x" + hex.slice(-40).toLowerCase();
}

export function decodeUint(hex: string): bigint {
  const s = hex.startsWith("0x") ? hex : "0x" + hex;
  return s.length <= 2 ? 0n : BigInt(s);
}

function decodeString(hex: string): string {
  const data = hex.slice(2);
  const offset = parseInt(data.slice(0, 64), 16) * 2;
  const length = parseInt(data.slice(offset, offset + 64), 16);
  return Buffer.from(data.slice(offset + 64, offset + 64 + length * 2), "hex").toString("utf8");
}

export interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  fee: bigint;
}

const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();

export async function fetchPools(poolAddrs: string[], interBatchDelay = 0): Promise<PoolInfo[]> {
  const batch1 = poolAddrs.flatMap((addr) => [
    { to: addr, data: "0x0dfe1681" }, // token0
    { to: addr, data: "0xd21220a7" }, // token1
    { to: addr, data: "0x3850c7bd" }, // slot0
    { to: addr, data: "0x1a686502" }, // liquidity
    { to: addr, data: "0xddca3f43" }, // fee
  ]);

  const r1 = await batchCall(batch1);

  const pools_partial = poolAddrs.map((addr, i) => {
    const base = i * 5;
    const token0 = decodeAddress(r1[base]);
    const token1 = decodeAddress(r1[base + 1]);
    const sqrtPriceX96 = BigInt("0x" + r1[base + 2].slice(2, 66));
    const liquidity = decodeUint(r1[base + 3]);
    const fee = decodeUint(r1[base + 4]);
    return { address: addr, token0, token1, sqrtPriceX96, liquidity, fee };
  });

  const uncachedAddrs = [...new Set(
    pools_partial.flatMap((p) => [p.token0, p.token1])
  )].filter((addr) => !tokenMetaCache.has(addr));

  if (uncachedAddrs.length > 0) {
    if (interBatchDelay > 0) await sleep(interBatchDelay);
    const batch2 = uncachedAddrs.flatMap((addr) => [
      { to: addr, data: "0x95d89b41" }, // symbol
      { to: addr, data: "0x313ce567" }, // decimals
    ]);
    const r2 = await batchCall(batch2);
    uncachedAddrs.forEach((addr, i) => {
      tokenMetaCache.set(addr, {
        symbol: decodeString(r2[i * 2]),
        decimals: Number(decodeUint(r2[i * 2 + 1])),
      });
    });
  }

  return pools_partial.map((p) => {
    const m0 = tokenMetaCache.get(p.token0)!;
    const m1 = tokenMetaCache.get(p.token1)!;
    return { ...p, symbol0: m0.symbol, symbol1: m1.symbol, decimals0: m0.decimals, decimals1: m1.decimals };
  });
}

export function v3SwapAmountOut(
  pool: PoolInfo,
  tokenIn: string,
  amountIn: bigint
): { amountOut: bigint; tokenOut: string } {
  const zeroForOne = tokenIn.toLowerCase() === pool.token0.toLowerCase();
  const tokenOut = zeroForOne ? pool.token1 : pool.token0;

  const feeBase = 1_000_000n;
  const effectiveIn = (amountIn * (feeBase - pool.fee)) / feeBase;
  const L = pool.liquidity;
  const sqrtP = pool.sqrtPriceX96;

  if (L === 0n || sqrtP === 0n) return { amountOut: 0n, tokenOut };

  let amountOut: bigint;
  if (zeroForOne) {
    const sqrtP_new = (L * sqrtP * Q96) / (L * Q96 + effectiveIn * sqrtP);
    amountOut = (L * (sqrtP - sqrtP_new)) / Q96;
  } else {
    const sqrtP_new = sqrtP + (effectiveIn * Q96) / L;
    amountOut = (L * Q96 * (sqrtP_new - sqrtP)) / (sqrtP * sqrtP_new);
  }

  return { amountOut, tokenOut };
}

export function fmtAmt(amount: bigint, decimals: number): string {
  if (amount < 0n) return `-${fmtAmt(-amount, decimals)}`;
  const s = amount.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals) || "0";
  const fracPart = s.slice(s.length - decimals).slice(0, decimals > 6 ? 8 : 6);
  return `${intPart}.${fracPart}`;
}

export function getBySymbol(pool: PoolInfo, sym: string) {
  if (pool.symbol0 === sym) return { addr: pool.token0, dec: pool.decimals0 };
  if (pool.symbol1 === sym) return { addr: pool.token1, dec: pool.decimals1 };
  throw new Error(`Symbol ${sym} not found in pool ${pool.address}`);
}

export function spotPrice(pool: PoolInfo): string {
  if (pool.sqrtPriceX96 === 0n) return "no price (uninitialized)";
  const priceRaw = (Number(pool.sqrtPriceX96) / Number(Q96)) ** 2;
  const token1PerToken0 = priceRaw * 10 ** pool.decimals0 / 10 ** pool.decimals1;
  if (token1PerToken0 >= 1) {
    return `1 ${pool.symbol0} = ${token1PerToken0.toFixed(4)} ${pool.symbol1}`;
  } else {
    return `1 ${pool.symbol1} = ${(1 / token1PerToken0).toFixed(4)} ${pool.symbol0}`;
  }
}

export function dexLabel(addr: string): string {
  return DS_ADDRS.has(addr.toLowerCase()) ? "DragonSwap" : "SailorSwap";
}

export interface Hop { pool: PoolInfo; tokenIn: string }

export interface RouteResult {
  label: string;
  pct: number;   // profit as percentage of input (e.g. -1.05 means -1.05%)
  profit: number; // absolute profit in input token units
}

export function computeRoute(
  label: string,
  hops: Hop[],
  inputAmount: bigint,
  inputDecimals: number,
): RouteResult {
  let amount = inputAmount;
  for (const hop of hops) {
    amount = v3SwapAmountOut(hop.pool, hop.tokenIn, amount).amountOut;
  }
  const inputF = Number(inputAmount) / 10 ** inputDecimals;
  const outputF = Number(amount) / 10 ** inputDecimals;
  const profit = outputF - inputF;
  const pct = (profit / inputF) * 100;
  return { label, pct, profit };
}

export function printRoute(
  label: string,
  hops: Hop[],
  inputAmount: bigint,
  inputDecimals: number,
  inputSymbol: string,
): RouteResult {
  console.log(`\nRoute: ${label}`);
  console.log("─".repeat(72));

  let amount = inputAmount;
  for (const hop of hops) {
    const zeroForOne = hop.tokenIn.toLowerCase() === hop.pool.token0.toLowerCase();
    const inSym  = zeroForOne ? hop.pool.symbol0  : hop.pool.symbol1;
    const inDec  = zeroForOne ? hop.pool.decimals0 : hop.pool.decimals1;
    const outSym = zeroForOne ? hop.pool.symbol1  : hop.pool.symbol0;
    const outDec = zeroForOne ? hop.pool.decimals1 : hop.pool.decimals0;
    const result = v3SwapAmountOut(hop.pool, hop.tokenIn, amount);
    console.log(`  [${dexLabel(hop.pool.address)} ${hop.pool.symbol0}/${hop.pool.symbol1}]  ${fmtAmt(amount, inDec)} ${inSym}  ->  ${fmtAmt(result.amountOut, outDec)} ${outSym}`);
    amount = result.amountOut;
  }

  const result = computeRoute(label, hops, inputAmount, inputDecimals);
  console.log(`  P&L: ${result.profit >= 0 ? "+" : ""}${result.profit.toFixed(4)} ${inputSymbol}  (${result.pct.toFixed(4)}%)${result.profit > 0 ? "  *** OPPORTUNITY ***" : ""}`);
  return result;
}

export interface TokenRefs {
  usdc: { addr: string; dec: number };
  wsei: { addr: string; dec: number };
  wbtc: { addr: string; dec: number };
}

export function buildAllPoolAddrs() {
  return [
    POOLS.DS_USDC_WSEI,
    POOLS.DS_WSEI_WBTC,
    POOLS.DS_WBTC_USDC,
    POOLS.SS_USDC_WSEI_1,
    POOLS.SS_USDC_WSEI_2,
  ];
}

export function buildRoutes(
  dsUsdcWsei: PoolInfo,
  dsWseiWbtc: PoolInfo,
  dsWbtcUsdc: PoolInfo,
  ssUsdcWsei1: PoolInfo,
  ssUsdcWsei2: PoolInfo,
  usdc: { addr: string },
  wsei: { addr: string },
  wbtc: { addr: string },
): Array<{ label: string; hops: Hop[] }> {
  return [
    {
      label: "USDC -> WSEI [DS] -> WBTC [DS] -> USDC [DS]",
      hops: [
        { pool: dsUsdcWsei, tokenIn: usdc.addr },
        { pool: dsWseiWbtc, tokenIn: wsei.addr },
        { pool: dsWbtcUsdc, tokenIn: wbtc.addr },
      ],
    },
    {
      label: "USDC -> WBTC [DS] -> WSEI [DS] -> USDC [DS]",
      hops: [
        { pool: dsWbtcUsdc, tokenIn: usdc.addr },
        { pool: dsWseiWbtc, tokenIn: wbtc.addr },
        { pool: dsUsdcWsei, tokenIn: wsei.addr },
      ],
    },
    {
      label: "USDC -> WSEI [SS1] -> WBTC [DS] -> USDC [DS]",
      hops: [
        { pool: ssUsdcWsei1, tokenIn: usdc.addr },
        { pool: dsWseiWbtc,  tokenIn: wsei.addr },
        { pool: dsWbtcUsdc,  tokenIn: wbtc.addr },
      ],
    },
    {
      label: "USDC -> WBTC [DS] -> WSEI [DS] -> USDC [SS1]",
      hops: [
        { pool: dsWbtcUsdc,  tokenIn: usdc.addr },
        { pool: dsWseiWbtc,  tokenIn: wbtc.addr },
        { pool: ssUsdcWsei1, tokenIn: wsei.addr },
      ],
    },
    {
      label: "USDC -> WSEI [SS2] -> WBTC [DS] -> USDC [DS]",
      hops: [
        { pool: ssUsdcWsei2, tokenIn: usdc.addr },
        { pool: dsWseiWbtc,  tokenIn: wsei.addr },
        { pool: dsWbtcUsdc,  tokenIn: wbtc.addr },
      ],
    },
    {
      label: "USDC -> WBTC [DS] -> WSEI [DS] -> USDC [SS2]",
      hops: [
        { pool: dsWbtcUsdc,  tokenIn: usdc.addr },
        { pool: dsWseiWbtc,  tokenIn: wbtc.addr },
        { pool: ssUsdcWsei2, tokenIn: wsei.addr },
      ],
    },
    {
      label: "USDC -> WSEI [DS] -> USDC [SS1]",
      hops: [
        { pool: dsUsdcWsei,  tokenIn: usdc.addr },
        { pool: ssUsdcWsei1, tokenIn: wsei.addr },
      ],
    },
    {
      label: "USDC -> WSEI [SS1] -> USDC [DS]",
      hops: [
        { pool: ssUsdcWsei1, tokenIn: usdc.addr },
        { pool: dsUsdcWsei,  tokenIn: wsei.addr },
      ],
    },
    {
      label: "USDC -> WSEI [DS] -> USDC [SS2]",
      hops: [
        { pool: dsUsdcWsei,  tokenIn: usdc.addr },
        { pool: ssUsdcWsei2, tokenIn: wsei.addr },
      ],
    },
    {
      label: "USDC -> WSEI [SS2] -> USDC [DS]",
      hops: [
        { pool: ssUsdcWsei2, tokenIn: usdc.addr },
        { pool: dsUsdcWsei,  tokenIn: wsei.addr },
      ],
    },
    {
      label: "USDC -> WSEI [SS1] -> USDC [SS2]",
      hops: [
        { pool: ssUsdcWsei1, tokenIn: usdc.addr },
        { pool: ssUsdcWsei2, tokenIn: wsei.addr },
      ],
    },
    {
      label: "USDC -> WSEI [SS2] -> USDC [SS1]",
      hops: [
        { pool: ssUsdcWsei2, tokenIn: usdc.addr },
        { pool: ssUsdcWsei1, tokenIn: wsei.addr },
      ],
    },
  ];
}

// Ternary search for the input amount that maximises absolute profit.
// Profit(x) is concave for single-tick V3 pools, so this converges in O(log n).
export function findOptimalInput(
  hops: Hop[],
  inputDecimals: number,
  lo: bigint = 1n * 10n ** BigInt(inputDecimals),
  hi: bigint = 50_000n * 10n ** BigInt(inputDecimals),
  iterations = 64,
): { optimalInput: bigint; maxProfit: number } {
  for (let i = 0; i < iterations; i++) {
    const third = (hi - lo) / 3n;
    if (third === 0n) break;
    const m1 = lo + third;
    const m2 = hi - third;
    const p1 = computeRoute("", hops, m1, inputDecimals).profit;
    const p2 = computeRoute("", hops, m2, inputDecimals).profit;
    if (p1 < p2) lo = m1; else hi = m2;
  }
  const optimalInput = (lo + hi) / 2n;
  const maxProfit = computeRoute("", hops, optimalInput, inputDecimals).profit;
  return { optimalInput, maxProfit };
}
