// One-off: sell 50 USDC for native SEI on DragonSwap and send the SEI to a new address.
// PRV_SOURCE pays the USDC and the gas. The SEI goes to the address of PRV_SEED.
// Each one can be a private key or a mnemonic (first account, path m/44'/60'/0'/0/0).
// Run: bun --env-file=.env --env-file=.env_seed seed.ts
import { Contract, Interface, JsonRpcProvider, formatEther, formatUnits, parseUnits } from "ethers";
import { POOLS, Q96, loadWallet } from "./lib";

const SEI_MAINNET_CHAIN_ID = 1329n;
const USDC = "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392";
const WSEI = "0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7";
// DragonSwap V2 SwapRouter02. On chain: factory() is the factory of the USDC/WSEI pool, and WSEI() is WSEI.
const ROUTER = "0x11DA6463D6Cb5a03411Dbf5ab6f6bc3997Ac7428";
const AMOUNT_IN = parseUnits("50", 6);
const SLIPPAGE_BPS = 200n;

const SEI_RPC = Bun.env.SEI_RPC!;
const PRV_SOURCE = Bun.env.PRV_SOURCE;
const PRV_SEED = Bun.env.PRV_SEED;
if (!PRV_SOURCE || !PRV_SEED) throw new Error("Set PRV_SOURCE and PRV_SEED (run with --env-file=.env --env-file=.env_seed)");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function unwrapWSEI(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
];

const provider = new JsonRpcProvider(SEI_RPC);
const { chainId } = await provider.getNetwork();
if (chainId !== SEI_MAINNET_CHAIN_ID) {
  throw new Error(`SEI_RPC is on chain ${chainId}, expected Sei mainnet (${SEI_MAINNET_CHAIN_ID})`);
}

const source = loadWallet(PRV_SOURCE).connect(provider);
const seed = loadWallet(PRV_SEED).address;
const usdc = new Contract(USDC, ERC20_ABI, source);
const pool = new Contract(POOLS.DS_USDC_WSEI, POOL_ABI, provider);
const router = new Contract(ROUTER, ROUTER_ABI, source);

const balance: bigint = await usdc.getFunction("balanceOf")(source.address);
if (balance < AMOUNT_IN) throw new Error(`Source has ${formatUnits(balance, 6)} USDC, needs ${formatUnits(AMOUNT_IN, 6)}`);

// The pool has USDC as token0, so the spot price in raw WSEI per raw USDC is (sqrtPriceX96 / 2^96)^2
if ((await pool.getFunction("token0")()).toLowerCase() !== USDC.toLowerCase()) throw new Error("Pool token0 is not USDC");
const [[sqrtPriceX96], fee] = await Promise.all([pool.getFunction("slot0")(), pool.getFunction("fee")()]);
const spotOut = (AMOUNT_IN * sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);
const minOut = (spotOut * (1_000_000n - fee) / 1_000_000n) * (10_000n - SLIPPAGE_BPS) / 10_000n;

console.log(`source ${source.address}`);
console.log(`seed   ${seed}`);
console.log(`sell   ${formatUnits(AMOUNT_IN, 6)} USDC, expect ~${formatEther(spotOut)} SEI, min ${formatEther(minOut)} SEI`);

// Track the nonce here, because a node behind a load balancer can return a stale pending nonce after a wait
let nonce = await provider.getTransactionCount(source.address, "pending");
const allowance: bigint = await usdc.getFunction("allowance")(source.address, ROUTER);
if (allowance < AMOUNT_IN) {
  const tx = await usdc.getFunction("approve")(ROUTER, AMOUNT_IN, { nonce: nonce++ });
  console.log(`approve ${tx.hash}`);
  await tx.wait();
}

// The router keeps the WSEI from the swap, then unwraps it and sends native SEI to the seed address
const iface = new Interface(ROUTER_ABI);
const calls = [
  iface.encodeFunctionData("exactInputSingle", [[USDC, WSEI, fee, ROUTER, AMOUNT_IN, minOut, 0n]]),
  iface.encodeFunctionData("unwrapWSEI", [minOut, seed]),
];
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

// Simulate first, so a bad route fails here and not on chain
await router.getFunction("multicall").staticCall(deadline, calls);
const tx = await router.getFunction("multicall")(deadline, calls, { nonce });
console.log(`swap   ${tx.hash}`);
const receipt = await tx.wait();
if (!receipt) throw new Error("No receipt");
// Read at the receipt block, because "latest" can lag behind it on some nodes
const seedBalance = await provider.getBalance(seed, receipt.blockNumber);
console.log(`done   block ${receipt.blockNumber}, seed balance ${formatEther(seedBalance)} SEI`);
