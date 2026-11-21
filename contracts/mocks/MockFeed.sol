// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test double for a Chainlink AggregatorV3 price feed.
contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;
    function set(int256 a, uint256 u) external { answer = a; updatedAt = u; }
    function setBroken(bool b) external { broken = b; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
