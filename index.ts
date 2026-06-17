import {
  buildAllPoolAddrs, buildRoutes, fetchPools, getBySymbol,
  printRoute, spotPrice, dexLabel, findOptimalInput, fmtAmt, POOLS,
} from "./lib";

async function checkArbitrage() {
  console.log("Arbitrage Checker — Sei Network (DragonSwap + SailorSwap)\n");

  const pools = await fetchPools(buildAllPoolAddrs());
  const [dsUsdcWsei, dsWseiWbtc, dsWbtcUsdc, ssUsdcWsei1, ssUsdcWsei2] = pools;

  console.log("\nPool State:");
  console.log("─".repeat(72));
  for (const p of pools) {
    console.log(`[${dexLabel(p.address)}] ${p.address}`);
    console.log(`  Pair: ${p.symbol0}/${p.symbol1}  Fee: ${Number(p.fee) / 10_000}%  Liq: ${p.liquidity}`);
    console.log(`  Spot: ${spotPrice(p)}`);
  }
  console.log("─".repeat(72));

  const usdc = getBySymbol(dsUsdcWsei, "USDC");
  const wsei = getBySymbol(dsUsdcWsei, "WSEI");
  const wbtc = getBySymbol(dsWseiWbtc, "WBTC");

  const routes = buildRoutes(dsUsdcWsei, dsWseiWbtc, dsWbtcUsdc, ssUsdcWsei1, ssUsdcWsei2, usdc, wsei, wbtc);
  console.log();
  for (const { label, hops } of routes) {
    const { optimalInput, maxProfit } = findOptimalInput(hops, usdc.dec);
    console.log(`Optimal input: ${fmtAmt(optimalInput, usdc.dec)} USDC → +${maxProfit.toFixed(4)} USDC profit | ${label}`);
    printRoute(label, hops, optimalInput, usdc.dec, "USDC");
  }

  console.log("\n" + "─".repeat(72));
}

checkArbitrage().catch(console.error);
