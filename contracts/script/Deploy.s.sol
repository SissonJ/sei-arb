// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AtomicArb.sol";

contract DeployAtomicArb is Script {
    function run() external {
        vm.startBroadcast();
        AtomicArb arb = new AtomicArb();
        console.log("AtomicArb deployed at:", address(arb));
        console.log("Owner:", arb.owner());
        vm.stopBroadcast();
    }
}
