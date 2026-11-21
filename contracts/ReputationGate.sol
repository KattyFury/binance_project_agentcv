// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReputationHub {
    function meetsMinScore(address a, int256 minTotalMicro) external view returns (bool);
}

/// @title ReputationGate
/// @notice Sample integration: only agents whose Hub reputation reaches a threshold may enter.
///         Shows how another dApp can use the Hub score as access control. Holds no funds.
contract ReputationGate {
    IReputationHub public immutable hub;
    int256 public immutable minTotalMicro;
    mapping(address => bool) public entered;
    uint256 public enteredCount;

    event Entered(address indexed agent);

    constructor(address hub_, int256 minTotalMicro_) {
        hub = IReputationHub(hub_);
        minTotalMicro = minTotalMicro_;
    }

    function enter() external {
        require(!entered[msg.sender], "already entered");
        require(hub.meetsMinScore(msg.sender, minTotalMicro), "reputation too low");
        entered[msg.sender] = true;
        enteredCount++;
        emit Entered(msg.sender);
    }
}
