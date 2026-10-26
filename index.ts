import {
  buildAllPoolAddrs, buildRoutes, fetchPools, getBySymbol,
  printRoute, spotPrice, poolLabel, findOptimalInput, fmtAmt, POOLS,
} from "./lib";

async function checkArbitrage() {
  console.log("Arbitrage Checker — Sei Network (DragonSwap)\n");

  const pools = await fetchPools(buildAllPoolAddrs());

  console.log("\nPool State:");
  console.log("─".repeat(72));
  for (const p of pools) {
    console.log(`[${poolLabel(p)}] ${p.address}`);
    console.log(`  Liq: ${p.liquidity}`);
    console.log(`  Spot: ${spotPrice(p)}`);
  }
  console.log("─".repeat(72));

  const usdc = getBySymbol(pools.find((p) => p.address === POOLS.DS_USDC_WSEI)!, "USDC");
  const routes = buildRoutes(pools, usdc.addr);
  console.log();
  for (const { label, hops } of routes) {
    const { optimalInput, maxProfit } = findOptimalInput(hops, usdc.dec);
    console.log(`Optimal input: ${fmtAmt(optimalInput, usdc.dec)} USDC → +${maxProfit.toFixed(4)} USDC profit | ${label}`);
    printRoute(label, hops, optimalInput, usdc.dec, "USDC");
  }

  console.log("\n" + "─".repeat(72));
}

checkArbitrage().catch(console.error);
