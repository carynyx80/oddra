// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {OddraMarkets} from "./OddraMarkets.sol";

/// @notice L2 block numbers and hashes. On Robinhood Chain (Arbitrum Orbit) this is the ArbSys precompile at 0x64,
///         because there `block.number` is the L1 block and `blockhash` is not an L2 block hash.
interface IBlockSource {
    function arbBlockNumber() external view returns (uint256);
    function arbBlockHash(uint256 blockNumber) external view returns (bytes32);
}

/// @title OddraMatchRegistry
/// @notice One record per match: the committed configuration and server seed, the post-betting entropy, the revealed
///         final seed and the settled result. Nothing here can be edited once written.
/// @dev Fairness model (docs/FAIRNESS.md):
///      1. Before betting opens the operator commits keccak256(serverSeed) and the config hash (teams, players,
///         ruleset). The commitment fixes the operator's input before any bet exists.
///      2. After kickoff anyone can `lock`, which names an L2 block a few blocks in the future as the entropy block.
///         Its hash did not exist when the operator committed, nor when the last bet was placed.
///      3. `reveal` checks the seed against the commitment and fixes finalSeed = keccak256(serverSeed, entropy, matchId).
///         From finalSeed and the config, anyone can replay the match with the open-source engine.
///      4. `settle` records the result and its hash. The engine runs off-chain, so the contract cannot recompute the
///         score; a wrong result is publicly provable but not rejected on-chain. Real-money use requires closing that gap.
contract OddraMatchRegistry is AccessControlDefaultAdminRules {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 public constant LIVE_DURATION = 900; // 15 minutes of real time per 90-minute match
    uint256 public constant MIN_BETTING_WINDOW = 60;
    uint256 public constant ENTROPY_DELAY = 4; // L2 blocks between lock and the entropy block
    uint256 public constant REVEAL_WINDOW = 10 minutes; // after kickoff; otherwise anyone may void
    uint256 public constant SETTLE_WINDOW = 6 hours; // after full time; otherwise anyone may void

    enum Status {
        None,
        Scheduled,
        Locked,
        Revealed,
        Settled,
        Voided
    }

    struct Match {
        uint64 openTime;
        uint64 kickoff;
        uint8 homeTeam;
        uint8 awayTeam;
        Status status;
        uint8 homeGoals;
        uint8 awayGoals;
        uint8 firstScorer; // 0 none, 1 home, 2 away
        uint64 entropyBlock;
        bytes32 configHash;
        bytes32 rulesetHash;
        bytes32 seedCommit;
        bytes32 entropy;
        bytes32 serverSeed;
        bytes32 finalSeed;
        bytes32 resultHash;
    }

    IBlockSource public immutable blocks;
    mapping(uint256 => Match) private _matches;
    uint256[] public matchIds;

    event MatchCreated(
        uint256 indexed matchId,
        uint8 homeTeam,
        uint8 awayTeam,
        uint64 openTime,
        uint64 kickoff,
        bytes32 configHash,
        bytes32 rulesetHash,
        bytes32 seedCommit
    );
    event MatchLocked(uint256 indexed matchId, uint64 entropyBlock);
    event MatchRevealed(uint256 indexed matchId, bytes32 serverSeed, bytes32 entropy, bytes32 finalSeed);
    event MatchSettled(
        uint256 indexed matchId, uint8 homeGoals, uint8 awayGoals, uint8 firstScorer, bytes32 resultHash
    );
    event MatchVoided(uint256 indexed matchId, Status previous);

    error BadStatus(Status actual);
    error BadSchedule();
    error AlreadyExists();
    error TooEarly();
    error TooLate();
    error SeedMismatch();
    error EntropyUnavailable();
    error SameTeam();

    constructor(address admin, IBlockSource blockSource) AccessControlDefaultAdminRules(1 days, admin) {
        blocks = blockSource;
    }

    function getMatch(uint256 matchId) external view returns (Match memory) {
        return _matches[matchId];
    }

    function status(uint256 matchId) external view returns (Status) {
        return _matches[matchId].status;
    }

    function matchCount() external view returns (uint256) {
        return matchIds.length;
    }

    /// @notice Commit a match before its betting window opens.
    function createMatch(
        uint256 matchId,
        uint8 homeTeam,
        uint8 awayTeam,
        bytes32 configHash,
        bytes32 rulesetHash,
        bytes32 seedCommit,
        uint64 openTime,
        uint64 kickoff
    ) external onlyRole(OPERATOR_ROLE) {
        if (_matches[matchId].status != Status.None) revert AlreadyExists();
        if (homeTeam == awayTeam) revert SameTeam();
        if (openTime < block.timestamp || kickoff < uint256(openTime) + MIN_BETTING_WINDOW) revert BadSchedule();
        if (seedCommit == bytes32(0) || configHash == bytes32(0)) revert BadSchedule();
        Match storage m = _matches[matchId];
        m.openTime = openTime;
        m.kickoff = kickoff;
        m.homeTeam = homeTeam;
        m.awayTeam = awayTeam;
        m.status = Status.Scheduled;
        m.configHash = configHash;
        m.rulesetHash = rulesetHash;
        m.seedCommit = seedCommit;
        matchIds.push(matchId);
        emit MatchCreated(matchId, homeTeam, awayTeam, openTime, kickoff, configHash, rulesetHash, seedCommit);
    }

    /// @notice Betting is over: pick the future entropy block. Anyone may call.
    function lock(uint256 matchId) external {
        Match storage m = _matches[matchId];
        if (m.status != Status.Scheduled) revert BadStatus(m.status);
        if (block.timestamp < m.kickoff) revert TooEarly();
        m.status = Status.Locked;
        m.entropyBlock = uint64(blocks.arbBlockNumber() + ENTROPY_DELAY);
        emit MatchLocked(matchId, m.entropyBlock);
    }

    function reveal(uint256 matchId, bytes32 serverSeed) external onlyRole(OPERATOR_ROLE) {
        Match storage m = _matches[matchId];
        if (m.status != Status.Locked) revert BadStatus(m.status);
        if (keccak256(abi.encodePacked(serverSeed)) != m.seedCommit) revert SeedMismatch();
        if (blocks.arbBlockNumber() <= m.entropyBlock) revert TooEarly();
        bytes32 entropy = blocks.arbBlockHash(m.entropyBlock);
        if (entropy == bytes32(0)) revert EntropyUnavailable();
        m.serverSeed = serverSeed;
        m.entropy = entropy;
        m.finalSeed = keccak256(abi.encodePacked(serverSeed, entropy, matchId));
        m.status = Status.Revealed;
        emit MatchRevealed(matchId, serverSeed, entropy, m.finalSeed);
    }

    function settle(uint256 matchId, uint8 homeGoals, uint8 awayGoals, uint8 firstScorer, bytes32 resultHash)
        external
        onlyRole(OPERATOR_ROLE)
    {
        Match storage m = _matches[matchId];
        if (m.status != Status.Revealed) revert BadStatus(m.status);
        if (block.timestamp < uint256(m.kickoff) + LIVE_DURATION) revert TooEarly();
        if (!OddraMarkets.isValidResult(homeGoals, awayGoals, firstScorer) || resultHash == bytes32(0)) {
            revert OddraMarkets.InvalidResult();
        }
        m.homeGoals = homeGoals;
        m.awayGoals = awayGoals;
        m.firstScorer = firstScorer;
        m.resultHash = resultHash;
        m.status = Status.Settled;
        emit MatchSettled(matchId, homeGoals, awayGoals, firstScorer, resultHash);
    }

    /// @notice Void a match: by the operator before betting opens, or by anyone once the reveal or settlement deadline
    ///         has passed. Voided matches refund every stake.
    function voidMatch(uint256 matchId) external {
        Match storage m = _matches[matchId];
        Status s = m.status;
        bool beforeOpen = s == Status.Scheduled && block.timestamp < m.openTime && hasRole(OPERATOR_ROLE, msg.sender);
        bool revealMissed = (s == Status.Scheduled || s == Status.Locked) && block.timestamp > m.kickoff + REVEAL_WINDOW;
        bool settleMissed = s == Status.Revealed && block.timestamp > m.kickoff + LIVE_DURATION + SETTLE_WINDOW;
        if (!beforeOpen && !revealMissed && !settleMissed) revert BadStatus(s);
        m.status = Status.Voided;
        emit MatchVoided(matchId, s);
    }
}

/// @notice Native block source for local chains (anvil). Robinhood Chain uses ArbSys at 0x64 instead.
contract NativeBlockSource is IBlockSource {
    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function arbBlockHash(uint256 blockNumber) external view returns (bytes32) {
        return blockhash(blockNumber);
    }
}
