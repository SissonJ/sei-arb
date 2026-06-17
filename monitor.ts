import {
  buildAllPoolAddrs, buildRoutes, findOptimalInput, fetchPools,
  getBySymbol, fmtAmt,
} from "./lib";

const INTER_BATCH_DELAY_MS = 0;
const MIN_PROFIT_USDC = 1.0;
const HEARTBEAT_EVERY_N_BLOCKS = 50;

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

async function checkBlock(blockNum: number) {
  const pools = await fetchPools(buildAllPoolAddrs(), INTER_BATCH_DELAY_MS);
  const [dsUsdcWsei, dsWseiWbtc, dsWbtcUsdc, ssUsdcWsei1, ssUsdcWsei2] = pools;

  const usdc = getBySymbol(dsUsdcWsei, "USDC");
  const wsei = getBySymbol(dsUsdcWsei, "WSEI");
  const wbtc = getBySymbol(dsWseiWbtc, "WBTC");

  const routes = buildRoutes(
    dsUsdcWsei, dsWseiWbtc, dsWbtcUsdc, ssUsdcWsei1, ssUsdcWsei2,
    usdc, wsei, wbtc,
  );

  let bestPct = -Infinity;
  let bestLabel = "";
  let bestSize = 0n;

  for (const { label, hops } of routes) {
    // Quick probe with a small amount — skip the sizing work if unprofitable
    const probe = findOptimalInput(hops, usdc.dec);
    if (probe.maxProfit > bestPct) { bestPct = probe.maxProfit; bestLabel = label; bestSize = probe.optimalInput; }

    if (probe.maxProfit < MIN_PROFIT_USDC) continue;

    const msg = `size ${fmtAmt(probe.optimalInput, usdc.dec)} USDC → +${probe.maxProfit.toFixed(4)} USDC | ${label}`;
    await notify("Sei Arb OPPORTUNITY", msg);
  }

  return { bestPct, bestLabel, bestSize, usdcDec: usdc.dec };
}

function connect(onBlock: (blockNum: number) => void): WebSocket {
  const ws = new WebSocket(SEI_WS);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_subscribe",
      params: ["newHeads"],
    }));
    console.log(`[ws] connected, subscribed to newHeads`);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string);
    // Subscription confirmation — ignore
    if (msg.id === 1) return;
    // New block notification
    if (msg.method === "eth_subscription" && msg.params?.result?.number) {
      const blockNum = parseInt(msg.params.result.number, 16);
      onBlock(blockNum);
    }
  };

  ws.onerror = (err) => {
    console.error("[ws] error:", err);
  };

  return ws;
}

async function monitor() {
  let processing = false;
  let blockCount = 0;

  const onBlock = async (blockNum: number) => {
    blockCount++;

    if (processing) return;
    processing = true;
    const t0 = Date.now();

    try {
      const { bestPct, bestLabel, bestSize, usdcDec } = await checkBlock(blockNum);
      const elapsed = Date.now() - t0;

      if (blockCount % HEARTBEAT_EVERY_N_BLOCKS === 0) {
        console.log(`[${blockNum}] heartbeat — best route: ${bestPct >= 0 ? "+" : ""}${bestPct.toFixed(4)} USDC | size ${fmtAmt(bestSize, usdcDec)} USDC | ${bestLabel} (${elapsed}ms)`);
      }
    } catch (err) {
      console.error(`[${blockNum}] error (${Date.now() - t0}ms):`, err);
    } finally {
      processing = false;
    }
  };

  // Connect with auto-reconnect on close
  function startWs() {
    const ws = connect(onBlock);
    ws.onclose = () => {
      console.log("[ws] disconnected — reconnecting in 2s...");
      setTimeout(startWs, 2000);
    };
  }

  startWs();
  console.log(`Monitor started  min_profit=${MIN_PROFIT_USDC} USDC  batch_delay=${INTER_BATCH_DELAY_MS}ms`);
}

monitor().catch(console.error);
