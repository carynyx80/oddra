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
///      4. The operator `proposeResult`s the score and result hash. The engine runs off-chain, so the contract cannot
///         recompute it; instead the proposal only becomes final after a dispute window. Anyone who replays the match
///         and disagrees can `dispute` it with a bond; an ARBITER (a key separate from the operator) then rules. An
///         unresolved dispute ends in a void, which refunds every stake. See docs/FAIRNESS.md.
contract OddraMatchRegistry is AccessControlDefaultAdminRules {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    uint256 public constant LIVE_DURATION = 900; // 15 minutes of real time per 90-minute match
    uint256 public constant MIN_BETTING_WINDOW = 60;
    uint256 public constant ENTROPY_DELAY = 4; // L2 blocks between lock and the entropy block
    uint256 public constant REVEAL_WINDOW = 10 minutes; // after kickoff; otherwise anyone may void
    uint256 public constant SETTLE_WINDOW = 6 hours; // after full time; otherwise anyone may void
    uint256 public constant ARBITRATION_WINDOW = 24 hours; // after a dispute; otherwise anyone may void
    uint256 public constant MIN_DISPUTE_WINDOW = 2 minutes;
    uint256 public constant MAX_DISPUTE_WINDOW = 1 days;

    /// @notice How long a proposed result stays open to disputes before it can be finalised.
    uint256 public disputeWindow = 10 minutes;
    /// @notice ETH a disputer must post. Returned if the arbiter changes the result, forfeited to the treasury if not.
    uint256 public disputeBond = 0.005 ether;
    /// @notice Where forfeited dispute bonds go (the treasury).
    address public bondSink;

    enum Status {
        None,
        Scheduled,
        Locked,
        Revealed,
        Proposed,
        Disputed,
        Settled,
        Voided
    }

    struct Dispute {
        address disputer;
        uint96 bond;
        uint64 at;
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
        uint64 proposedAt;
    }

    IBlockSource public immutable blocks;
    mapping(uint256 => Match) private _matches;
    mapping(uint256 => Dispute) public disputes;
    /// @notice Bond refunds that could not be pushed; claimable with `withdrawRefund`.
    mapping(address => uint256) public pendingRefunds;
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
    event ResultProposed(
        uint256 indexed matchId, uint8 homeGoals, uint8 awayGoals, uint8 firstScorer, bytes32 resultHash, uint64 finalAt
    );
    event ResultDisputed(uint256 indexed matchId, address indexed disputer, uint256 bond);
    event DisputeResolved(uint256 indexed matchId, bool overturned, address arbiter);
    event MatchSettled(
        uint256 indexed matchId, uint8 homeGoals, uint8 awayGoals, uint8 firstScorer, bytes32 resultHash
    );
    event MatchVoided(uint256 indexed matchId, Status previous);
    event DisputeParamsSet(uint256 window, uint256 bond, address sink);

    error BadStatus(Status actual);
    error BadSchedule();
    error AlreadyExists();
    error TooEarly();
    error TooLate();
    error SeedMismatch();
    error EntropyUnavailable();
    error SameTeam();
    error BadBond();
    error BadParams();

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

    /// @notice The operator's reported result. Final only after the dispute window.
    function proposeResult(uint256 matchId, uint8 homeGoals, uint8 awayGoals, uint8 firstScorer, bytes32 resultHash)
        external
        onlyRole(OPERATOR_ROLE)
    {
        Match storage m = _matches[matchId];
        if (m.status != Status.Revealed) revert BadStatus(m.status);
        if (block.timestamp < uint256(m.kickoff) + LIVE_DURATION) revert TooEarly();
        _validate(homeGoals, awayGoals, firstScorer, resultHash);
        m.homeGoals = homeGoals;
        m.awayGoals = awayGoals;
        m.firstScorer = firstScorer;
        m.resultHash = resultHash;
        m.proposedAt = uint64(block.timestamp);
        m.status = Status.Proposed;
        emit ResultProposed(
            matchId, homeGoals, awayGoals, firstScorer, resultHash, uint64(block.timestamp + disputeWindow)
        );
    }

    /// @notice Challenge a proposed result during the dispute window. Anyone may call, posting `disputeBond` in ETH.
    function dispute(uint256 matchId) external payable {
        Match storage m = _matches[matchId];
        if (m.status != Status.Proposed) revert BadStatus(m.status);
        if (block.timestamp >= uint256(m.proposedAt) + disputeWindow) revert TooLate();
        if (msg.value != disputeBond) revert BadBond();
        disputes[matchId] = Dispute({disputer: msg.sender, bond: uint96(msg.value), at: uint64(block.timestamp)});
        m.status = Status.Disputed;
        emit ResultDisputed(matchId, msg.sender, msg.value);
    }

    /// @notice Make an undisputed proposal final once its window has passed. Anyone may call.
    function finalize(uint256 matchId) external {
        Match storage m = _matches[matchId];
        if (m.status != Status.Proposed) revert BadStatus(m.status);
        if (block.timestamp < uint256(m.proposedAt) + disputeWindow) revert TooEarly();
        m.status = Status.Settled;
        emit MatchSettled(matchId, m.homeGoals, m.awayGoals, m.firstScorer, m.resultHash);
    }

    /// @notice The arbiter rules on a disputed result. If the ruling differs from the proposal, the disputer's bond is
    ///         returned; otherwise it is forfeited to the treasury.
    function resolveDispute(uint256 matchId, uint8 homeGoals, uint8 awayGoals, uint8 firstScorer, bytes32 resultHash)
        external
        onlyRole(ARBITER_ROLE)
    {
        Match storage m = _matches[matchId];
        if (m.status != Status.Disputed) revert BadStatus(m.status);
        _validate(homeGoals, awayGoals, firstScorer, resultHash);
        bool overturned = homeGoals != m.homeGoals || awayGoals != m.awayGoals || firstScorer != m.firstScorer
            || resultHash != m.resultHash;
        m.homeGoals = homeGoals;
        m.awayGoals = awayGoals;
        m.firstScorer = firstScorer;
        m.resultHash = resultHash;
        m.status = Status.Settled;
        Dispute memory d = disputes[matchId];
        if (overturned) {
            _refund(d.disputer, d.bond);
        } else if (bondSink != address(0)) {
            IBondSink(bondSink).contribute{value: d.bond}(address(0), d.bond, "dispute-bond");
        } else {
            _refund(d.disputer, d.bond);
        }
        emit DisputeResolved(matchId, overturned, msg.sender);
        emit MatchSettled(matchId, homeGoals, awayGoals, firstScorer, resultHash);
    }

    function withdrawRefund() external {
        uint256 amount = pendingRefunds[msg.sender];
        pendingRefunds[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "refund failed");
    }

    function setDisputeParams(uint256 window, uint256 bond, address sink) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (window < MIN_DISPUTE_WINDOW || window > MAX_DISPUTE_WINDOW || bond == 0) revert BadParams();
        disputeWindow = window;
        disputeBond = bond;
        bondSink = sink;
        emit DisputeParamsSet(window, bond, sink);
    }

    function _validate(uint8 h, uint8 a, uint8 first, bytes32 resultHash) private pure {
        if (!OddraMarkets.isValidResult(h, a, first) || resultHash == bytes32(0)) revert OddraMarkets.InvalidResult();
    }

    function _refund(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 30_000}("");
        if (!ok) pendingRefunds[to] += amount;
    }

    /// @notice Void a match: by the operator before betting opens, or by anyone once the reveal or settlement deadline
    ///         has passed. Voided matches refund every stake.
    function voidMatch(uint256 matchId) external {
        Match storage m = _matches[matchId];
        Status s = m.status;
        bool beforeOpen = s == Status.Scheduled && block.timestamp < m.openTime && hasRole(OPERATOR_ROLE, msg.sender);
        bool revealMissed = (s == Status.Scheduled || s == Status.Locked) && block.timestamp > m.kickoff + REVEAL_WINDOW;
        bool settleMissed = s == Status.Revealed && block.timestamp > m.kickoff + LIVE_DURATION + SETTLE_WINDOW;
        bool arbitrationMissed = s == Status.Disputed && block.timestamp > disputes[matchId].at + ARBITRATION_WINDOW;
        if (!beforeOpen && !revealMissed && !settleMissed && !arbitrationMissed) revert BadStatus(s);
        m.status = Status.Voided;
        if (arbitrationMissed) {
            Dispute memory d = disputes[matchId];
            _refund(d.disputer, d.bond);
        }
        emit MatchVoided(matchId, s);
    }
}

interface IBondSink {
    function contribute(address asset, uint256 amount, bytes32 source) external payable;
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
