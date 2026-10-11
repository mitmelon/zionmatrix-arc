// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";

import {ICardFactory} from "./ICardFactory.sol";

contract BusinessCard is Initializable, UUPSUpgradeable, ReentrancyGuardTransient, EIP712 {
    uint64 public constant SETTLEMENT_DELAY = 24 hours;
    uint64 public constant RECOVERY_DELAY = 72 hours;
    uint64 public constant LOCK_TIME = 24 hours;
    uint8 public constant MAX_ATTEMPTS = 3;

    bytes32 private constant ACCESS_ACTION =
        keccak256("AccessAction(bytes32 action,bytes32 data,uint256 nonce,uint256 deadline)");
    bytes32 private constant WITHDRAW = keccak256("WITHDRAW");
    bytes32 private constant WITHDRAW_ALL = keccak256("WITHDRAW_ALL");
    bytes32 private constant CHANGE_PASSWORD = keccak256("CHANGE_PASSWORD");
    bytes32 private constant SETTLEMENT = keccak256("SETTLEMENT");
    bytes32 private constant CANCEL_SETTLEMENT = keccak256("CANCEL_SETTLEMENT");
    bytes32 private constant CANCEL_RECOVERY = keccak256("CANCEL_RECOVERY");
    bytes32 private constant ADD_RELAYER = keccak256("ADD_RELAYER");
    bytes32 private constant REMOVE_RELAYER = keccak256("REMOVE_RELAYER");
    bytes32 private constant UPGRADE = keccak256("UPGRADE");

    ICardFactory public immutable factory;

    // All state sits in one struct at a fixed slot so future versions can add fields safely.
    // keccak256(abi.encode(uint256(keccak256("zionmatrix.storage.BusinessCard")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SLOT = 0x0f56c76762353a330146a18be18c2bdff96e4151f0263a6eb192123450c5f900;

    struct FeePolicy {
        uint16 feeBps;
        uint256 feeCap;
        uint256 maxDailyWithdraw;
        uint256 maxPerTx;
        uint64 holdPeriod;
    }

    struct Data {
        bytes32 businessId;
        address settlement;
        address accessKey;
        uint256 nonce;
        bool frozen;
        bool lockedForever;
        uint8 failedAttempts;
        uint8 lockStrikes;
        uint64 lockedUntil;
        uint256 relayerEpoch;
        uint32 relayerCount;
        address pendingSettlement;
        uint64 settlementReadyAt;
        address recoverySettlement;
        address recoveryKey;
        address recoveryRelayer;
        uint64 recoveryReadyAt;
        uint256 lastIncomingAt;
        uint64 withdrawalDay;
        uint256 withdrawnToday;
        FeePolicy feePolicy;
        bool hasCustomFeePolicy;
        mapping(uint256 epoch => mapping(address relayer => bool)) relayers;
    }

    event PaymentReceived(bytes32 indexed businessId, address indexed from, uint256 amount);
    event Withdrawn(bytes32 indexed businessId, address indexed to, uint256 amount, address relayer);
    event FeeConfigUpdated(bytes32 indexed businessId, uint16 feeBps, uint256 feeCap, uint256 maxDailyWithdraw, uint256 maxPerTx, uint64 holdPeriod);
    event PasswordChanged(bytes32 indexed businessId, address newAccessKey);
    event PasswordRejected(bytes32 indexed businessId, bytes32 action, uint8 attemptsLeft);
    event CardLocked(bytes32 indexed businessId, uint64 until, bool forever);
    event RelayerAdded(bytes32 indexed businessId, address relayer);
    event RelayerRemoved(bytes32 indexed businessId, address relayer);
    event SettlementProposed(bytes32 indexed businessId, address newSettlement, uint64 readyAt);
    event SettlementChanged(bytes32 indexed businessId, address oldSettlement, address newSettlement);
    event SettlementCancelled(bytes32 indexed businessId, address cancelledBy);
    event Frozen(bytes32 indexed businessId, address by);
    event Unfrozen(bytes32 indexed businessId, address by);
    event RecoveryProposed(bytes32 indexed businessId, address newSettlement, address newRelayer, uint64 readyAt);
    event RecoveryExecuted(bytes32 indexed businessId, address newSettlement, address newRelayer);
    event RecoveryCancelled(bytes32 indexed businessId, address cancelledBy);

    error NotFactory();
    error NotRelayer();
    error LastRelayer();
    error AlreadyRelayer();
    error NotGuardian();
    error NotRecovery();
    error CardFrozen();
    error Locked(uint64 until);
    error LockedForever();
    error WithdrawalsHalted();
    error NothingToUnlock();
    error AlreadyFrozen();
    error BadId();
    error ZeroAddress();
    error BadAddress();
    error SameKey();
    error ZeroAmount();
    error LowBalance(uint256 wanted, uint256 have);
    error Expired(uint256 deadline);
    error NothingPending();
    error TooEarly(uint64 readyAt);
    error NotApproved(address implementation);
    error BadImplementation(address implementation);
    error UseUpgrade();
    error HoldPeriodNotElapsed();
    error DailyLimitExceeded();
    error MaxPerTxExceeded();
    error InvalidFeePolicy();

    constructor(address factory_) EIP712("ZionMatrix Business Card", "1") {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = ICardFactory(factory_);
        _disableInitializers();
    }

    function initialize(bytes32 businessId_, address settlement_, address accessKey_, address relayer_)
        external
        initializer
    {
        if (msg.sender != address(factory)) revert NotFactory();
        if (businessId_ == bytes32(0)) revert BadId();
        _checkParty(settlement_);
        _checkParty(relayer_);
        if (accessKey_ == address(0)) revert ZeroAddress();

        Data storage d = _data();
        d.businessId = businessId_;
        d.settlement = settlement_;
        d.accessKey = accessKey_;
        d.hasCustomFeePolicy = false;
        ICardFactory.FeeConfig memory cfg = factory.getFeeConfig(address(this));
        d.feePolicy = FeePolicy({
            feeBps: cfg.feeBps,
            feeCap: cfg.feeCap,
            maxDailyWithdraw: cfg.maxDailyWithdraw,
            maxPerTx: cfg.maxPerTx,
            holdPeriod: cfg.holdPeriod
        });
        _addRelayer(d, relayer_);
    }

    receive() external payable {
        if (msg.value == 0) revert ZeroAmount();
        Data storage d = _data();
        d.lastIncomingAt = block.timestamp;
        emit PaymentReceived(d.businessId, msg.sender, msg.value);
    }

    function withdraw(uint256 amount, uint256 deadline, bytes calldata accessSig) external nonReentrant {
        Data storage d = _data();
        _startAction(d);
        _syncFeePolicy(d);
        _withdrawalsOn();
        if (amount == 0) revert ZeroAmount();
        if (d.lastIncomingAt != 0 && block.timestamp < d.lastIncomingAt + d.feePolicy.holdPeriod) revert HoldPeriodNotElapsed();
        if (amount > d.feePolicy.maxPerTx && d.feePolicy.maxPerTx != 0) revert MaxPerTxExceeded();
        if (amount > address(this).balance) revert LowBalance(amount, address(this).balance);
        if (!_authorize(d, WITHDRAW, keccak256(abi.encode(amount, d.settlement)), deadline, accessSig)) return;
        _applyDailyLimit(d, amount);
        _pay(d, amount);
    }

    function withdrawAll(uint256 deadline, bytes calldata accessSig) external nonReentrant {
        Data storage d = _data();
        _startAction(d);
        _syncFeePolicy(d);
        _withdrawalsOn();
        if (address(this).balance == 0) revert ZeroAmount();
        if (d.lastIncomingAt != 0 && block.timestamp < d.lastIncomingAt + d.feePolicy.holdPeriod) revert HoldPeriodNotElapsed();
        uint256 amount = address(this).balance;
        if (d.feePolicy.maxPerTx != 0 && amount > d.feePolicy.maxPerTx) revert MaxPerTxExceeded();
        if (!_authorize(d, WITHDRAW_ALL, keccak256(abi.encode(d.settlement)), deadline, accessSig)) return;
        _applyDailyLimit(d, amount);
        _pay(d, amount);
    }

    function changePassword(address newAccessKey, uint256 deadline, bytes calldata accessSig) external {
        Data storage d = _data();
        _startAction(d);
        if (newAccessKey == address(0)) revert ZeroAddress();
        if (newAccessKey == d.accessKey) revert SameKey();
        if (!_authorize(d, CHANGE_PASSWORD, keccak256(abi.encode(newAccessKey)), deadline, accessSig)) return;
        d.accessKey = newAccessKey;
        emit PasswordChanged(d.businessId, newAccessKey);
    }

    function setSecurityPolicy(uint256 maxPerTx, uint256 maxDailyWithdraw, uint64 holdPeriod, uint256 deadline, bytes calldata accessSig)
        external
    {
        Data storage d = _data();
        _startAction(d);
        _syncFeePolicy(d);
        if (maxPerTx == 0 && maxDailyWithdraw == 0 && holdPeriod == 0) revert InvalidFeePolicy();
        if (!_authorize(d, keccak256("SET_SECURITY_POLICY"), keccak256(abi.encode(maxPerTx, maxDailyWithdraw, holdPeriod)), deadline, accessSig)) return;
        d.hasCustomFeePolicy = true;
        d.feePolicy.maxPerTx = maxPerTx;
        d.feePolicy.maxDailyWithdraw = maxDailyWithdraw;
        d.feePolicy.holdPeriod = holdPeriod;
        emit FeeConfigUpdated(d.businessId, d.feePolicy.feeBps, d.feePolicy.feeCap, d.feePolicy.maxDailyWithdraw, d.feePolicy.maxPerTx, d.feePolicy.holdPeriod);
    }

    function addRelayer(address relayer, uint256 deadline, bytes calldata accessSig) external {
        Data storage d = _data();
        _startAction(d);
        _checkParty(relayer);
        if (_isRelayer(d, relayer)) revert AlreadyRelayer();
        if (!_authorize(d, ADD_RELAYER, keccak256(abi.encode(relayer)), deadline, accessSig)) return;
        _addRelayer(d, relayer);
    }

    function removeRelayer(address relayer, uint256 deadline, bytes calldata accessSig) external {
        Data storage d = _data();
        _startAction(d);
        if (!_isRelayer(d, relayer)) revert NotRelayer();
        if (d.relayerCount == 1) revert LastRelayer();
        if (!_authorize(d, REMOVE_RELAYER, keccak256(abi.encode(relayer)), deadline, accessSig)) return;
        d.relayers[d.relayerEpoch][relayer] = false;
        d.relayerCount -= 1;
        emit RelayerRemoved(d.businessId, relayer);
    }

    function proposeSettlement(address newSettlement, uint256 deadline, bytes calldata accessSig) external {
        Data storage d = _data();
        _startAction(d);
        _checkParty(newSettlement);
        if (newSettlement == d.settlement) revert BadAddress();
        if (!_authorize(d, SETTLEMENT, keccak256(abi.encode(newSettlement)), deadline, accessSig)) return;

        d.pendingSettlement = newSettlement;
        d.settlementReadyAt = uint64(block.timestamp) + SETTLEMENT_DELAY;
        emit SettlementProposed(d.businessId, newSettlement, d.settlementReadyAt);
    }

    function confirmSettlement() external {
        Data storage d = _data();
        _startAction(d);
        address next = d.pendingSettlement;
        if (next == address(0)) revert NothingPending();
        if (block.timestamp < d.settlementReadyAt) revert TooEarly(d.settlementReadyAt);

        emit SettlementChanged(d.businessId, d.settlement, next);
        d.settlement = next;
        d.pendingSettlement = address(0);
        d.settlementReadyAt = 0;
    }

    function cancelSettlement(uint256 deadline, bytes calldata accessSig) external {
        Data storage d = _data();
        _startAction(d);
        if (d.pendingSettlement == address(0)) revert NothingPending();
        if (!_authorize(d, CANCEL_SETTLEMENT, keccak256(abi.encode(d.pendingSettlement)), deadline, accessSig)) return;
        d.pendingSettlement = address(0);
        d.settlementReadyAt = 0;
        emit SettlementCancelled(d.businessId, msg.sender);
    }

    function vetoSettlement() external {
        _onlyGuardianOrRecovery();
        Data storage d = _data();
        if (d.pendingSettlement == address(0)) revert NothingPending();
        d.pendingSettlement = address(0);
        d.settlementReadyAt = 0;
        emit SettlementCancelled(d.businessId, msg.sender);
    }

    function upgrade(address newImplementation, bytes calldata data, uint256 deadline, bytes calldata accessSig)
        external
        nonReentrant
    {
        Data storage d = _data();
        _startAction(d);
        if (!factory.approved(newImplementation)) revert NotApproved(newImplementation);
        if (newImplementation == ERC1967Utils.getImplementation()) revert BadImplementation(newImplementation);

        try IERC1822Proxiable(newImplementation).proxiableUUID() returns (bytes32 slot) {
            if (slot != ERC1967Utils.IMPLEMENTATION_SLOT) revert BadImplementation(newImplementation);
        } catch {
            revert BadImplementation(newImplementation);
        }

        bytes32 hash = keccak256(abi.encode(newImplementation, keccak256(data)));
        if (!_authorize(d, UPGRADE, hash, deadline, accessSig)) return;
        ERC1967Utils.upgradeToAndCall(newImplementation, data);
    }

    function _authorizeUpgrade(address) internal pure override {
        revert UseUpgrade();
    }

    function freeze() external {
        _onlyGuardianOrRecovery();
        Data storage d = _data();
        if (d.frozen) revert AlreadyFrozen();
        d.frozen = true;
        emit Frozen(d.businessId, msg.sender);
    }

    function unfreeze() external {
        if (!factory.isRecovery(msg.sender)) revert NotRecovery();
        Data storage d = _data();
        if (!d.frozen && !d.lockedForever && d.lockedUntil <= block.timestamp && d.failedAttempts == 0 && d.lockStrikes == 0) {
            revert NothingToUnlock();
        }
        d.frozen = false;
        _clearLocks(d);
        emit Unfrozen(d.businessId, msg.sender);
    }

    function proposeRecovery(address newSettlement, address newAccessKey, address newRelayer) external {
        if (!factory.isRecovery(msg.sender)) revert NotRecovery();
        _checkParty(newSettlement);
        _checkParty(newRelayer);
        if (newAccessKey == address(0)) revert ZeroAddress();

        Data storage d = _data();
        d.recoverySettlement = newSettlement;
        d.recoveryKey = newAccessKey;
        d.recoveryRelayer = newRelayer;
        d.recoveryReadyAt = uint64(block.timestamp) + RECOVERY_DELAY;
        emit RecoveryProposed(d.businessId, newSettlement, newRelayer, d.recoveryReadyAt);
    }

    function executeRecovery() external {
        if (!factory.isRecovery(msg.sender)) revert NotRecovery();
        Data storage d = _data();
        if (d.recoveryKey == address(0)) revert NothingPending();
        if (block.timestamp < d.recoveryReadyAt) revert TooEarly(d.recoveryReadyAt);

        d.accessKey = d.recoveryKey;
        d.settlement = d.recoverySettlement;
        d.relayerEpoch += 1; // drops every old relayer
        d.relayerCount = 0;
        _addRelayer(d, d.recoveryRelayer);
        d.pendingSettlement = address(0);
        d.settlementReadyAt = 0;
        _clearLocks(d);
        emit RecoveryExecuted(d.businessId, d.recoverySettlement, d.recoveryRelayer);

        d.recoveryKey = address(0);
        d.recoverySettlement = address(0);
        d.recoveryRelayer = address(0);
        d.recoveryReadyAt = 0;
    }

    function cancelRecovery(uint256 deadline, bytes calldata accessSig) external {
        Data storage d = _data();
        _startAction(d);
        if (d.recoveryKey == address(0)) revert NothingPending();
        if (!_authorize(d, CANCEL_RECOVERY, keccak256(abi.encode(d.recoveryKey)), deadline, accessSig)) return;
        _clearRecovery(d);
        emit RecoveryCancelled(d.businessId, msg.sender);
    }

    function vetoRecovery() external {
        _onlyGuardianOrRecovery();
        Data storage d = _data();
        if (d.recoveryKey == address(0)) revert NothingPending();
        _clearRecovery(d);
        emit RecoveryCancelled(d.businessId, msg.sender);
    }

    function version() public pure virtual returns (string memory) {
        return "1.0.0";
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    function implementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    function businessId() external view returns (bytes32) {
        return _data().businessId;
    }

    function settlement() external view returns (address) {
        return _data().settlement;
    }

    function accessKey() external view returns (address) {
        return _data().accessKey;
    }

    function nonce() external view returns (uint256) {
        return _data().nonce;
    }

    function isRelayer(address account) external view returns (bool) {
        return _isRelayer(_data(), account);
    }

    function relayerCount() external view returns (uint32) {
        return _data().relayerCount;
    }

    function lockStatus()
        external
        view
        returns (bool frozen, bool lockedForever, uint64 lockedUntil, uint8 attemptsLeft)
    {
        Data storage d = _data();
        bool locked = d.lockedForever || block.timestamp < d.lockedUntil;
        uint8 left = d.lockStrikes > 0 ? 1 : MAX_ATTEMPTS - d.failedAttempts;
        return (d.frozen, d.lockedForever, d.lockedUntil, (locked || d.frozen) ? 0 : left);
    }

    function pendingSettlement() external view returns (address next, uint64 readyAt) {
        Data storage d = _data();
        return (d.pendingSettlement, d.settlementReadyAt);
    }

    function pendingRecovery()
        external
        view
        returns (address newSettlement, address newAccessKey, address newRelayer, uint64 readyAt)
    {
        Data storage d = _data();
        return (d.recoverySettlement, d.recoveryKey, d.recoveryRelayer, d.recoveryReadyAt);
    }

    function _data() private pure returns (Data storage d) {
        assembly {
            d.slot := SLOT
        }
    }

    function _startAction(Data storage d) private view {
        if (!_isRelayer(d, msg.sender)) revert NotRelayer();
        if (d.frozen) revert CardFrozen();
        if (d.lockedForever) revert LockedForever();
        if (block.timestamp < d.lockedUntil) revert Locked(d.lockedUntil);
    }

    function _withdrawalsOn() private view {
        if (factory.withdrawalsHalted()) revert WithdrawalsHalted();
    }

    function _onlyGuardianOrRecovery() private view {
        if (!factory.isGuardian(msg.sender) && !factory.isRecovery(msg.sender)) revert NotGuardian();
    }

    function _isRelayer(Data storage d, address account) private view returns (bool) {
        return d.relayers[d.relayerEpoch][account];
    }

    function _addRelayer(Data storage d, address relayer) private {
        d.relayers[d.relayerEpoch][relayer] = true;
        d.relayerCount += 1;
        emit RelayerAdded(d.businessId, relayer);
    }

    function _checkParty(address account) private view {
        if (account == address(0)) revert ZeroAddress();
        if (account == address(this) || account == address(factory)) revert BadAddress();
    }

    function _pay(Data storage d, uint256 amount) private {
        uint256 fee = _feeForAmount(d, amount);
        uint256 settlementAmount = amount - fee;
        emit Withdrawn(d.businessId, d.settlement, settlementAmount, msg.sender);
        Address.sendValue(payable(d.settlement), settlementAmount);
        if (fee > 0) Address.sendValue(payable(msg.sender), fee);
    }

    function _feeForAmount(Data storage d, uint256 amount) private view returns (uint256) {
        uint256 fee = (amount * d.feePolicy.feeBps) / 10_000;
        if (d.feePolicy.feeCap > 0 && fee > d.feePolicy.feeCap) fee = d.feePolicy.feeCap;
        return fee;
    }

    function _applyDailyLimit(Data storage d, uint256 amount) private {
        if (d.feePolicy.maxDailyWithdraw == 0) return;
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != d.withdrawalDay) {
            d.withdrawalDay = today;
            d.withdrawnToday = 0;
        }
        if (d.withdrawnToday + amount > d.feePolicy.maxDailyWithdraw) revert DailyLimitExceeded();
        d.withdrawnToday += amount;
    }

    function _syncFeePolicy(Data storage d) private {
        if (d.hasCustomFeePolicy) return;
        ICardFactory.FeeConfig memory cfg = factory.getFeeConfig(address(this));
        d.feePolicy.feeBps = cfg.feeBps;
        d.feePolicy.feeCap = cfg.feeCap;
        d.feePolicy.maxDailyWithdraw = cfg.maxDailyWithdraw;
        d.feePolicy.maxPerTx = cfg.maxPerTx;
        d.feePolicy.holdPeriod = cfg.holdPeriod;
    }

    function _clearLocks(Data storage d) private {
        d.lockedForever = false;
        d.lockedUntil = 0;
        d.failedAttempts = 0;
        d.lockStrikes = 0;
    }

    function _clearRecovery(Data storage d) private {
        d.recoveryKey = address(0);
        d.recoverySettlement = address(0);
        d.recoveryRelayer = address(0);
        d.recoveryReadyAt = 0;
    }

    function _authorize(Data storage d, bytes32 action, bytes32 data, uint256 deadline, bytes calldata sig)
        private
        returns (bool)
    {
        if (block.timestamp > deadline) revert Expired(deadline);

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ACCESS_ACTION, action, data, d.nonce, deadline)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
        if (err == ECDSA.RecoverError.NoError && signer == d.accessKey) {
            d.nonce += 1;
            d.failedAttempts = 0;
            d.lockStrikes = 0;
            return true;
        }

        _recordFailure(d, action);
        return false;
    }

    function _recordFailure(Data storage d, bytes32 action) private {
        if (d.lockStrikes > 0) {
            // The 24h lock already happened and this is the first wrong attempt after it: lock for good.
            d.lockedForever = true;
            emit PasswordRejected(d.businessId, action, 0);
            emit CardLocked(d.businessId, 0, true);
            return;
        }

        d.failedAttempts += 1;
        if (d.failedAttempts >= MAX_ATTEMPTS) {
            d.failedAttempts = 0;
            d.lockStrikes = 1;
            d.lockedUntil = uint64(block.timestamp) + LOCK_TIME;
            emit PasswordRejected(d.businessId, action, 0);
            emit CardLocked(d.businessId, d.lockedUntil, false);
        } else {
            emit PasswordRejected(d.businessId, action, MAX_ATTEMPTS - d.failedAttempts);
        }
    }
}
