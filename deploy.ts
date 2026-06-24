/**
 * Deploy AtomicArb to SEI.
 *
 * Required env vars:
 *   SEI_RPC      — RPC endpoint (already used by lib.ts)
 *   PRIVATE_KEY  — deployer private key (hex, 0x-prefixed or raw)
 *
 * Usage:
 *   bun deploy.ts
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";

const SEI_RPC = process.env.SEI_RPC ?? "https://misty-chaotic-energy.sei-pacific.quiknode.pro/ee4fe2a7c05a4f87ed6048a930fa4292c820de9b/";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env var required");

const artifactPath = join(import.meta.dir, "contracts/out/AtomicArb.sol/AtomicArb.json");
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

const provider = new ethers.JsonRpcProvider(SEI_RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
const contract = await factory.deploy();
await contract.waitForDeployment();

const address = await contract.getAddress();
console.log(`AtomicArb deployed at: ${address}`);
console.log(`Add to .env:  ARB_CONTRACT_ADDRESS=${address}`);
