import {
  buildAllPoolAddrs, buildRoutes, findOptimalInput, fetchPools,
  getBySymbol, fmtAmt, POOLS,
} from "./lib";
import type { PoolInfo } from "./lib";
import { createExecutor, FLASH_FEE } from "./executor";

const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const MIN_PROFIT_USDC = 1.0;
const HEARTBEAT_INTERVAL_MS = 30_000;

const SEI_WS = Bun.env.SEI_WS!;
const PUSHOVER_TOKEN = Bun.env.PUSHOVER_TOKEN!;
const PUSHOVER_USER = Bun.env.PUSHOVER_USER!;
// Optional: without ARB_CONTRACT the monitor only reports opportunities
const ARB_CONTRACT = Bun.env.ARB_CONTRACT;
const ARB_PRIVATE_KEY = Bun.env.ARB_PRIVATE_KEY;
const ARB_SEND = Bun.env.ARB_SEND === "1";

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

  const usdc = getBySymbol(poolState.get(POOLS.DS_USDC_WSEI)!, "USDC");
  const routeCount = buildRoutes([...poolState.values()], usdc.addr).length;

  const tryExecute = ARB_CONTRACT
    ? await createExecutor({
        rpc: Bun.env.SEI_RPC!,
        contract: ARB_CONTRACT,
        privateKey: ARB_PRIVATE_KEY!,
        token: usdc,
        minProfit: BigInt(Math.round(MIN_PROFIT_USDC * 10 ** usdc.dec)),
        send: ARB_SEND,
        notify: (title, message) => { notify(title, message).catch(console.error); },
      })
    : undefined;

  let swapCount = 0;
  let lastBest = { pct: -Infinity, label: "", size: 0n };

  function onSwap(poolAddr: string, sqrtPriceX96: bigint, liquidity: bigint) {
    const pool = poolState.get(poolAddr);
    if (!pool) return;

    poolState.set(poolAddr, { ...pool, sqrtPriceX96, liquidity });
    swapCount++;

    // Rebuild the routes, because each swap replaces the pool object with a new one
    const routes = buildRoutes([...poolState.values()], usdc.addr);

    let best = { pct: -Infinity, label: "", size: 0n };
    let bestHops = routes[0]!.hops;
    for (const { label, hops } of routes) {
      const { optimalInput, maxProfit } = findOptimalInput(hops, usdc.dec);
      const netProfit = maxProfit - (Number(optimalInput) / 10 ** usdc.dec) * FLASH_FEE;
      if (netProfit > best.pct) {
        best = { pct: netProfit, label, size: optimalInput };
        bestHops = hops;
      }
      if (netProfit >= MIN_PROFIT_USDC) {
        const msg = `size ${fmtAmt(optimalInput, usdc.dec)} USDC → +${netProfit.toFixed(4)} USDC | ${label}`;
        notify("Sei Arb OPPORTUNITY", msg).catch(console.error);
      }
    }
    lastBest = best;

    if (tryExecute && best.pct >= MIN_PROFIT_USDC) {
      tryExecute(best.label, bestHops, best.size);
    }
  }

  setInterval(() => {
    const { pct, label, size } = lastBest;
    console.log(`[heartbeat] swaps=${swapCount}  best: ${pct >= 0 ? "+" : ""}${pct.toFixed(4)} USDC | size ${fmtAmt(size, usdc.dec)} USDC | ${label}`);
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
  console.log(`Monitor started  pools=${poolAddrs.length} routes=${routeCount}  min_profit=${MIN_PROFIT_USDC} USDC  executor=${tryExecute ? "on" : "off"}`);
}

monitor().catch(console.error);
