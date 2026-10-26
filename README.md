# sei-test

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Arbitrage execution

`monitor.ts` finds opportunities. If `ARB_CONTRACT` is set, it sends the best route to `contracts/FlashArb.sol`.
The contract borrows USDC with a flash loan, swaps through the route, and repays the loan in one transaction.
The transaction reverts if the profit is less than `MIN_PROFIT_USDC`.

Deploy the contract to Sei mainnet. The deployer wallet becomes the owner and receives the profit:

```bash
forge create contracts/FlashArb.sol:FlashArb --rpc-url https://evm-rpc.sei-apis.com --private-key $ARB_PRIVATE_KEY --broadcast
```

Add these variables to `.env`:

```bash
SEI_RPC=...            # must be Sei mainnet (chain 1329)
ARB_CONTRACT=0x...     # the deployed FlashArb address
ARB_PRIVATE_KEY=0x...  # the owner wallet (a private key or a quoted mnemonic); it needs SEI for gas
ARB_SEND=1             # omit to simulate only
```

Before each send, the executor simulates the route with `eth_call` at several sizes and sends the most profitable size.

Run the contract tests on a fork of Sei mainnet:

```bash
SEI_MAINNET_RPC=https://evm-rpc.sei-apis.com forge test
```
