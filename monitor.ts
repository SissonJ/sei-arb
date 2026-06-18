import {
  buildAllPoolAddrs, buildRoutes, findOptimalInput, fetchPools,
  getBySymbol, fmtAmt,
} from "./lib";
import type { PoolInfo } from "./lib";

const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const MIN_PROFIT_USDC = 1.0;
const HEARTBEAT_INTERVAL_MS = 30_000;

const SEI_WS = Bun.env.SEI_WS!;
const PUSHOVER_TOKEN = Bun.env.PUSHOVER_TOKEN!;
const PUSHOVER_USER = Bun.env.PUSHOVER_USER!;

async function notify(title: string, message: string) {
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title, message }),
  });
}

// Non-indexed Swap data layout (each field is a 32-byte ABI word):
//   [0..64]   amount0     (int256)
//   [64..128] amount1     (int256)
//   [128..192] sqrtPriceX96 (uint160)
//   [192..256] liquidity  (uint128)
//   [256..320] tick       (int24)
function parseSwapLog(data: string): { sqrtPriceX96: bigint; liquidity: bigint } {
  const d = data.slice(2);
  return {
    sqrtPriceX96: BigInt("0x" + d.slice(128, 192)),
    liquidity:    BigInt("0x" + d.slice(192, 256)),
  };
}

async function monitor() {
  const poolAddrs = buildAllPoolAddrs();

  async function loadState(): Promise<Map<string, PoolInfo>> {
    const pools = await fetchPools(poolAddrs);
    const m = new Map<string, PoolInfo>();
    for (const p of pools) m.set(p.address, p);
    return m;
  }

  console.log("Fetching initial pool state...");
  let poolState = await loadState();

  const dsUsdcWsei = poolState.get(poolAddrs[0])!;
  const dsWseiWbtc = poolState.get(poolAddrs[1])!;
  const tokenRefs = {
    usdc: getBySymbol(dsUsdcWsei, "USDC"),
    wsei: getBySymbol(dsUsdcWsei, "WSEI"),
    wbtc: getBySymbol(dsWseiWbtc, "WBTC"),
  };

  let swapCount = 0;
  let lastBest = { pct: -Infinity, label: "", size: 0n };

  function onSwap(poolAddr: string, sqrtPriceX96: bigint, liquidity: bigint) {
    const pool = poolState.get(poolAddr);
    if (!pool) return;

    poolState.set(poolAddr, { ...pool, sqrtPriceX96, liquidity });
    swapCount++;

    const [p0, p1, p2, p3, p4] = poolAddrs.map(a => poolState.get(a)!);
    const routes = buildRoutes(p0, p1, p2, p3, p4, tokenRefs.usdc, tokenRefs.wsei, tokenRefs.wbtc);

    let best = { pct: -Infinity, label: "", size: 0n };
    for (const { label, hops } of routes) {
      const { optimalInput, maxProfit } = findOptimalInput(hops, tokenRefs.usdc.dec);
      if (maxProfit > best.pct) best = { pct: maxProfit, label, size: optimalInput };
      if (maxProfit >= MIN_PROFIT_USDC) {
        const msg = `size ${fmtAmt(optimalInput, tokenRefs.usdc.dec)} USDC → +${maxProfit.toFixed(4)} USDC | ${label}`;
        notify("Sei Arb OPPORTUNITY", msg).catch(console.error);
      }
    }
    lastBest = best;
  }

  setInterval(() => {
    const { pct, label, size } = lastBest;
    console.log(`[heartbeat] swaps=${swapCount}  best: ${pct >= 0 ? "+" : ""}${pct.toFixed(4)} USDC | size ${fmtAmt(size, tokenRefs.usdc.dec)} USDC | ${label}`);
  }, HEARTBEAT_INTERVAL_MS);

  function connect() {
    const ws = new WebSocket(SEI_WS);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_subscribe",
        params: ["logs", { address: poolAddrs, topics: [SWAP_TOPIC] }],
      }));
      console.log("[ws] connected, subscribed to Swap logs");
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.id === 1) return;
      if (msg.method !== "eth_subscription") return;
      const log = msg.params?.result;
      if (!log?.data || !log?.address) return;
      const { sqrtPriceX96, liquidity } = parseSwapLog(log.data);
      onSwap(log.address.toLowerCase(), sqrtPriceX96, liquidity);
    };

    ws.onerror = (err) => console.error("[ws] error:", err);

    ws.onclose = async () => {
      console.log("[ws] disconnected — reloading state and reconnecting in 2s...");
      await new Promise(r => setTimeout(r, 2000));
      poolState = await loadState();
      connect();
    };
  }

  connect();
  console.log(`Monitor started  min_profit=${MIN_PROFIT_USDC} USDC`);
}

monitor().catch(console.error);
