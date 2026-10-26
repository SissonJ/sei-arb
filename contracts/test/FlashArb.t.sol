// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FlashArb, IERC20, IV3Pool} from "../FlashArb.sol";

// Moves the price of a DragonSwap pool, so that the test has an arbitrage to take.
contract PriceMover {
    function sell(address pool, address tokenIn, bool zeroForOne, uint256 amount) external {
        IV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amount),
            zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341,
            abi.encode(tokenIn)
        );
    }

    function dragonswapV2SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        IERC20(abi.decode(data, (address))).transfer(msg.sender, uint256(amount0Delta > 0 ? amount0Delta : amount1Delta));
    }
}

/// Run with: SEI_MAINNET_RPC=https://evm-rpc.sei-apis.com forge test
contract FlashArbTest is Test {
    address constant USDC = 0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392;
    address constant WSEI = 0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7;
    address constant WBTC = 0x0555E30da8f98308EdB960aa94C0Db47230d2B9c;

    address constant DS_USDC_WSEI = 0xcca2352200a63eb0Aaba2D40BA69b1d32174F285; // token0 USDC, token1 WSEI
    address constant DS_WBTC_WSEI = 0x3E00Dd875fEf6cE2209007c1e625d9A656E32556; // token0 WBTC, token1 WSEI
    address constant DS_WBTC_USDC = 0xe62fD4661C85e126744cC335E9bca8Ae3D5d19D1; // token0 WBTC, token1 USDC
    address constant FLASH_POOL = 0xf62BD525E82577a162DE88bD70dE032a62675237; // DS USDT0/USDC 0.01%

    uint256 constant AMOUNT = 1_000e6;

    FlashArb arb;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("sei"));
        arb = new FlashArb();
    }

    function test_executesArbitrageAndRepaysLoan() public {
        // Sell WSEI into the USDC/WSEI pool, so WSEI is cheaper there than in the WBTC pools.
        PriceMover mover = new PriceMover();
        uint256 dumpAmount = IERC20(WSEI).balanceOf(DS_USDC_WSEI) / 50;
        deal(WSEI, address(mover), dumpAmount);
        mover.sell(DS_USDC_WSEI, WSEI, false, dumpAmount);

        FlashArb.Hop[] memory hops = new FlashArb.Hop[](3);
        hops[0] = FlashArb.Hop(DS_USDC_WSEI, true); // USDC -> WSEI
        hops[1] = FlashArb.Hop(DS_WBTC_WSEI, false); // WSEI -> WBTC
        hops[2] = FlashArb.Hop(DS_WBTC_USDC, true); // WBTC -> USDC

        uint256 flashPoolBefore = IERC20(USDC).balanceOf(FLASH_POOL);
        uint256 profit = arb.execute(FLASH_POOL, USDC, AMOUNT, hops, 1e6);

        assertGe(profit, 1e6);
        assertEq(IERC20(USDC).balanceOf(address(this)), profit);
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0);
        assertEq(IERC20(WSEI).balanceOf(address(arb)), 0);
        assertEq(IERC20(WBTC).balanceOf(address(arb)), 0);
        // The pool fee is 0.01% of the loan.
        assertEq(IERC20(USDC).balanceOf(FLASH_POOL), flashPoolBefore + AMOUNT / 10_000);
    }

    function test_revertsWhenRouteIsNotProfitable() public {
        FlashArb.Hop[] memory hops = new FlashArb.Hop[](3);
        hops[0] = FlashArb.Hop(DS_USDC_WSEI, true); // USDC -> WSEI
        hops[1] = FlashArb.Hop(DS_WBTC_WSEI, false); // WSEI -> WBTC
        hops[2] = FlashArb.Hop(DS_WBTC_USDC, true); // WBTC -> USDC

        // A full cycle at market prices loses the swap fees, so no minProfit can pass.
        vm.expectPartialRevert(FlashArb.Unprofitable.selector);
        arb.execute(FLASH_POOL, USDC, AMOUNT, hops, 0);
    }

    function test_rejectsCallsFromUnexpectedAddresses() public {
        FlashArb.Hop[] memory hops = new FlashArb.Hop[](0);
        vm.prank(address(0xBEEF));
        vm.expectRevert(FlashArb.NotOwner.selector);
        arb.execute(FLASH_POOL, USDC, AMOUNT, hops, 0);

        // A direct callback must not pull tokens out of the contract.
        deal(USDC, address(arb), AMOUNT);
        vm.prank(DS_USDC_WSEI);
        vm.expectRevert(FlashArb.UnexpectedCaller.selector);
        arb.dragonswapV2SwapCallback(int256(AMOUNT), 0, "");
    }
}
