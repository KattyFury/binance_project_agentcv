// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

interface IAggregator {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IReportAuthor {
    function authorOf(uint64 id) external view returns (address);
}

/// @title PredictArena
/// @notice Free-to-play forecasting contest for Agent ID holders. Agents submit a probability that an asset's price
///         rises over a 1h (H1) or 24h (D1) round; the contract scores each forecast with a Brier-based skill score.
/// @dev Holds no funds. Owner powers (documented in README): replace price feeds only during the first 24h after
///      deployment, and pause NEW predictions. The owner cannot change scores, rounds or results.
///      Prices come from Chainlink feeds and are recorded permissionlessly once per hour.
contract PredictArena is EIP712, Ownable, Pausable {
    // ------------------------------------------------------------------ types
    struct Item {
        uint8 horizon; // 1 (H1) or 24 (D1)
        uint32 startHour; // hour index at which the round's start price is recorded
        uint8 asset; // 0 BTC, 1 ETH, 2 BNB
        uint16 pBps; // probability price goes up, 100..9900
        uint64 reportId; // optional evidence report (0 = none)
        string note; // optional rationale (<=280 bytes), emitted only
    }

    struct PredictionRec {
        uint16 pBps;
        uint64 reportId;
    }

    struct PriceRec {
        int256 price;
        bool valid;
    }

    struct Totals {
        int256 skill;
        uint32 count;
        int256 skillWith;
        uint32 countWith;
        int256 skillNo;
        uint32 countNo;
    }

    struct Bucket {
        int256 skill;
        uint32 count;
    }

    struct WeekBucket {
        int256 skill;
        uint32 count;
        uint40 lastUpdate;
    }

    // -------------------------------------------------------------- constants
    uint256 public constant RECORD_WINDOW = 10 minutes;
    uint256 public constant STALE_AFTER = 30 minutes;
    uint256 public constant FINALIZE_GRACE = 6 hours;
    uint32 public constant MAX_AHEAD_H1 = 6;
    uint32 public constant MAX_AHEAD_D1 = 24;
    uint256 public constant MAX_BATCH = 18;
    uint256 public constant MAX_NOTE_BYTES = 280;

    bytes32 private constant ITEM_TYPEHASH = keccak256(
        "Item(uint8 horizon,uint32 startHour,uint8 asset,uint16 pBps,uint64 reportId,string note)"
    );
    bytes32 private constant BATCH_TYPEHASH = keccak256(
        "PredictBatch(address agent,uint256 nonce,uint64 deadline,Item[] items)Item(uint8 horizon,uint32 startHour,uint8 asset,uint16 pBps,uint64 reportId,string note)"
    );

    // ---------------------------------------------------------------- storage
    IERC721 public immutable agentId;
    IReportAuthor public immutable reports;
    uint64 public immutable GENESIS; // multiple of 3600; production value is a Monday 00:00 UTC
    uint32 public immutable minRounds; // minimum settled predictions in a week to be ranked
    uint64 public immutable feedsLockedAt;

    IAggregator[3] public feeds;

    mapping(uint32 => mapping(uint8 => PriceRec)) public prices;
    mapping(uint32 => bool) public recorded;

    mapping(bytes32 => mapping(address => PredictionRec)) private _predictions;
    mapping(bytes32 => address[]) private _predictors;
    mapping(bytes32 => uint32) public settleCursor;

    mapping(address => Totals) private _totals;
    mapping(address => mapping(uint32 => Bucket)) private _day;

    mapping(uint32 => mapping(address => WeekBucket)) private _week;
    mapping(uint32 => mapping(address => bool)) private _weekSeen;
    mapping(uint32 => address[]) private _weekAgents;
    mapping(uint32 => bool) public weekFinalized;
    mapping(uint32 => address[10]) private _finalTop;

    mapping(address => uint256) public nonces;
    mapping(address => uint16) public toolkit;

    // ----------------------------------------------------------------- events
    event PricesRecorded(uint32 indexed hourIndex);
    event Predicted(
        address indexed agent,
        uint8 horizon,
        uint32 startHour,
        uint8 asset,
        uint16 pBps,
        uint64 reportId,
        string note
    );
    event Settled(bytes32 indexed key, uint32 from, uint32 to, bool valid, bool up);
    event WeekFinalized(uint32 indexed week, address[10] top);
    event ToolkitDeclared(address indexed agent, uint16 bitmap);
    event FeedSet(uint8 indexed asset, address feed);

    constructor(
        address agentId_,
        address reports_,
        address[3] memory feeds_,
        uint64 genesis_,
        uint32 minRounds_
    ) EIP712("AgentReputationHub", "1") Ownable(msg.sender) {
        require(genesis_ % 3600 == 0, "genesis not hour-aligned");
        agentId = IERC721(agentId_);
        reports = IReportAuthor(reports_);
        GENESIS = genesis_;
        minRounds = minRounds_;
        feedsLockedAt = uint64(block.timestamp + 24 hours);
        for (uint8 i = 0; i < 3; i++) {
            feeds[i] = IAggregator(feeds_[i]);
            emit FeedSet(i, feeds_[i]);
        }
    }

    // ------------------------------------------------------------------ owner
    function setFeed(uint8 asset, address feed) external onlyOwner {
        require(block.timestamp < feedsLockedAt, "feeds locked");
        require(asset < 3, "bad asset");
        feeds[asset] = IAggregator(feed);
        emit FeedSet(asset, feed);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ----------------------------------------------------------------- prices
    /// @notice Record the three feed prices for `hourIndex`. Permissionless, valid only within 10 minutes after the hour.
    function recordPrices(uint32 hourIndex) external {
        uint256 ts = _hourTs(hourIndex);
        require(block.timestamp >= ts && block.timestamp <= ts + RECORD_WINDOW, "outside window");
        require(!recorded[hourIndex], "already recorded");
        recorded[hourIndex] = true;
        for (uint8 a = 0; a < 3; a++) {
            (bool ok, int256 p) = _readFeed(a, ts);
            prices[hourIndex][a] = PriceRec(p, ok);
        }
        emit PricesRecorded(hourIndex);
    }

    function _readFeed(uint8 a, uint256 ts) internal view returns (bool, int256) {
        try feeds[a].latestRoundData() returns (uint80, int256 ans, uint256, uint256 upd, uint80) {
            if (ans > 0 && upd + STALE_AFTER >= ts && upd <= block.timestamp) return (true, ans);
        } catch {}
        return (false, 0);
    }

    function _hourTs(uint32 hourIndex) internal view returns (uint256) {
        return uint256(GENESIS) + uint256(hourIndex) * 3600;
    }

    function currentHour() public view returns (uint32) {
        require(block.timestamp >= GENESIS, "before genesis");
        return uint32((block.timestamp - GENESIS) / 3600);
    }

    // ------------------------------------------------------------ predictions
    /// @notice Direct path: the calling Agent ID holder submits up to 18 predictions.
    function predict(Item[] calldata items) external whenNotPaused {
        _predictAll(msg.sender, items);
    }

    /// @notice Relayed path: anyone may submit a batch signed (EIP-712) by the agent. Supports ECDSA and ERC-1271 wallets.
    function predictBySig(address agent, Item[] calldata items, uint64 deadline, bytes calldata sig)
        external
        whenNotPaused
    {
        require(block.timestamp <= deadline, "expired");
        uint256 n = nonces[agent]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(BATCH_TYPEHASH, agent, n, deadline, _hashItems(items))));
        require(SignatureChecker.isValidSignatureNow(agent, digest, sig), "bad sig");
        _predictAll(agent, items);
    }

    function _hashItems(Item[] calldata items) internal pure returns (bytes32) {
        bytes32[] memory hs = new bytes32[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            Item calldata it = items[i];
            hs[i] = keccak256(
                abi.encode(
                    ITEM_TYPEHASH, it.horizon, it.startHour, it.asset, it.pBps, it.reportId, keccak256(bytes(it.note))
                )
            );
        }
        return keccak256(abi.encodePacked(hs));
    }

    function _predictAll(address agent, Item[] calldata items) internal {
        require(items.length > 0 && items.length <= MAX_BATCH, "bad batch size");
        require(agentId.balanceOf(agent) > 0, "no Agent ID");
        uint32 nowHour = currentHour();
        for (uint256 i = 0; i < items.length; i++) {
            Item calldata it = items[i];
            _validateEntry(agent, it, nowHour);
            bytes32 key = _key(it.horizon, it.startHour, it.asset);
            _predictions[key][agent] = PredictionRec(it.pBps, it.reportId);
            _predictors[key].push(agent);
            emit Predicted(agent, it.horizon, it.startHour, it.asset, it.pBps, it.reportId, it.note);
        }
    }

    function _validateEntry(address agent, Item calldata it, uint32 nowHour) internal view {
        require(it.horizon == 1 || it.horizon == 24, "bad horizon");
        require(it.horizon == 1 || it.startHour % 24 == 0, "D1 starts at 00:00 UTC");
        require(it.asset < 3, "bad asset");
        require(it.pBps >= 100 && it.pBps <= 9900, "pBps out of range");
        require(bytes(it.note).length <= MAX_NOTE_BYTES, "note too long");
        require(block.timestamp < _hourTs(it.startHour), "round locked");
        uint32 ahead = it.horizon == 1 ? MAX_AHEAD_H1 : MAX_AHEAD_D1;
        require(it.startHour <= nowHour + ahead, "too far ahead");
        bytes32 key = _key(it.horizon, it.startHour, it.asset);
        require(_predictions[key][agent].pBps == 0, "already predicted");
        if (it.reportId != 0) {
            require(reports.authorOf(it.reportId) == agent, "report not yours");
        }
    }

    function _key(uint8 horizon, uint32 startHour, uint8 asset) internal pure returns (bytes32) {
        return keccak256(abi.encode(horizon, startHour, asset));
    }

    function declareToolkit(uint16 bitmap) external {
        require(agentId.balanceOf(msg.sender) > 0, "no Agent ID");
        toolkit[msg.sender] = bitmap;
        emit ToolkitDeclared(msg.sender, bitmap);
    }

    // ------------------------------------------------------------ settlement
    function _resolved(uint32 hourIndex) internal view returns (bool) {
        return recorded[hourIndex] || block.timestamp > _hourTs(hourIndex) + RECORD_WINDOW;
    }

    /// @notice Settle up to `maxCount` predictions of a round. Permissionless. Void rounds are skipped without points.
    function settle(uint8 horizon, uint32 startHour, uint8 asset, uint32 maxCount) external {
        require(horizon == 1 || horizon == 24, "bad horizon");
        require(horizon == 1 || startHour % 24 == 0, "bad D1 start");
        require(asset < 3, "bad asset");
        uint32 endHour = startHour + horizon;
        require(_resolved(startHour) && _resolved(endHour), "prices pending");

        bytes32 key = _key(horizon, startHour, asset);
        address[] storage list = _predictors[key];
        uint32 cursor = settleCursor[key];
        require(cursor < list.length, "nothing to settle");

        PriceRec memory p0 = prices[startHour][asset];
        PriceRec memory p1 = prices[endHour][asset];
        bool valid = recorded[startHour] && recorded[endHour] && p0.valid && p1.valid && p0.price != p1.price;
        bool up = valid && p1.price > p0.price;

        uint32 end = cursor + maxCount;
        if (end > list.length) end = uint32(list.length);
        if (valid) {
            for (uint32 i = cursor; i < end; i++) {
                address agent = list[i];
                _credit(agent, startHour, _predictions[key][agent], up);
            }
        }
        settleCursor[key] = end;
        emit Settled(key, cursor, end, valid, up);
    }

    function _credit(address agent, uint32 startHour, PredictionRec memory rec, bool up) internal {
        int256 s = _skillMicro(rec.pBps, up);

        Totals storage t = _totals[agent];
        t.skill += s;
        t.count += 1;
        if (rec.reportId != 0) {
            t.skillWith += s;
            t.countWith += 1;
        } else {
            t.skillNo += s;
            t.countNo += 1;
        }

        Bucket storage d = _day[agent][startHour / 24];
        d.skill += s;
        d.count += 1;

        uint32 week = startHour / 168;
        if (!weekFinalized[week]) {
            if (!_weekSeen[week][agent]) {
                _weekSeen[week][agent] = true;
                _weekAgents[week].push(agent);
            }
            WeekBucket storage w = _week[week][agent];
            w.skill += s;
            w.count += 1;
            w.lastUpdate = uint40(block.timestamp);
        }
    }

    /// @dev skill = 0.25 - (p - o)^2 in micro-units. p in bps, o in {0, 10000}.
    function _skillMicro(uint16 pBps, bool up) internal pure returns (int256) {
        uint256 o = up ? 10000 : 0;
        uint256 diff = pBps > o ? pBps - o : o - pBps;
        return int256(250000) - int256((diff * diff) / 100);
    }

    // ------------------------------------------------------------ leaderboard
    function weekOf(uint32 startHour) public pure returns (uint32) {
        return startHour / 168;
    }

    function _better(WeekBucket storage a, WeekBucket storage b) internal view returns (bool) {
        if (a.skill != b.skill) return a.skill > b.skill;
        if (a.count != b.count) return a.count > b.count;
        return a.lastUpdate < b.lastUpdate; // reached the score first
    }

    function _computeTop(uint32 week) internal view returns (address[10] memory top) {
        address[] storage agents = _weekAgents[week];
        for (uint256 i = 0; i < agents.length; i++) {
            address a = agents[i];
            WeekBucket storage wa = _week[week][a];
            if (wa.count < minRounds) continue;
            uint256 pos = 10;
            for (uint256 j = 0; j < 10; j++) {
                address o = top[j];
                if (o == address(0) || _better(wa, _week[week][o])) {
                    pos = j;
                    break;
                }
            }
            if (pos < 10) {
                for (uint256 k = 9; k > pos; k--) top[k] = top[k - 1];
                top[pos] = a;
            }
        }
    }

    /// @notice Live top 10 of a week (frozen result once finalized). Only agents with >= minRounds settled predictions.
    function getWeekTop(uint32 week) public view returns (address[10] memory) {
        if (weekFinalized[week]) return _finalTop[week];
        return _computeTop(week);
    }

    /// @notice Freeze a week's leaderboard 6 hours after the week ends. Permissionless.
    function finalizeWeek(uint32 week) external {
        require(!weekFinalized[week], "already finalized");
        uint256 weekEnd = _hourTs((week + 1) * 168);
        require(block.timestamp >= weekEnd + FINALIZE_GRACE, "week not over");
        address[10] memory top = _computeTop(week);
        _finalTop[week] = top;
        weekFinalized[week] = true;
        emit WeekFinalized(week, top);
    }

    // ------------------------------------------------------------------ views
    function getTotals(address a)
        external
        view
        returns (int256 skill, uint32 count, int256 skillWith, uint32 countWith, int256 skillNo, uint32 countNo)
    {
        Totals storage t = _totals[a];
        return (t.skill, t.count, t.skillWith, t.countWith, t.skillNo, t.countNo);
    }

    function getDay(address a, uint32 day) external view returns (int256 skill, uint32 count) {
        Bucket storage d = _day[a][day];
        return (d.skill, d.count);
    }

    function getWeekAgent(uint32 week, address a) external view returns (int256 skill, uint32 count, uint40 lastUpdate) {
        WeekBucket storage w = _week[week][a];
        return (w.skill, w.count, w.lastUpdate);
    }

    function weekAgentCount(uint32 week) external view returns (uint256) {
        return _weekAgents[week].length;
    }

    function getPrediction(uint8 horizon, uint32 startHour, uint8 asset, address agent)
        external
        view
        returns (uint16 pBps, uint64 reportId)
    {
        PredictionRec storage r = _predictions[_key(horizon, startHour, asset)][agent];
        return (r.pBps, r.reportId);
    }

    function predictorCount(uint8 horizon, uint32 startHour, uint8 asset) external view returns (uint256) {
        return _predictors[_key(horizon, startHour, asset)].length;
    }

    function roundKey(uint8 horizon, uint32 startHour, uint8 asset) external pure returns (bytes32) {
        return _key(horizon, startHour, asset);
    }
}
