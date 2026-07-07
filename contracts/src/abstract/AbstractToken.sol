// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IToken} from "../interfaces/IToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@solady/contracts/auth/Ownable.sol";
import {
    ERC20VotesUpgradeable,
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";

/// @notice Minimal ERC-7572 reader — the distribution manager holds the instance metadata.
interface IContractURI {
    function contractURI() external view returns (string memory);
}

/// @title AbstractToken
/// @author BreadKit
/// @notice Abstract base contract for yield-bearing ERC20 tokens with voting delegation
/// @dev Extends ERC20VotesUpgradeable with yield claiming, a two-phase yield claimer transfer
///      mechanism (14-day timelock), automatic delegation on transfers/mints, and per-holder
///      yield splits (each holder chooses how much of their yield share to keep vs donate).
///      Inheriting contracts must implement _deposit, _remit, and _yieldAccrued.
abstract contract AbstractToken is ERC20VotesUpgradeable, Ownable, IToken {
    /// @notice Thrown when attempting to mint zero tokens
    error MintZero();
    /// @notice Thrown when attempting to burn zero tokens
    error BurnZero();
    /// @notice Thrown when attempting to claim zero yield
    error ClaimZero();
    /// @notice Thrown when claimed amount exceeds available yield
    error YieldInsufficient();
    /// @notice Thrown when a non-claimer address attempts to claim yield
    error OnlyClaimer();
    /// @notice Thrown when a yield split exceeds 100% (10,000 bps)
    error InvalidYieldSplit();
    /// @notice Thrown when finalizing with no pending claimer
    error NoPendingClaimer();
    /// @notice Thrown when preparing a new claimer while one is already pending
    error PendingClaimer();
    /// @notice Thrown when finalizing before the 14-day timelock has elapsed
    error TimelockNotElapsed();
    /// @notice Thrown when setting yield claimer after it has already been set
    error AlreadySetClaimer();
    /// @notice Thrown when preparing a new claimer that matches the current one
    error SameClaimer();
    /// @notice Thrown when a native ETH transfer fails
    error NativeTransferFailed();
    /// @notice Thrown when a zero address is provided
    error ZeroAddress();

    // ============ EIP-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:crowdstake.storage.AbstractToken
    struct AbstractTokenStorage {
        /// @notice Address authorized to claim accrued yield
        address yieldClaimer;
        /// @notice Address awaiting timelock to become the new yield claimer
        address pendingYieldClaimer;
        /// @notice Timestamp after which the pending yield claimer can be finalized
        uint256 pendingFinishedAt;
    }

    // keccak256(abi.encode(uint256(keccak256("crowdstake.storage.AbstractToken")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ABSTRACT_TOKEN_STORAGE =
        0x6746ae24d567a69cac363d4ed8572608d7aa218bd671c5a748fb340bd7db1000;

    function _getAbstractTokenStorage() internal pure returns (AbstractTokenStorage storage $) {
        assembly {
            $.slot := ABSTRACT_TOKEN_STORAGE
        }
    }

    // ============ Yield Split Storage ============

    /// @notice Basis-points denominator for yield splits (100% = 10,000)
    uint256 public constant YIELD_SPLIT_BPS = 10_000;

    /// @dev Precision scale for the yield-per-token accumulator. High enough that the
    ///      truncation lost per accrual (supply / YIELD_PRECISION wei) stays sub-wei for
    ///      any realistic supply; any dust lands in the donated pool.
    uint256 private constant YIELD_PRECISION = 1e27;

    /// @custom:storage-location erc7201:crowdstake.storage.YieldSplit
    struct YieldSplitStorage {
        /// @notice Cumulative yield attributed per token, scaled by YIELD_PRECISION
        uint256 accYieldPerToken;
        /// @notice Raw yield already pushed through the accumulator (falls when claims mint)
        uint256 accountedYield;
        /// @notice Sum of balance * keepBps over all holders with a nonzero split
        uint256 keepWeight;
        /// @notice Sum of balance * keepBps * index over the same holders
        uint256 keepWeightIndex;
        /// @notice Total settled kept yield awaiting claims
        uint256 keptYieldTotal;
        /// @notice Share of each holder's yield they keep, in bps (default 0 = donate all)
        mapping(address => uint16) keepBps;
        /// @notice accYieldPerToken at each holder's last settlement
        mapping(address => uint256) index;
        /// @notice Settled, claimable kept yield per holder
        mapping(address => uint256) keptYield;
    }

    // keccak256(abi.encode(uint256(keccak256("crowdstake.storage.YieldSplit")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant YIELD_SPLIT_STORAGE = 0xf738586bf43cceca564b7190bdeb6371d7e569504429f728e4554e1d8c5e6400;

    function _getYieldSplitStorage() internal pure returns (YieldSplitStorage storage $) {
        assembly {
            $.slot := YIELD_SPLIT_STORAGE
        }
    }

    // ============ Public Getters ============

    /// @notice Returns the current yield claimer address
    function yieldClaimer() public view returns (address) {
        return _getAbstractTokenStorage().yieldClaimer;
    }

    /// @notice ERC-7572 contract-level metadata, pulled from the instance's
    ///         distribution manager (which is this token's yield claimer). Lets
    ///         wallets/explorers show the instance's token image without the
    ///         token storing metadata itself. Returns "" if unavailable.
    function contractURI() external view returns (string memory) {
        address claimer = _getAbstractTokenStorage().yieldClaimer;
        if (claimer == address(0)) return "";
        try IContractURI(claimer).contractURI() returns (string memory uri) {
            return uri;
        } catch {
            return "";
        }
    }

    /// @notice Returns the address awaiting timelock to become the new yield claimer
    function pendingYieldClaimer() public view returns (address) {
        return _getAbstractTokenStorage().pendingYieldClaimer;
    }

    /// @notice Returns the timestamp after which the pending yield claimer can be finalized
    function pendingFinishedAt() public view returns (uint256) {
        return _getAbstractTokenStorage().pendingFinishedAt;
    }

    // ============ Events ============

    /// @notice Emitted when tokens are minted to a receiver
    event Minted(address receiver, uint256 amount);
    /// @notice Emitted when tokens are burned for a receiver
    event Burned(address receiver, uint256 amount);
    /// @notice Emitted when the yield claimer is set or updated
    event YieldClaimerSet(address yieldClaimer);
    /// @notice Emitted when a new pending yield claimer is proposed
    event PendingYieldClaimerSet(address yieldClaimer);
    /// @notice Emitted when yield is claimed
    event ClaimedYield(uint256 amount);
    /// @notice Emitted when a holder updates their yield split
    event YieldSplitSet(address indexed account, uint16 keepBps);
    /// @notice Emitted when a holder claims their kept yield
    event KeptYieldClaimed(address indexed account, address receiver, uint256 amount);

    /// @dev MUST implement in derived contract
    /// logic to deposit user collateral into yield bearing position
    function _deposit(
        uint256 /*amount_*/
    )
        internal
        virtual {}

    /// @dev OPTIONAL to implement in derived contract
    /// logic to deposit native token into yield bearing position
    function _depositNative(
        uint256 /*amount_*/
    )
        internal
        virtual
    {
        revert("native deposits not supported");
    }

    /// @dev MUST implement in derived contract
    /// logic to remit collateral value to user
    function _remit(
        address,
        /*receiver_*/
        uint256 /*amount_*/
    )
        internal
        virtual {}

    /// @dev MUST implement in derived contract
    /// logic to calculate unclaimed accrued yield
    function _yieldAccrued() internal view virtual returns (uint256) {}

    /// @notice Mints tokens to the receiver by depositing the specified amount of collateral
    /// @param receiver_ Address to receive the minted tokens
    /// @param amount_ Amount of collateral to deposit and tokens to mint
    function mint(address receiver_, uint256 amount_) external virtual {
        if (amount_ == 0) revert MintZero();

        _mintAndDelegate(receiver_, amount_);

        _deposit(amount_);
    }

    /// @notice Mints tokens to the receiver by depositing native ETH
    /// @param receiver_ Address to receive the minted tokens
    function mint(address receiver_) external payable virtual {
        if (msg.value == 0) revert MintZero();

        _mintAndDelegate(receiver_, msg.value);

        _depositNative(msg.value);
    }

    /// @notice Burns tokens from the caller and remits the underlying collateral to the receiver
    /// @param amount_ Amount of tokens to burn
    /// @param receiver_ Address to receive the underlying collateral
    function burn(uint256 amount_, address receiver_) external virtual {
        if (amount_ == 0) revert BurnZero();
        _burn(msg.sender, amount_);

        _remit(receiver_, amount_);

        emit Burned(receiver_, amount_);
    }

    /// @notice Claims accrued donated yield and mints it as tokens to the receiver
    /// @dev Only callable by the authorized yield claimer. Only the donated portion of the
    ///      vault surplus is claimable here; holders' kept shares stay reserved for them.
    /// @param amount_ Amount of yield to claim
    /// @param receiver_ Address to receive the minted yield tokens
    function claimYield(uint256 amount_, address receiver_) external virtual {
        AbstractTokenStorage storage $ = _getAbstractTokenStorage();
        if (msg.sender != $.yieldClaimer) revert OnlyClaimer();
        if (amount_ == 0) revert ClaimZero();
        _accrueGlobalYield();
        uint256 yield = _donatedYieldAccrued();
        if (yield == 0) revert YieldInsufficient();
        if (yield < amount_) revert YieldInsufficient();

        _mint(receiver_, amount_);
        if (this.delegates(receiver_) == address(0)) _delegate(receiver_, receiver_);
        // The minted claim consumed vault surplus; keep the high-water mark in sync.
        _getYieldSplitStorage().accountedYield -= amount_;

        emit ClaimedYield(amount_);
    }

    // ============ Yield Split ============

    /// @notice Sets the caller's yield split: the share of their yield they keep for themselves
    /// @dev Applies from now on — yield attributed before this call keeps the previous split.
    /// @param keepBps_ Basis points (0–10,000) of the caller's yield share to keep; the rest is donated
    function setYieldSplit(uint16 keepBps_) external {
        if (keepBps_ > YIELD_SPLIT_BPS) revert InvalidYieldSplit();
        YieldSplitStorage storage $ = _getYieldSplitStorage();
        _accrueGlobalYield();
        _settleAndDetach(msg.sender);
        // Re-baseline so only yield accrued after this change uses the new split.
        $.index[msg.sender] = $.accYieldPerToken;
        $.keepBps[msg.sender] = keepBps_;
        _attach(msg.sender);

        emit YieldSplitSet(msg.sender, keepBps_);
    }

    /// @notice Returns the share of their yield an account keeps, in bps (0 = donates all)
    function yieldSplitOf(address account_) external view returns (uint16) {
        return _getYieldSplitStorage().keepBps[account_];
    }

    /// @notice Returns an account's kept yield: settled balance plus unsettled share at its current split
    function keptYieldOf(address account_) external view returns (uint256) {
        YieldSplitStorage storage $ = _getYieldSplitStorage();
        uint256 kept = $.keptYield[account_];
        uint256 bps = $.keepBps[account_];
        if (bps == 0) return kept;
        uint256 acc = _simulatedAccYieldPerToken();
        uint256 idx = $.index[account_];
        if (acc > idx) {
            kept += balanceOf(account_) * (acc - idx) / YIELD_PRECISION * bps / YIELD_SPLIT_BPS;
        }
        return kept;
    }

    /// @notice Claims the caller's kept yield, minting it as tokens to the receiver
    /// @param receiver_ Address to receive the minted yield tokens
    function claimKeptYield(address receiver_) external {
        YieldSplitStorage storage $ = _getYieldSplitStorage();
        _accrueGlobalYield();
        _settleAndDetach(msg.sender);
        _attach(msg.sender);

        uint256 amount = $.keptYield[msg.sender];
        if (amount == 0) revert ClaimZero();
        if (_yieldAccrued() < amount) revert YieldInsufficient();
        $.keptYield[msg.sender] = 0;
        $.keptYieldTotal -= amount;

        _mint(receiver_, amount);
        if (this.delegates(receiver_) == address(0)) _delegate(receiver_, receiver_);
        // The minted claim consumed vault surplus; keep the high-water mark in sync.
        $.accountedYield -= amount;

        emit KeptYieldClaimed(msg.sender, receiver_, amount);
    }

    /// @notice Sets the initial yield claimer address (one-time only)
    /// @dev Can only be called by the owner and only when no claimer has been set
    /// @param yieldClaimer_ Address to authorize as the yield claimer
    function setYieldClaimer(address yieldClaimer_) external onlyOwner {
        AbstractTokenStorage storage $ = _getAbstractTokenStorage();
        if (yieldClaimer_ == address(0)) revert ZeroAddress();
        if ($.yieldClaimer != address(0)) revert AlreadySetClaimer();
        $.yieldClaimer = yieldClaimer_;

        emit YieldClaimerSet(yieldClaimer_);
    }

    /// @notice Initiates a 14-day timelock to transfer yield claimer role to a new address
    /// @dev Reverts if a transfer is already pending or the new address matches the current claimer
    /// @param _newYieldClaimer Address to become the new yield claimer after the timelock
    function prepareNewYieldClaimer(address _newYieldClaimer) external onlyOwner {
        AbstractTokenStorage storage $ = _getAbstractTokenStorage();
        if (_newYieldClaimer == address(0)) revert ZeroAddress();
        if ($.yieldClaimer == _newYieldClaimer) revert SameClaimer();
        if ($.pendingFinishedAt > 0) revert PendingClaimer();
        $.pendingYieldClaimer = _newYieldClaimer;
        $.pendingFinishedAt = block.timestamp + 14 days;

        emit PendingYieldClaimerSet(_newYieldClaimer);
    }

    /// @notice Finalizes the pending yield claimer transfer after the 14-day timelock
    /// @dev Callable by anyone once the timelock has elapsed
    function finalizeNewYieldClaimer() external {
        AbstractTokenStorage storage $ = _getAbstractTokenStorage();
        if ($.pendingFinishedAt == 0) revert NoPendingClaimer();
        if (block.timestamp < $.pendingFinishedAt) revert TimelockNotElapsed();
        $.yieldClaimer = $.pendingYieldClaimer;
        $.pendingYieldClaimer = address(0);
        $.pendingFinishedAt = 0;

        emit YieldClaimerSet($.yieldClaimer);
    }

    /// @notice Transfers tokens and auto-delegates the recipient if they have no delegate set
    function transfer(address recipient_, uint256 amount_) public override(ERC20Upgradeable, IERC20) returns (bool) {
        super.transfer(recipient_, amount_);
        if (this.delegates(recipient_) == address(0)) _delegate(recipient_, recipient_);
        return true;
    }

    /// @notice Transfers tokens on behalf of another address and auto-delegates the recipient
    function transferFrom(address from_, address to_, uint256 value_)
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        super.transferFrom(from_, to_, value_);
        if (this.delegates(to_) == address(0)) _delegate(to_, to_);
        return true;
    }

    /// @notice Returns the unclaimed donated yield — the pool the yield claimer can distribute
    /// @dev Excludes holders' kept shares (settled and unsettled). Equals the full vault
    ///      surplus while no holder has set a nonzero yield split.
    function yieldAccrued() external view returns (uint256) {
        return _donatedYieldAccrued();
    }

    /// @notice Returns the total unclaimed vault surplus: donated pool plus all kept shares
    function totalYieldAccrued() external view returns (uint256) {
        return _yieldAccrued();
    }

    // ============ Yield Split Internals ============

    /// @dev Attributes any fresh vault surplus to current holders via the accumulator.
    ///      With no holders the surplus stays in the donated pool.
    function _accrueGlobalYield() internal {
        YieldSplitStorage storage $ = _getYieldSplitStorage();
        uint256 raw = _yieldAccrued();
        uint256 accounted = $.accountedYield;
        if (raw <= accounted) return;
        uint256 supply = totalSupply();
        if (supply > 0) {
            $.accYieldPerToken += (raw - accounted) * YIELD_PRECISION / supply;
        }
        $.accountedYield = raw;
    }

    /// @dev The accumulator as if _accrueGlobalYield ran now — lets views stay current
    ///      without mutating state.
    function _simulatedAccYieldPerToken() private view returns (uint256 acc) {
        YieldSplitStorage storage $ = _getYieldSplitStorage();
        acc = $.accYieldPerToken;
        uint256 raw = _yieldAccrued();
        uint256 accounted = $.accountedYield;
        uint256 supply = totalSupply();
        if (raw > accounted && supply > 0) {
            acc += (raw - accounted) * YIELD_PRECISION / supply;
        }
    }

    /// @dev Vault surplus minus every holder's kept share (settled and unsettled).
    ///      The keep-weight aggregates make this O(1): the unsettled kept yield across
    ///      all holders is (acc * Σbal·bps − Σbal·bps·idx) / precision / bps-scale.
    function _donatedYieldAccrued() private view returns (uint256) {
        YieldSplitStorage storage $ = _getYieldSplitStorage();
        uint256 raw = _yieldAccrued();
        uint256 unsettledKept =
            (_simulatedAccYieldPerToken() * $.keepWeight - $.keepWeightIndex) / YIELD_PRECISION / YIELD_SPLIT_BPS;
        uint256 reserved = $.keptYieldTotal + unsettledKept;
        return raw > reserved ? raw - reserved : 0;
    }

    /// @dev Credits an account's pending kept yield and removes its terms from the
    ///      keep-weight aggregates. Callers must _attach again after any balance or
    ///      split change. No-op for accounts that donate everything (keepBps == 0).
    function _settleAndDetach(address account_) internal {
        if (account_ == address(0)) return;
        YieldSplitStorage storage $ = _getYieldSplitStorage();
        uint256 bps = $.keepBps[account_];
        if (bps == 0) return;
        uint256 balance = balanceOf(account_);
        uint256 acc = $.accYieldPerToken;
        uint256 idx = $.index[account_];
        if (acc > idx) {
            uint256 kept = balance * (acc - idx) / YIELD_PRECISION * bps / YIELD_SPLIT_BPS;
            if (kept > 0) {
                $.keptYield[account_] += kept;
                $.keptYieldTotal += kept;
            }
        }
        uint256 weight = balance * bps;
        $.keepWeight -= weight;
        $.keepWeightIndex -= weight * idx;
        $.index[account_] = acc;
    }

    /// @dev Adds an account's current balance/split terms to the keep-weight aggregates.
    ///      Must mirror a prior _settleAndDetach so each account is counted exactly once.
    function _attach(address account_) internal {
        if (account_ == address(0)) return;
        YieldSplitStorage storage $ = _getYieldSplitStorage();
        uint256 bps = $.keepBps[account_];
        if (bps == 0) return;
        uint256 weight = balanceOf(account_) * bps;
        $.keepWeight += weight;
        $.keepWeightIndex += weight * $.index[account_];
    }

    /// @dev Settles both parties' yield-split accounting around every balance change so
    ///      each account's kept share reflects its balance over time.
    function _update(address from_, address to_, uint256 value_) internal virtual override {
        _accrueGlobalYield();
        _settleAndDetach(from_);
        if (to_ != from_) _settleAndDetach(to_);
        super._update(from_, to_, value_);
        _attach(from_);
        if (to_ != from_) _attach(to_);
    }

    /// @dev Mints tokens to the receiver and auto-delegates if no delegate is set
    function _mintAndDelegate(address receiver_, uint256 amount_) internal {
        _mint(receiver_, amount_);
        if (this.delegates(receiver_) == address(0)) _delegate(receiver_, receiver_);

        emit Minted(receiver_, amount_);
    }

    /// @dev Transfers native ETH to an address, reverts on failure
    function _nativeTransfer(address to_, uint256 amount_) internal {
        bool success;
        assembly {
            // Transfer the ETH and store if it succeeded or not.
            success := call(gas(), to_, amount_, 0, 0, 0, 0)
        }

        if (!success) revert NativeTransferFailed();
    }
}
