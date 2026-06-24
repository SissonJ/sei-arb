// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

function safeTransfer(address token, address to, uint256 amount) {
    (bool ok, bytes memory data) = token.call(
        abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
    );
    require(ok && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
}

interface IUniswapV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;

    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Executes atomic multi-hop arbitrage on Uniswap V3-compatible DEXes (DragonSwap / SailorSwap on SEI).
/// Flash-borrows the input token from a pool, executes the route, repays, and keeps the profit.
/// Reverts entirely if profit < minProfit, making every call risk-free.
contract AtomicArb {
    // Uniswap V3 sqrt price bounds — used to set no price limit on swaps
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address public immutable owner;

    struct SwapStep {
        address pool;       // V3 pool address
        bool zeroForOne;    // true → sell token0, receive token1
        address tokenIn;    // token being sold into this pool
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Execute an atomic arb. Call this after the TypeScript bot identifies a profitable route.
    /// @param flashPool     Pool to borrow from via flash loan (pick highest flashToken liquidity)
    /// @param flashToken    Token to borrow (USDC — the route's input/output token)
    /// @param borrowAmount  Amount to borrow; should match the optimal input from findOptimalInput()
    /// @param route         Ordered swap steps; must form a closed loop returning flashToken
    /// @param minProfit     Minimum acceptable profit in flashToken units; reverts if not met
    function executeArb(
        address flashPool,
        address flashToken,
        uint256 borrowAmount,
        SwapStep[] calldata route,
        uint256 minProfit
    ) external onlyOwner {
        bool isToken0 = IUniswapV3Pool(flashPool).token0() == flashToken;
        bytes memory data = abi.encode(flashPool, flashToken, route, borrowAmount, minProfit);
        IUniswapV3Pool(flashPool).flash(
            address(this),
            isToken0 ? borrowAmount : 0,
            isToken0 ? 0 : borrowAmount,
            data
        );
    }

    /// @dev Called by the flash pool after transferring borrowed tokens to this contract.
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        (
            address flashPool,
            address flashToken,
            SwapStep[] memory route,
            uint256 borrowAmount,
            uint256 minProfit
        ) = abi.decode(data, (address, address, SwapStep[], uint256, uint256));

        require(msg.sender == flashPool, "Unauthorized flash");

        // Execute every hop in the route
        uint256 amountIn = borrowAmount;
        for (uint256 i = 0; i < route.length; i++) {
            amountIn = _swap(route[i], amountIn);
        }

        // Determine the flash fee for the borrowed token
        bool isToken0 = IUniswapV3Pool(flashPool).token0() == flashToken;
        uint256 flashFee = isToken0 ? fee0 : fee1;
        uint256 repayAmount = borrowAmount + flashFee;

        uint256 balance = IERC20(flashToken).balanceOf(address(this));
        require(balance >= repayAmount + minProfit, "Insufficient profit");

        safeTransfer(flashToken, flashPool, repayAmount);
        // remaining balance is profit; stays in contract until owner withdraws
    }

    /// @dev Called by each V3 pool mid-swap to collect the input token owed.
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        (address pool, address tokenIn) = abi.decode(data, (address, address));
        require(msg.sender == pool, "Unauthorized swap");

        // Exactly one delta is positive (what we owe the pool); the other is zero or negative
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 amountOwed = amount0Delta > 0
            ? uint256(amount0Delta)
            : uint256(amount1Delta);

        safeTransfer(tokenIn, msg.sender, amountOwed);
    }

    /// @notice Rescue tokens or collected profit.
    function withdraw(address token, uint256 amount) external onlyOwner {
        safeTransfer(token, owner, amount);
    }

    receive() external payable {}

    // ─── Internal ───────────────────────────────────────────────────────────────

    function _swap(SwapStep memory step, uint256 amountIn)
        internal
        returns (uint256 amountOut)
    {
        require(amountIn <= uint256(type(int256).max), "amountIn overflow");
        bytes memory cbData = abi.encode(step.pool, step.tokenIn);
        (int256 amount0, int256 amount1) = IUniswapV3Pool(step.pool).swap(
            address(this),
            step.zeroForOne,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(amountIn),
            // no price limit — accept any price (we rely on the profit check to protect us)
            step.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            cbData
        );
        // output delta is always negative (pool paid us); negate to get positive amount
        // forge-lint: disable-next-line(unsafe-typecast)
        amountOut = step.zeroForOne ? uint256(-amount1) : uint256(-amount0);
    }
}
