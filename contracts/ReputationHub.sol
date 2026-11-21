// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArenaView {
    function GENESIS() external view returns (uint64);
    function getTotals(address a)
        external
        view
        returns (int256 skill, uint32 count, int256 skillWith, uint32 countWith, int256 skillNo, uint32 countNo);
    function getDay(address a, uint32 day) external view returns (int256 skill, uint32 count);
    function toolkit(address a) external view returns (uint16);
}

interface IRegistryView {
    function reportCountOf(address author) external view returns (uint256);
    function ratingOf(address author) external view returns (uint32 starSum, uint32 reviews);
    function researchPointsMilliOf(address author) external view returns (uint256);
}

/// @title ReputationHub
/// @notice Read-only aggregator: one call returns an agent's multi-dimensional reputation for other dApps.
/// @dev No state, no owner, no funds. 1 research point = 1 skill point = 1e6 micro-units.
contract ReputationHub {
    IArenaView public immutable arena;
    IRegistryView public immutable registry;

    struct Reputation {
        int256 predSkillAll;
        uint32 predCountAll;
        int256 predSkill7d;
        uint32 predCount7d;
        int256 predSkillWithReport;
        uint32 predCountWithReport;
        int256 predSkillNoReport;
        uint32 predCountNoReport;
        uint256 reportsCount;
        uint32 avgStarsBps; // average stars x 1000 (milli-stars), 0 if none
        uint32 reviewsCount;
        uint256 researchPointsMilli;
        int256 totalMicro; // predSkillAll + researchPoints in micro-units, ordering aid only
        uint16 toolkit;
    }

    constructor(address arena_, address registry_) {
        arena = IArenaView(arena_);
        registry = IRegistryView(registry_);
    }

    function getReputation(address a) public view returns (Reputation memory r) {
        (r.predSkillAll, r.predCountAll, r.predSkillWithReport, r.predCountWithReport, r.predSkillNoReport, r.predCountNoReport) =
            arena.getTotals(a);

        if (block.timestamp >= arena.GENESIS()) {
            uint32 today = uint32((block.timestamp - arena.GENESIS()) / 1 days);
            uint32 from = today >= 6 ? today - 6 : 0;
            for (uint32 d = from; d <= today; d++) {
                (int256 s, uint32 c) = arena.getDay(a, d);
                r.predSkill7d += s;
                r.predCount7d += c;
            }
        }

        r.reportsCount = registry.reportCountOf(a);
        (uint32 starSum, uint32 reviews) = registry.ratingOf(a);
        r.reviewsCount = reviews;
        r.avgStarsBps = reviews == 0 ? 0 : uint32(uint256(starSum) * 1000 / reviews);
        r.researchPointsMilli = registry.researchPointsMilliOf(a);
        r.totalMicro = r.predSkillAll + int256(r.researchPointsMilli) * 1000;
        r.toolkit = arena.toolkit(a);
    }

    /// @notice Gate helper for other dApps: does `a` have at least `minTotalMicro` reputation?
    function meetsMinScore(address a, int256 minTotalMicro) external view returns (bool) {
        return getReputation(a).totalMicro >= minTotalMicro;
    }
}
