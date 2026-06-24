// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AtomicArb.sol";

// ─── Minimal mock tokens ────────────────────────────────────────────────────

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    string public symbol;

    constructor(string memory _symbol) { symbol = _symbol; }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// ─── Mock V3 Pool ────────────────────────────────────────────────────────────
//
// Models a "profitable" swap: for every 1000 units of token0 in, gives 1050 of token1 out
// (or vice versa). The flash loan hands the arb contract the borrow amount, then the
// contract executes swaps and repays. We rig the mock so the route generates a net gain.

contract MockV3Pool {
    address public token0;
    address public token1;
    uint24  public constant fee = 500; // 0.05 %

    // multiplier_bps: output = input * multiplier_bps / 10000
    uint256 public multiplierBps;

    constructor(address _t0, address _t1, uint256 _multiplierBps) {
        token0 = _t0;
        token1 = _t1;
        multiplierBps = _multiplierBps;
    }

    // Flash loan: transfer tokens to recipient, then call flash callback
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external {
        if (amount0 > 0) MockERC20(token0).transfer(recipient, amount0);
        if (amount1 > 0) MockERC20(token1).transfer(recipient, amount1);

        // fee = 0.05% of borrowed amount (pool fee tier)
        uint256 fee0 = (amount0 * 5) / 10000;
        uint256 fee1 = (amount1 * 5) / 10000;
        IAtomicArbFlashCallback(recipient).uniswapV3FlashCallback(fee0, fee1, data);
    }

    // Swap: transfer amountOut to recipient, then call swap callback for amountIn
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160, /* sqrtPriceLimitX96 */
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1) {
        uint256 amountIn = uint256(amountSpecified);
        uint256 amountOut = (amountIn * multiplierBps) / 10000;

        if (zeroForOne) {
            // sell token0, receive token1
            MockERC20(token1).transfer(recipient, amountOut);
            amount0 = int256(amountIn);   // positive: owed to pool
            amount1 = -int256(amountOut); // negative: sent to recipient
        } else {
            // sell token1, receive token0
            MockERC20(token0).transfer(recipient, amountOut);
            amount0 = -int256(amountOut);
            amount1 = int256(amountIn);
        }

        IAtomicArbSwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

interface IAtomicArbFlashCallback {
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external;
}

interface IAtomicArbSwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

contract AtomicArbTest is Test {
    AtomicArb arb;

    MockERC20   usdc;
    MockERC20   wsei;
    MockV3Pool  pool1; // USDC → WSEI at 1:1.1 (10% profit simulation)
    MockV3Pool  pool2; // WSEI → USDC at 1:1   (neutral, so round-trip is +10%)

    function setUp() public {
        arb  = new AtomicArb();
        usdc = new MockERC20("USDC");
        wsei = new MockERC20("WSEI");

        // pool1: USDC(t0) → WSEI(t1), 1 USDC → 1.1 WSEI (multiplier 11000/10000)
        pool1 = new MockV3Pool(address(usdc), address(wsei), 11000);
        // pool2: WSEI(t0) → USDC(t1), 1 WSEI → 1 USDC   (multiplier 10000/10000)
        pool2 = new MockV3Pool(address(wsei), address(usdc), 10000);

        // Seed pools with enough tokens to fulfill swaps and the flash loan
        usdc.mint(address(pool1), 1_000_000e6);
        wsei.mint(address(pool1), 1_000_000e18);
        usdc.mint(address(pool2), 1_000_000e6);
        wsei.mint(address(pool2), 1_000_000e18);
    }

    // ── Happy path: 2-hop profitable round-trip ──────────────────────────────

    function test_profitableArb() public {
        uint256 borrowAmount = 1000e6; // 1000 USDC
        // After round-trip: 1000 USDC → 1100 WSEI → 1100 USDC (100 profit, minus flash fee)

        AtomicArb.SwapStep[] memory route = new AtomicArb.SwapStep[](2);
        route[0] = AtomicArb.SwapStep({
            pool: address(pool1),
            zeroForOne: true,   // USDC → WSEI
            tokenIn: address(usdc)
        });
        route[1] = AtomicArb.SwapStep({
            pool: address(pool2),
            zeroForOne: true,   // sell token0 (WSEI) → receive token1 (USDC)
            tokenIn: address(wsei)
        });

        uint256 minProfit = 50e6; // expect at least 50 USDC profit

        // pool1 is the flash pool (lending USDC)
        arb.executeArb(address(pool1), address(usdc), borrowAmount, route, minProfit);

        // Contract should hold the profit
        uint256 contractBalance = usdc.balanceOf(address(arb));
        assertGt(contractBalance, minProfit, "Should have collected profit");
    }

    // ── Revert when profit is below minimum ──────────────────────────────────

    function test_revertWhenUnprofitable() public {
        uint256 borrowAmount = 1000e6;

        AtomicArb.SwapStep[] memory route = new AtomicArb.SwapStep[](2);
        route[0] = AtomicArb.SwapStep({
            pool: address(pool1),
            zeroForOne: true,
            tokenIn: address(usdc)
        });
        route[1] = AtomicArb.SwapStep({
            pool: address(pool2),
            zeroForOne: true,   // sell token0 (WSEI) → receive token1 (USDC)
            tokenIn: address(wsei)
        });

        // Demand more profit than the route can deliver → must revert
        uint256 impossibleMinProfit = 500e6;

        vm.expectRevert("Insufficient profit");
        arb.executeArb(address(pool1), address(usdc), borrowAmount, route, impossibleMinProfit);
    }

    // ── Only owner can execute ────────────────────────────────────────────────

    function test_revertWhenNotOwner() public {
        AtomicArb.SwapStep[] memory route = new AtomicArb.SwapStep[](0);

        vm.prank(address(0xBEEF));
        vm.expectRevert("Not owner");
        arb.executeArb(address(pool1), address(usdc), 1000e6, route, 0);
    }

    // ── Unauthorized flash callback ───────────────────────────────────────────

    function test_revertOnUnauthorizedFlash() public {
        bytes memory data = abi.encode(
            address(0xDEAD), address(usdc),
            new AtomicArb.SwapStep[](0),
            uint256(0), uint256(0)
        );
        vm.expectRevert("Unauthorized flash");
        // call flash callback directly from a non-pool address
        arb.uniswapV3FlashCallback(0, 0, data);
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    function test_ownerCanWithdraw() public {
        usdc.mint(address(arb), 100e6);
        uint256 ownerBefore = usdc.balanceOf(address(this));
        arb.withdraw(address(usdc), 100e6);
        assertEq(usdc.balanceOf(address(this)), ownerBefore + 100e6);
    }

    function test_revertWithdrawNotOwner() public {
        usdc.mint(address(arb), 100e6);
        vm.prank(address(0xBEEF));
        vm.expectRevert("Not owner");
        arb.withdraw(address(usdc), 100e6);
    }
}
