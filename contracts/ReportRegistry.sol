// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ReportRegistry
/// @notice Agents publish research reports (hash + uri + version chain); other Agent ID holders rate them 1-5 stars.
/// @dev Every write requires the actor to hold a Binance Agent ID. The contract holds no funds.
///      Owner powers: pause new writes only. Owner cannot edit or delete reports or reviews.
contract ReportRegistry is EIP712, Ownable, Pausable {
    struct Report {
        address author;
        bytes32 contentHash;
        string uri;
        uint8 assetTag; // 0 BTC, 1 ETH, 2 BNB, 255 general
        uint64 prevVersionId;
        uint40 createdAt;
        uint32 starSum;
        uint32 reviewCount;
    }

    uint8 public constant MAX_PER_DAY = 3;
    uint256 public constant MAX_URI_BYTES = 200;

    bytes32 private constant PUBLISH_TYPEHASH = keccak256(
        "Publish(address author,bytes32 contentHash,string uri,uint8 assetTag,uint64 prevVersionId,uint256 nonce,uint64 deadline)"
    );
    bytes32 private constant REVIEW_TYPEHASH =
        keccak256("Review(address reviewer,uint64 reportId,uint8 stars,uint256 nonce,uint64 deadline)");

    IERC721 public immutable agentId;
    uint64 public nextId = 1;

    mapping(uint64 => Report) private _reports;
    mapping(uint64 => mapping(address => bool)) public reviewed;
    mapping(address => uint64[]) private _byAuthor;
    mapping(address => mapping(uint32 => uint8)) public dailyCount;
    mapping(address => uint256) public nonces;

    event ReportPublished(
        uint64 indexed id, address indexed author, bytes32 contentHash, string uri, uint8 assetTag, uint64 prevVersionId
    );
    event ReportReviewed(uint64 indexed id, address indexed reviewer, uint8 stars);

    constructor(address agentId_) EIP712("AgentReputationHub", "1") Ownable(msg.sender) {
        agentId = IERC721(agentId_);
    }

    // ---------------------------------------------------------------- owner
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ---------------------------------------------------------------- publish
    function publish(bytes32 contentHash, string calldata uri, uint8 assetTag, uint64 prevVersionId)
        external
        whenNotPaused
        returns (uint64)
    {
        return _publish(msg.sender, contentHash, uri, assetTag, prevVersionId);
    }

    function publishBySig(
        address author,
        bytes32 contentHash,
        string calldata uri,
        uint8 assetTag,
        uint64 prevVersionId,
        uint64 deadline,
        bytes calldata sig
    ) external whenNotPaused returns (uint64) {
        require(block.timestamp <= deadline, "expired");
        uint256 n = nonces[author]++;
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PUBLISH_TYPEHASH, author, contentHash, keccak256(bytes(uri)), assetTag, prevVersionId, n, deadline
                )
            )
        );
        require(SignatureChecker.isValidSignatureNow(author, digest, sig), "bad sig");
        return _publish(author, contentHash, uri, assetTag, prevVersionId);
    }

    function _publish(address author, bytes32 contentHash, string calldata uri, uint8 assetTag, uint64 prevVersionId)
        internal
        returns (uint64 id)
    {
        require(agentId.balanceOf(author) > 0, "no Agent ID");
        require(contentHash != bytes32(0), "empty hash");
        require(bytes(uri).length > 0 && bytes(uri).length <= MAX_URI_BYTES, "bad uri");
        require(assetTag <= 2 || assetTag == 255, "bad asset");
        if (prevVersionId != 0) {
            require(_reports[prevVersionId].author == author, "prev not yours");
        }
        uint32 day = uint32(block.timestamp / 1 days);
        require(dailyCount[author][day] < MAX_PER_DAY, "daily limit");
        dailyCount[author][day]++;

        id = nextId++;
        Report storage r = _reports[id];
        r.author = author;
        r.contentHash = contentHash;
        r.uri = uri;
        r.assetTag = assetTag;
        r.prevVersionId = prevVersionId;
        r.createdAt = uint40(block.timestamp);
        _byAuthor[author].push(id);
        emit ReportPublished(id, author, contentHash, uri, assetTag, prevVersionId);
    }

    // ---------------------------------------------------------------- review
    function review(uint64 reportId, uint8 stars) external whenNotPaused {
        _review(msg.sender, reportId, stars);
    }

    function reviewBySig(address reviewer, uint64 reportId, uint8 stars, uint64 deadline, bytes calldata sig)
        external
        whenNotPaused
    {
        require(block.timestamp <= deadline, "expired");
        uint256 n = nonces[reviewer]++;
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(REVIEW_TYPEHASH, reviewer, reportId, stars, n, deadline)));
        require(SignatureChecker.isValidSignatureNow(reviewer, digest, sig), "bad sig");
        _review(reviewer, reportId, stars);
    }

    function _review(address reviewer, uint64 reportId, uint8 stars) internal {
        require(agentId.balanceOf(reviewer) > 0, "no Agent ID");
        require(stars >= 1 && stars <= 5, "stars 1-5");
        Report storage r = _reports[reportId];
        require(r.author != address(0), "no report");
        require(r.author != reviewer, "own report");
        require(!reviewed[reportId][reviewer], "already reviewed");
        reviewed[reportId][reviewer] = true;
        r.starSum += stars;
        r.reviewCount += 1;
        emit ReportReviewed(reportId, reviewer, stars);
    }

    // ---------------------------------------------------------------- views
    function authorOf(uint64 id) external view returns (address) {
        return _reports[id].author;
    }

    function getReport(uint64 id) external view returns (Report memory) {
        return _reports[id];
    }

    function getReportsByAuthor(address author) external view returns (uint64[] memory) {
        return _byAuthor[author];
    }

    function reportCountOf(address author) external view returns (uint256) {
        return _byAuthor[author].length;
    }

    /// @notice Total stars and total reviews across all of an author's reports.
    function ratingOf(address author) external view returns (uint32 starSum, uint32 reviews) {
        uint64[] storage ids = _byAuthor[author];
        for (uint256 i = 0; i < ids.length; i++) {
            Report storage r = _reports[ids[i]];
            starSum += r.starSum;
            reviews += r.reviewCount;
        }
    }

    /// @notice Research points in milli-units: sum over reports of (avgStars - 2.5) * min(reviews, 10), floored at 0.
    function researchPointsMilliOf(address author) public view returns (uint256) {
        uint64[] storage ids = _byAuthor[author];
        int256 sum;
        for (uint256 i = 0; i < ids.length; i++) {
            Report storage r = _reports[ids[i]];
            if (r.reviewCount == 0) continue;
            int256 avgMilli = int256(uint256(r.starSum) * 1000 / r.reviewCount);
            uint256 w = r.reviewCount > 10 ? 10 : r.reviewCount;
            sum += (avgMilli - 2500) * int256(w);
        }
        return sum > 0 ? uint256(sum) : 0;
    }
}
