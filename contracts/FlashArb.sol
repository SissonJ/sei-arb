// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

/// @notice Borrows a token with a V3 pool flash loan, swaps it through a cycle of V3 pools,
/// repays the loan, and sends the profit to the owner. The transaction reverts if the cycle
/// does not return at least the loan, the loan fee, and minProfit.
/// @dev Supports the Uniswap V3 callback names (SailorSwap) and the dragonswapV2 callback names (DragonSwap).
/// The flash pool must not be one of the hop pools, because the flash locks that pool.
contract FlashArb {
    struct Hop {
        address pool;
        bool zeroForOne; // true when the hop sells token0 of the pool for token1
    }

    // TickMath.MIN_SQRT_RATIO + 1 and TickMath.MAX_SQRT_RATIO - 1: no price limit on a hop.
    // The profit check at the end of the cycle is the only slippage protection.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341;

    address public immutable owner;

    // The only address that can call a callback at this step of execute. Each callback clears it,
    // so each pool can call back one time per step, and no address can call back outside execute.
    address transient expectedCaller;

    error NotOwner();
    error UnexpectedCaller();
    error Unprofitable(uint256 balance, uint256 required);
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    /// @param flashPool A V3 pool that holds `token` and is not on the route.
    /// @param token The token to borrow. The route must start and end with this token.
    /// @param amount The amount to borrow and send into the first hop.
    /// @param hops The pools to swap through, in order.
    /// @param minProfit The minimum amount of `token` to keep after the loan and fee are repaid.
    /// @return profit The amount of `token` sent to the owner.
    function execute(address flashPool, address token, uint256 amount, Hop[] calldata hops, uint256 minProfit)
        external
        returns (uint256 profit)
    {
        if (msg.sender != owner) revert NotOwner();

        bool borrowToken0 = IV3Pool(flashPool).token0() == token;
        expectedCaller = flashPool;
        IV3Pool(flashPool).flash(
            address(this),
            borrowToken0 ? amount : 0,
            borrowToken0 ? 0 : amount,
            abi.encode(token, amount, hops, minProfit)
        );

        profit = IERC20(token).balanceOf(address(this));
        _transfer(token, owner, profit);
    }

    /// @notice Sends the full balance of `token` to the owner.
    function withdraw(address token) external {
        if (msg.sender != owner) revert NotOwner();
        _transfer(token, owner, IERC20(token).balanceOf(address(this)));
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _onFlash(fee0 + fee1, data);
    }

    function dragonswapV2FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _onFlash(fee0 + fee1, data);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _onSwap(amount0Delta, amount1Delta);
    }

    function dragonswapV2SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _onSwap(amount0Delta, amount1Delta);
    }

    function _onFlash(uint256 fee, bytes calldata data) internal {
        _checkCaller();
        (address token, uint256 amount, Hop[] memory hops, uint256 minProfit) =
            abi.decode(data, (address, uint256, Hop[], uint256));

        // The balance includes the borrowed amount, so this is the loan + fee + minProfit.
        uint256 required = IERC20(token).balanceOf(address(this)) + fee + minProfit;

        uint256 amountIn = amount;
        for (uint256 i; i < hops.length; ++i) {
            Hop memory hop = hops[i];
            expectedCaller = hop.pool;
            (int256 amount0, int256 amount1) = IV3Pool(hop.pool).swap(
                address(this),
                hop.zeroForOne,
                int256(amountIn),
                hop.zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT,
                ""
            );
            // The pool reports the output as a negative delta.
            amountIn = uint256(-(hop.zeroForOne ? amount1 : amount0));
        }

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < required) revert Unprofitable(balance, required);

        _transfer(token, msg.sender, amount + fee);
    }

    function _onSwap(int256 amount0Delta, int256 amount1Delta) internal {
        _checkCaller();
        // A positive delta is the amount that this contract owes to the pool.
        if (amount0Delta > 0) {
            _transfer(IV3Pool(msg.sender).token0(), msg.sender, uint256(amount0Delta));
        } else {
            _transfer(IV3Pool(msg.sender).token1(), msg.sender, uint256(amount1Delta));
        }
    }

    function _checkCaller() internal {
        if (msg.sender != expectedCaller) revert UnexpectedCaller();
        expectedCaller = address(0);
    }

    // Accepts tokens that return no value from transfer.
    function _transfer(address token, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, value)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
