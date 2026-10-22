// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OddraMarkets} from "./OddraMarkets.sol";
import {OddraMatchRegistry} from "./OddraMatchRegistry.sol";

interface IExchangeEligibility {
    function isEligible(address who) external view returns (bool);
}

/// @title OddraExchange
/// @notice Peer-to-peer betting exchange on Oddra matches. There is no house: every bet has a counterparty.
///
///  - A BACK bets that a selection wins; a LAY bets that it does not.
///  - A maker posts an offer at decimal odds `o` (× 100). Amounts are always in *backer stake*:
///      • LAY offer: "I will lay up to `amount` of backers' stake at odds o" — the maker escrows the liability,
///        amount × (o − 1).
///      • BACK offer: "I will back with `amount` at odds o" — the maker escrows the stake.
///  - A taker fills part or all of an offer, escrowing the other side. Each fill creates a position holding both
///    sides' funds. Offers and fills are only possible during the betting window; unmatched amounts are returned to
///    the maker on cancellation or after kickoff.
///  - When the registry settles the match, the winning side of each position receives the whole position (stake +
///    liability) minus commission on its net winnings; if the match is voided both sides get their own funds back.
///  - Positions are paid by `claim` (anyone may trigger; funds always go to the owner) or in keeper batches where a
///    failed transfer simply leaves the position claimable.
///  - Each offer and position is in one asset: USDG or native ETH (`ETH = address(0)`).
contract OddraExchange is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    address public constant ETH = address(0);
    uint32 public constant MIN_ODDS = 101; // 1.01
    uint32 public constant MAX_ODDS = 100_000; // 1000.00
    uint16 public constant MAX_COMMISSION_BPS = 500; // 5%
    uint256 public constant LIMIT_INCREASE_DELAY = 1 days;

    enum Side {
        Back,
        Lay
    }

    struct Offer {
        address maker;
        uint64 matchId;
        uint8 selection;
        Side side;
        uint32 odds;
        bool closed; // cancelled or reclaimed
        address asset;
        uint128 amount; // original backer-stake amount
        uint128 remaining; // backer-stake amount still available
        uint128 escrow; // maker funds still held for the unmatched part
    }

    struct Position {
        address backer;
        uint64 matchId;
        uint8 selection;
        uint32 odds;
        bool backerPaid;
        address layer;
        bool layerPaid;
        address asset;
        uint128 stake; // backer's stake
        uint128 liability; // layer's liability
        uint64 offerId;
    }

    IERC20 public immutable usdg;
    OddraMatchRegistry public immutable registry;
    IExchangeEligibility public eligibility;

    uint16 public commissionBps = 200;
    mapping(address asset => uint128) public minAmount; // smallest backer-stake per offer / fill
    mapping(address asset => uint256) public accruedFees;
    mapping(address asset => uint256) public totalMatched; // backer stake matched
    mapping(address asset => uint256) public totalEscrowed; // everything this contract owes users

    /// @notice Informational fair odds from the engine (× 100). Never used for matching.
    mapping(uint256 => uint32[30]) private _reference;

    Offer[] private _offers;
    Position[] private _positions;
    mapping(address => uint256[]) private _offersOf;
    mapping(address => uint256[]) private _positionsOf;
    mapping(uint256 => uint256[]) private _offersOfMatch;
    mapping(uint256 => uint256[]) private _positionsOfMatch;

    mapping(address => uint64) public excludedUntil;
    mapping(address => mapping(address => uint128)) public dailyLimit; // who => asset => max at-risk per day
    mapping(address => mapping(address => uint128)) public pendingDailyLimit;
    mapping(address => mapping(address => uint64)) public pendingDailyLimitAt;
    mapping(address => mapping(address => mapping(uint256 => uint128))) public riskedOnDay;

    event OfferPlaced(
        uint256 indexed offerId,
        uint256 indexed matchId,
        address indexed maker,
        uint8 selection,
        Side side,
        uint32 odds,
        uint256 amount,
        address asset
    );
    event OfferClosed(uint256 indexed offerId, address indexed maker, uint256 refunded, bool cancelled);
    event Matched(
        uint256 indexed positionId,
        uint256 indexed offerId,
        uint256 indexed matchId,
        address backer,
        address layer,
        uint8 selection,
        uint32 odds,
        uint256 stake,
        uint256 liability,
        address asset
    );
    event Paid(uint256 indexed positionId, address indexed to, Side side, uint256 amount, uint256 fee, address asset);
    event PayoutFailed(uint256 indexed positionId, address indexed to, uint256 amount, address asset);
    event ReferenceOddsPublished(uint256 indexed matchId, uint32[30] odds);
    event CommissionSet(uint16 bps);
    event MinAmountSet(address indexed asset, uint128 amount);
    event FeesWithdrawn(address indexed asset, address to, uint256 amount);
    event SelfExcluded(address indexed who, uint64 until);
    event DailyLimitSet(address indexed who, address indexed asset, uint128 limit, uint64 effectiveAt);

    error UnsupportedAsset();
    error BadSelection();
    error BadOdds();
    error BadAmount();
    error BadValue();
    error MarketClosed();
    error StillOpen();
    error OfferUnavailable();
    error SelfMatch();
    error NotMaker();
    error NotSettled();
    error NothingToClaim();
    error Excluded(uint64 until);
    error NotEligible();
    error DailyLimitExceeded(uint128 limit);
    error BadParams();

    constructor(address admin, IERC20 token, OddraMatchRegistry registry_, uint128 minUsdg, uint128 minEth)
        AccessControlDefaultAdminRules(1 days, admin)
    {
        usdg = token;
        registry = registry_;
        minAmount[address(token)] = minUsdg;
        minAmount[ETH] = minEth;
    }

    // ------------------------------------------------------------------ views

    function offerCount() external view returns (uint256) {
        return _offers.length;
    }

    function positionCount() external view returns (uint256) {
        return _positions.length;
    }

    function getOffer(uint256 id) external view returns (Offer memory) {
        return _offers[id];
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    function offersOf(address who) external view returns (uint256[] memory) {
        return _offersOf[who];
    }

    function positionsOf(address who) external view returns (uint256[] memory) {
        return _positionsOf[who];
    }

    function offersOfMatch(uint256 matchId) external view returns (uint256[] memory) {
        return _offersOfMatch[matchId];
    }

    function positionsOfMatch(uint256 matchId) external view returns (uint256[] memory) {
        return _positionsOfMatch[matchId];
    }

    function referenceOdds(uint256 matchId) external view returns (uint32[30] memory) {
        return _reference[matchId];
    }

    /// @notice Every offer of a match in one call (for the order book).
    function matchOffers(uint256 matchId) external view returns (uint256[] memory ids, Offer[] memory list) {
        ids = _offersOfMatch[matchId];
        list = new Offer[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            list[i] = _offers[ids[i]];
        }
    }

    function isOpen(uint256 matchId) public view returns (bool) {
        OddraMatchRegistry.Match memory m = registry.getMatch(matchId);
        return m.status == OddraMatchRegistry.Status.Scheduled && block.timestamp >= m.openTime
            && block.timestamp < m.kickoff && !paused();
    }

    /// @notice Liability for laying `stake` at `odds`: stake × (odds − 1), rounded up in the backer's favour.
    function liabilityFor(uint256 stake, uint32 odds) public pure returns (uint128) {
        return uint128((stake * (odds - 100) + 99) / 100);
    }

    /// @notice What `owner` would receive from a position now (0 if nothing), after commission.
    function claimable(uint256 positionId, address owner) public view returns (uint256 amount, uint256 fee, Side side) {
        Position storage p = _positions[positionId];
        OddraMatchRegistry.Status s = registry.status(p.matchId);
        bool isBacker = owner == p.backer;
        bool isLayer = owner == p.layer;
        if (!isBacker && !isLayer) return (0, 0, Side.Back);
        if (s == OddraMatchRegistry.Status.Voided) {
            if (isBacker && !p.backerPaid) return (p.stake, 0, Side.Back);
            if (isLayer && !p.layerPaid) return (p.liability, 0, Side.Lay);
            return (0, 0, Side.Back);
        }
        if (s != OddraMatchRegistry.Status.Settled) return (0, 0, Side.Back);
        OddraMatchRegistry.Match memory m = registry.getMatch(p.matchId);
        bool backWins = (OddraMarkets.winMask(m.homeGoals, m.awayGoals, m.firstScorer) >> p.selection) & 1 == 1;
        uint256 pot = uint256(p.stake) + p.liability;
        if (backWins && isBacker && !p.backerPaid) {
            fee = (uint256(p.liability) * commissionBps) / 10_000;
            return (pot - fee, fee, Side.Back);
        }
        if (!backWins && isLayer && !p.layerPaid) {
            fee = (uint256(p.stake) * commissionBps) / 10_000;
            return (pot - fee, fee, Side.Lay);
        }
        return (0, 0, Side.Back);
    }

    // ------------------------------------------------------------------ making and taking

    /// @notice Post an offer. Send ETH as value for ETH offers; approve USDG first for USDG offers.
    function placeOffer(uint256 matchId, uint8 selection, Side side, uint32 odds, uint128 amount, address asset)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 offerId)
    {
        _checkMarket(matchId, selection, odds, amount, asset);
        uint128 escrow = side == Side.Lay ? liabilityFor(amount, odds) : amount;
        _checkPlayer(msg.sender, asset, escrow);
        _collect(asset, escrow);
        offerId = _offers.length;
        _offers.push(
            Offer({
                maker: msg.sender,
                matchId: uint64(matchId),
                selection: selection,
                side: side,
                odds: odds,
                closed: false,
                asset: asset,
                amount: amount,
                remaining: amount,
                escrow: escrow
            })
        );
        _offersOf[msg.sender].push(offerId);
        _offersOfMatch[matchId].push(offerId);
        emit OfferPlaced(offerId, matchId, msg.sender, selection, side, odds, amount, asset);
    }

    /// @notice Fill `amount` (backer stake) of an offer. Taking a LAY offer backs the selection (send/approve the
    ///         stake); taking a BACK offer lays it (send/approve the liability).
    function take(uint256 offerId, uint128 amount) external payable nonReentrant whenNotPaused returns (uint256) {
        uint256 positionId = _take(offerId, amount, msg.value);
        return positionId;
    }

    /// @notice Fill several offers in one transaction, best first. For ETH, `msg.value` must equal the sum due.
    function takeMany(uint256[] calldata offerIds, uint128[] calldata amounts)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256[] memory positionIds)
    {
        if (offerIds.length != amounts.length || offerIds.length == 0) revert BadParams();
        positionIds = new uint256[](offerIds.length);
        uint256 valueLeft = msg.value;
        for (uint256 i = 0; i < offerIds.length; i++) {
            Offer storage o = _offers[offerIds[i]];
            uint256 due = o.asset == ETH ? (o.side == Side.Lay ? amounts[i] : liabilityFor(amounts[i], o.odds)) : 0;
            if (due > valueLeft) revert BadValue();
            valueLeft -= due;
            positionIds[i] = _take(offerIds[i], amounts[i], due);
        }
        if (valueLeft != 0) revert BadValue();
    }

    function _take(uint256 offerId, uint128 amount, uint256 value) private returns (uint256 positionId) {
        if (offerId >= _offers.length) revert OfferUnavailable();
        Offer storage o = _offers[offerId];
        if (o.closed || o.remaining == 0) revert OfferUnavailable();
        if (o.maker == msg.sender) revert SelfMatch();
        if (!isOpen(o.matchId)) revert MarketClosed();
        if (amount == 0 || amount > o.remaining) revert BadAmount();
        // a partial fill may not leave a dust remainder nobody can take
        if (amount < minAmount[o.asset] && amount != o.remaining) revert BadAmount();

        uint128 liability = liabilityFor(amount, o.odds);
        bool takerBacks = o.side == Side.Lay;
        uint128 takerPays = takerBacks ? amount : liability;
        _checkPlayer(msg.sender, o.asset, takerPays);
        if (o.asset == ETH) {
            if (value != takerPays) revert BadValue();
            totalEscrowed[ETH] += takerPays;
        } else {
            if (value != 0) revert BadValue();
            usdg.safeTransferFrom(msg.sender, address(this), takerPays);
            totalEscrowed[o.asset] += takerPays;
        }

        // release the matched part of the maker's escrow into the position: partial fills of a lay offer round the
        // maker's liability down (so their sum never exceeds the escrow, which was rounded up); the final fill takes
        // whatever is left
        uint128 makerPart = takerBacks ? uint128((uint256(amount) * (o.odds - 100)) / 100) : amount;
        if (o.remaining == amount) makerPart = o.escrow;
        o.remaining -= amount;
        o.escrow -= makerPart;

        positionId = _positions.length;
        address backer = takerBacks ? msg.sender : o.maker;
        address layer = takerBacks ? o.maker : msg.sender;
        uint128 stake = takerBacks ? amount : makerPart;
        uint128 posLiability = takerBacks ? makerPart : liability;
        _positions.push(
            Position({
                backer: backer,
                matchId: o.matchId,
                selection: o.selection,
                odds: o.odds,
                backerPaid: false,
                layer: layer,
                layerPaid: false,
                asset: o.asset,
                stake: stake,
                liability: posLiability,
                offerId: uint64(offerId)
            })
        );
        _positionsOf[backer].push(positionId);
        _positionsOf[layer].push(positionId);
        _positionsOfMatch[o.matchId].push(positionId);
        totalMatched[o.asset] += stake;
        emit Matched(positionId, offerId, o.matchId, backer, layer, o.selection, o.odds, stake, posLiability, o.asset);
    }

    /// @notice Withdraw the unmatched part of your offer. Allowed any time; after kickoff anyone may trigger it and
    ///         the funds still go to the maker.
    function cancel(uint256 offerId) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.closed) revert OfferUnavailable();
        bool marketLive = isOpen(o.matchId);
        if (marketLive && msg.sender != o.maker) revert NotMaker();
        _closeOffer(offerId, marketLive);
    }

    /// @notice Return unmatched funds of many offers to their makers once their markets have closed (keeper).
    function reclaimBatch(uint256[] calldata offerIds) external nonReentrant returns (uint256 n) {
        for (uint256 i = 0; i < offerIds.length; i++) {
            if (offerIds[i] >= _offers.length) continue;
            Offer storage o = _offers[offerIds[i]];
            if (o.closed || isOpen(o.matchId)) continue;
            OddraMatchRegistry.Match memory m = registry.getMatch(o.matchId);
            if (m.status == OddraMatchRegistry.Status.Scheduled && block.timestamp < m.kickoff) continue;
            if (_closeOffer(offerIds[i], false)) n++;
        }
    }

    function _closeOffer(uint256 offerId, bool cancelled) private returns (bool sent) {
        Offer storage o = _offers[offerId];
        uint128 refund = o.escrow;
        o.closed = true;
        o.escrow = 0;
        o.remaining = 0;
        if (refund == 0) {
            emit OfferClosed(offerId, o.maker, 0, cancelled);
            return true;
        }
        totalEscrowed[o.asset] -= refund;
        sent = _send(o.asset, o.maker, refund);
        if (!sent) {
            // keep the funds owed: reopen the escrow so a later reclaim can retry
            o.closed = false;
            o.escrow = refund;
            totalEscrowed[o.asset] += refund;
            if (cancelled) revert BadValue();
            return false;
        }
        emit OfferClosed(offerId, o.maker, refund, cancelled);
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Pay `owner`'s side of a position. Anyone may call; funds always go to the owner.
    function claim(uint256 positionId, address owner) external nonReentrant {
        if (!_pay(positionId, owner)) revert NothingToClaim();
    }

    /// @notice Keeper batch: pays both sides of every position where something is due. Failed transfers stay claimable.
    function payoutBatch(uint256[] calldata positionIds) external nonReentrant returns (uint256 paid) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            if (positionIds[i] >= _positions.length) continue;
            Position storage p = _positions[positionIds[i]];
            if (_pay(positionIds[i], p.backer)) paid++;
            if (_pay(positionIds[i], p.layer)) paid++;
        }
    }

    function _pay(uint256 positionId, address owner) private returns (bool) {
        (uint256 amount, uint256 fee, Side side) = claimable(positionId, owner);
        if (amount == 0) return false;
        Position storage p = _positions[positionId];
        if (side == Side.Back) p.backerPaid = true;
        else p.layerPaid = true;
        // the losing side is settled implicitly: its funds went to the winner
        bool voided = registry.status(p.matchId) == OddraMatchRegistry.Status.Voided;
        if (!voided) {
            if (side == Side.Back) p.layerPaid = true;
            else p.backerPaid = true;
        }
        totalEscrowed[p.asset] -= amount + fee;
        accruedFees[p.asset] += fee;
        if (!_send(p.asset, owner, amount)) {
            // undo so the owner can claim later
            if (side == Side.Back) p.backerPaid = false;
            else p.layerPaid = false;
            if (!voided) {
                if (side == Side.Back) p.layerPaid = false;
                else p.backerPaid = false;
            }
            totalEscrowed[p.asset] += amount + fee;
            accruedFees[p.asset] -= fee;
            emit PayoutFailed(positionId, owner, amount, p.asset);
            return false;
        }
        emit Paid(positionId, owner, side, amount, fee, p.asset);
        return true;
    }

    // ------------------------------------------------------------------ admin

    function publishReferenceOdds(uint256 matchId, uint32[30] calldata odds) external onlyRole(OPERATOR_ROLE) {
        _reference[matchId] = odds;
        emit ReferenceOddsPublished(matchId, odds);
    }

    function setCommission(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_COMMISSION_BPS) revert BadParams();
        commissionBps = bps;
        emit CommissionSet(bps);
    }

    function setMinAmount(address asset, uint128 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (asset != ETH && asset != address(usdg)) revert UnsupportedAsset();
        minAmount[asset] = amount;
        emit MinAmountSet(asset, amount);
    }

    function setEligibility(IExchangeEligibility e) external onlyRole(DEFAULT_ADMIN_ROLE) {
        eligibility = e;
    }

    /// @notice Withdraw accrued commission. Only commission: user escrow is never reachable.
    function withdrawFees(address asset, address to) external onlyRole(TREASURER_ROLE) nonReentrant {
        uint256 amount = accruedFees[asset];
        accruedFees[asset] = 0;
        if (!_send(asset, to, amount)) revert BadValue();
        emit FeesWithdrawn(asset, to, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------ responsible gambling

    function selfExclude(uint64 duration) external {
        uint64 until = uint64(block.timestamp) + duration;
        if (until > excludedUntil[msg.sender]) excludedUntil[msg.sender] = until;
        emit SelfExcluded(msg.sender, excludedUntil[msg.sender]);
    }

    /// @notice Daily limit on funds put at risk (stakes and liabilities) per asset. Lowering is immediate; raising or
    ///         removing (0) waits 24 hours.
    function setDailyLimit(address asset, uint128 limit) external {
        _applyPending(msg.sender, asset);
        uint128 current = dailyLimit[msg.sender][asset];
        if (limit != 0 && (current == 0 || limit <= current)) {
            dailyLimit[msg.sender][asset] = limit;
            pendingDailyLimitAt[msg.sender][asset] = 0;
            emit DailyLimitSet(msg.sender, asset, limit, uint64(block.timestamp));
        } else {
            uint64 at = uint64(block.timestamp + LIMIT_INCREASE_DELAY);
            pendingDailyLimit[msg.sender][asset] = limit;
            pendingDailyLimitAt[msg.sender][asset] = at;
            emit DailyLimitSet(msg.sender, asset, limit, at);
        }
    }

    function _applyPending(address who, address asset) private {
        uint64 at = pendingDailyLimitAt[who][asset];
        if (at != 0 && block.timestamp >= at) {
            dailyLimit[who][asset] = pendingDailyLimit[who][asset];
            pendingDailyLimitAt[who][asset] = 0;
        }
    }

    // ------------------------------------------------------------------ internals

    function _checkMarket(uint256 matchId, uint8 selection, uint32 odds, uint128 amount, address asset) private view {
        if (asset != ETH && asset != address(usdg)) revert UnsupportedAsset();
        if (selection >= OddraMarkets.SELECTIONS) revert BadSelection();
        if (odds < MIN_ODDS || odds > MAX_ODDS) revert BadOdds();
        if (amount == 0 || amount < minAmount[asset]) revert BadAmount();
        if (!isOpen(matchId)) revert MarketClosed();
    }

    function _checkPlayer(address who, address asset, uint128 atRisk) private {
        if (block.timestamp < excludedUntil[who]) revert Excluded(excludedUntil[who]);
        if (address(eligibility) != address(0) && !eligibility.isEligible(who)) revert NotEligible();
        _applyPending(who, asset);
        uint256 day = block.timestamp / 1 days;
        uint128 risked = riskedOnDay[who][asset][day] + atRisk;
        uint128 limit = dailyLimit[who][asset];
        if (limit != 0 && risked > limit) revert DailyLimitExceeded(limit);
        riskedOnDay[who][asset][day] = risked;
    }

    function _collect(address asset, uint128 amount) private {
        if (asset == ETH) {
            if (msg.value != amount) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            usdg.safeTransferFrom(msg.sender, address(this), amount);
        }
        totalEscrowed[asset] += amount;
    }

    function _send(address asset, address to, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        if (asset == ETH) {
            (bool ok,) = to.call{value: amount}("");
            return ok;
        }
        return usdg.trySafeTransfer(to, amount);
    }
}
