// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OddraMarkets} from "./OddraMarkets.sol";
import {OddraMatchRegistry} from "./OddraMatchRegistry.sol";
import {OddraRiskManager} from "./OddraRiskManager.sol";
import {OddraTreasury} from "./OddraTreasury.sol";

/// @title OddraBook
/// @notice Fixed-odds single bets on Oddra matches, settled in USDG. The book accepts bets only during a match's
///         betting window, at odds published before the bet, and only when the treasury can reserve the worst-case
///         payout of the whole match across every possible result. Winnings are pull-based: a bettor can always claim,
///         and the keeper's automatic payouts never block one another.
contract OddraBook is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint32 public constant MIN_ODDS = 101; // 1.01
    uint32 public constant MAX_ODDS = 100_000; // 1000.00
    uint256 public constant LIMIT_INCREASE_DELAY = 1 days;

    struct Book {
        uint32[30] odds; // decimal odds × 100; 0 = selection suspended
        uint32 oddsVersion;
        bool settled;
        bool voided;
        uint32 winMask;
        uint128 totalStakes;
        uint128 reserved; // currently reserved in the treasury for this match
        uint128 owed; // after settlement: winnings or refunds not yet paid
        uint128[30] selectionPayout;
        uint128[33] scenarioPayout;
    }

    struct Bet {
        address bettor;
        uint64 matchId;
        uint8 selection;
        uint32 odds;
        bool paid;
        uint128 stake;
        uint128 payout;
        uint64 placedAt;
    }

    enum BetStatus {
        Open,
        Won,
        Lost,
        Refund,
        Paid
    }

    IERC20 public immutable usdg;
    OddraMatchRegistry public immutable registry;
    OddraTreasury public immutable treasury;
    OddraRiskManager public immutable risk;

    // Win masks of the 33 scenarios, eight 32-bit masks per word.
    uint256 private immutable _m0;
    uint256 private immutable _m1;
    uint256 private immutable _m2;
    uint256 private immutable _m3;
    uint256 private immutable _m4;

    mapping(uint256 => Book) private _books;
    Bet[] private _bets;
    mapping(address => uint256[]) private _betsOf;

    // responsible gambling: self-imposed, enforced on-chain
    mapping(address => uint64) public excludedUntil;
    mapping(address => uint128) public dailyLimit; // 0 = no limit
    mapping(address => uint128) public pendingDailyLimit;
    mapping(address => uint64) public pendingDailyLimitAt;
    mapping(address => mapping(uint256 => uint128)) public stakedOnDay;

    event OddsPublished(uint256 indexed matchId, uint32 version, uint32[30] odds);
    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed matchId,
        address indexed bettor,
        uint8 selection,
        uint256 stake,
        uint32 odds,
        uint256 payout
    );
    event BookSettled(uint256 indexed matchId, uint32 winMask, uint256 owed, uint256 released);
    event BookVoided(uint256 indexed matchId, uint256 refunds, uint256 released);
    event Claimed(uint256 indexed betId, address indexed bettor, uint256 amount, address caller);
    event PayoutFailed(uint256 indexed betId, address indexed bettor, uint256 amount);
    event SelfExcluded(address indexed bettor, uint64 until);
    event DailyLimitSet(address indexed bettor, uint128 limit, uint64 effectiveAt);

    error MarketClosed();
    error OddsUnavailable();
    error OddsChanged(uint32 current, uint32 minOdds);
    error BadSelection();
    error BadOdds();
    error NotSettled();
    error NothingToClaim();
    error AlreadyPaid();
    error Excluded(uint64 until);
    error DailyLimitExceeded(uint128 limit);

    constructor(
        address admin,
        IERC20 token,
        OddraMatchRegistry registry_,
        OddraTreasury treasury_,
        OddraRiskManager risk_
    ) AccessControlDefaultAdminRules(1 days, admin) {
        usdg = token;
        registry = registry_;
        treasury = treasury_;
        risk = risk_;
        uint256[5] memory w;
        for (uint256 i = 0; i < OddraMarkets.SCENARIOS; i++) {
            w[i / 8] |= uint256(OddraMarkets.scenarioMask(i)) << (32 * (i % 8));
        }
        (_m0, _m1, _m2, _m3, _m4) = (w[0], w[1], w[2], w[3], w[4]);
    }

    // ------------------------------------------------------------------ views

    function scenarioMask(uint256 i) public view returns (uint32) {
        uint256 w = i < 8 ? _m0 : i < 16 ? _m1 : i < 24 ? _m2 : i < 32 ? _m3 : _m4;
        return uint32(w >> (32 * (i % 8)));
    }

    function odds(uint256 matchId) external view returns (uint32[30] memory, uint32 version) {
        Book storage b = _books[matchId];
        return (b.odds, b.oddsVersion);
    }

    function bookState(uint256 matchId)
        external
        view
        returns (bool settled, bool voided, uint32 winMask, uint256 totalStakes, uint256 reserved, uint256 owed)
    {
        Book storage b = _books[matchId];
        return (b.settled, b.voided, b.winMask, b.totalStakes, b.reserved, b.owed);
    }

    function liabilities(uint256 matchId)
        external
        view
        returns (uint128[30] memory selection, uint128[33] memory scenario)
    {
        Book storage b = _books[matchId];
        return (b.selectionPayout, b.scenarioPayout);
    }

    function betCount() external view returns (uint256) {
        return _bets.length;
    }

    function getBet(uint256 betId) external view returns (Bet memory) {
        return _bets[betId];
    }

    function betsOf(address bettor) external view returns (uint256[] memory) {
        return _betsOf[bettor];
    }

    function betStatus(uint256 betId) public view returns (BetStatus) {
        Bet storage bet = _bets[betId];
        if (bet.paid) return BetStatus.Paid;
        Book storage b = _books[bet.matchId];
        if (b.voided) return BetStatus.Refund;
        if (!b.settled) return BetStatus.Open;
        return (b.winMask >> bet.selection) & 1 == 1 ? BetStatus.Won : BetStatus.Lost;
    }

    /// @notice What `claim` would pay now (0 if nothing).
    function claimable(uint256 betId) public view returns (uint256) {
        BetStatus s = betStatus(betId);
        if (s == BetStatus.Won) return _bets[betId].payout;
        if (s == BetStatus.Refund) return _bets[betId].stake;
        return 0;
    }

    function isOpen(uint256 matchId) public view returns (bool) {
        OddraMatchRegistry.Match memory m = registry.getMatch(matchId);
        return m.status == OddraMatchRegistry.Status.Scheduled && block.timestamp >= m.openTime
            && block.timestamp < m.kickoff && !paused();
    }

    // ------------------------------------------------------------------ operator

    /// @notice Publish or update prices for a scheduled match. Accepted bets keep the odds they were placed at.
    function publishOdds(uint256 matchId, uint32[30] calldata newOdds) external onlyRole(OPERATOR_ROLE) {
        OddraMatchRegistry.Match memory m = registry.getMatch(matchId);
        if (m.status != OddraMatchRegistry.Status.Scheduled || block.timestamp >= m.kickoff) revert MarketClosed();
        for (uint256 i = 0; i < 30; i++) {
            uint32 o = newOdds[i];
            if (o != 0 && (o < MIN_ODDS || o > MAX_ODDS)) revert BadOdds();
        }
        Book storage b = _books[matchId];
        b.odds = newOdds;
        b.oddsVersion++;
        emit OddsPublished(matchId, b.oddsVersion, newOdds);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------ betting

    /// @param minOdds the odds the bettor saw; the bet reverts if the price has since dropped below it.
    function placeBet(uint256 matchId, uint8 selection, uint128 stake, uint32 minOdds)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 betId)
    {
        if (selection >= OddraMarkets.SELECTIONS) revert BadSelection();
        if (!isOpen(matchId)) revert MarketClosed();
        Book storage b = _books[matchId];
        uint32 o = b.odds[selection];
        if (o == 0) revert OddsUnavailable();
        if (o < minOdds) revert OddsChanged(o, minOdds);
        _checkResponsibleGambling(msg.sender, stake);

        uint128 payout = uint128((uint256(stake) * o) / 100);
        uint256 freeBefore = treasury.freeBalance();
        usdg.safeTransferFrom(msg.sender, address(treasury), stake);

        b.selectionPayout[selection] += payout;
        uint256 worst = 0;
        for (uint256 i = 0; i < OddraMarkets.SCENARIOS; i++) {
            uint128 v = b.scenarioPayout[i];
            if ((scenarioMask(i) >> selection) & 1 == 1) {
                v += payout;
                b.scenarioPayout[i] = v;
            }
            if (v > worst) worst = v;
        }
        b.totalStakes += stake;
        uint256 required = worst > b.totalStakes ? worst : b.totalStakes; // refunds must be covered too
        uint256 delta = required - b.reserved;

        risk.check(
            stake,
            payout,
            b.selectionPayout[selection],
            required,
            freeBefore,
            treasury.balance(),
            treasury.totalReserved() + delta
        );
        treasury.recordStake(stake);
        if (delta > 0) treasury.reserve(delta);
        b.reserved = uint128(required);

        betId = _bets.length;
        _bets.push(
            Bet({
                bettor: msg.sender,
                matchId: uint64(matchId),
                selection: selection,
                odds: o,
                paid: false,
                stake: stake,
                payout: payout,
                placedAt: uint64(block.timestamp)
            })
        );
        _betsOf[msg.sender].push(betId);
        emit BetPlaced(betId, matchId, msg.sender, selection, stake, o, payout);
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Close a match's book after the registry has settled or voided it. Anyone may call; idempotent.
    function settleBook(uint256 matchId) public {
        Book storage b = _books[matchId];
        if (b.settled || b.voided) return;
        OddraMatchRegistry.Match memory m = registry.getMatch(matchId);
        if (m.status == OddraMatchRegistry.Status.Settled) {
            uint32 mask = OddraMarkets.winMask(m.homeGoals, m.awayGoals, m.firstScorer);
            uint256 owed = 0;
            for (uint256 s = 0; s < OddraMarkets.SELECTIONS; s++) {
                if ((mask >> s) & 1 == 1) owed += b.selectionPayout[s];
            }
            uint256 released = b.reserved - owed;
            b.settled = true;
            b.winMask = mask;
            b.owed = uint128(owed);
            b.reserved = uint128(owed);
            if (released > 0) treasury.release(released);
            emit BookSettled(matchId, mask, owed, released);
        } else if (m.status == OddraMatchRegistry.Status.Voided) {
            uint256 refunds = b.totalStakes;
            uint256 released = b.reserved - refunds;
            b.voided = true;
            b.owed = uint128(refunds);
            b.reserved = uint128(refunds);
            if (released > 0) treasury.release(released);
            emit BookVoided(matchId, refunds, released);
        } else {
            revert NotSettled();
        }
    }

    /// @notice Pay a winning or refunded bet to its bettor. Anyone may call; the money always goes to the bettor.
    function claim(uint256 betId) external nonReentrant {
        Bet storage bet = _bets[betId];
        if (bet.paid) revert AlreadyPaid();
        settleBook(bet.matchId);
        uint256 amount = claimable(betId);
        if (amount == 0) revert NothingToClaim();
        _markPaid(bet, amount);
        treasury.pay(bet.bettor, amount);
        emit Claimed(betId, bet.bettor, amount, msg.sender);
    }

    /// @notice Automatic payouts. Skips anything not payable; a failed transfer leaves that bet claimable.
    function payoutBatch(uint256[] calldata betIds) external nonReentrant returns (uint256 paid) {
        for (uint256 k = 0; k < betIds.length; k++) {
            uint256 betId = betIds[k];
            if (betId >= _bets.length) continue;
            Bet storage bet = _bets[betId];
            if (bet.paid) continue;
            Book storage b = _books[bet.matchId];
            if (!b.settled && !b.voided) {
                OddraMatchRegistry.Status s = registry.status(bet.matchId);
                if (s != OddraMatchRegistry.Status.Settled && s != OddraMatchRegistry.Status.Voided) continue;
                settleBook(bet.matchId);
            }
            uint256 amount = claimable(betId);
            if (amount == 0) continue;
            _markPaid(bet, amount);
            try treasury.pay(bet.bettor, amount) {
                paid++;
                emit Claimed(betId, bet.bettor, amount, msg.sender);
            } catch {
                bet.paid = false;
                b.owed += uint128(amount);
                b.reserved += uint128(amount);
                emit PayoutFailed(betId, bet.bettor, amount);
            }
        }
    }

    function _markPaid(Bet storage bet, uint256 amount) private {
        Book storage b = _books[bet.matchId];
        bet.paid = true;
        b.owed -= uint128(amount);
        b.reserved -= uint128(amount);
    }

    // ------------------------------------------------------------------ responsible gambling

    /// @notice Block yourself from betting. Can be extended, never shortened.
    function selfExclude(uint64 duration) external {
        uint64 until = uint64(block.timestamp) + duration;
        if (until > excludedUntil[msg.sender]) excludedUntil[msg.sender] = until;
        emit SelfExcluded(msg.sender, excludedUntil[msg.sender]);
    }

    /// @notice Daily stake limit. Lowering applies at once; raising or removing (0) applies after 24 hours.
    function setDailyLimit(uint128 limit) external {
        _applyPendingLimit(msg.sender);
        uint128 current = dailyLimit[msg.sender];
        bool lowering = limit != 0 && (current == 0 || limit <= current);
        if (lowering) {
            dailyLimit[msg.sender] = limit;
            pendingDailyLimitAt[msg.sender] = 0;
            emit DailyLimitSet(msg.sender, limit, uint64(block.timestamp));
        } else {
            uint64 at = uint64(block.timestamp + LIMIT_INCREASE_DELAY);
            pendingDailyLimit[msg.sender] = limit;
            pendingDailyLimitAt[msg.sender] = at;
            emit DailyLimitSet(msg.sender, limit, at);
        }
    }

    function _applyPendingLimit(address who) private {
        uint64 at = pendingDailyLimitAt[who];
        if (at != 0 && block.timestamp >= at) {
            dailyLimit[who] = pendingDailyLimit[who];
            pendingDailyLimitAt[who] = 0;
        }
    }

    function _checkResponsibleGambling(address who, uint128 stake) private {
        if (block.timestamp < excludedUntil[who]) revert Excluded(excludedUntil[who]);
        _applyPendingLimit(who);
        uint256 day = block.timestamp / 1 days;
        uint128 staked = stakedOnDay[who][day] + stake;
        uint128 limit = dailyLimit[who];
        if (limit != 0 && staked > limit) revert DailyLimitExceeded(limit);
        stakedOnDay[who][day] = staked;
    }
}
