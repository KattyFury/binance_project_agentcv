// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// Test double for the Binance Agent ID ERC-721 (non-transferable in production).
contract MockAgentId is ERC721 {
    uint256 public next = 1;
    constructor() ERC721("SPACE ID Agent ID", "AI") {}
    function mint(address to) external { _mint(to, next++); }
}
