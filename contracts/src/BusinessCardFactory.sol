// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";

import {BusinessCard} from "./BusinessCard.sol";
import {BusinessCardProxy} from "./BusinessCardProxy.sol";
import {ICardFactory} from "./ICardFactory.sol";
import {PaymentReceiver} from "./PaymentReceiver.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

contract BusinessCardFactory is
    ICardFactory,
    AccessControlDefaultAdminRules,
    Pausable
{
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");

    uint64 public constant UPGRADE_DELAY = 7 days;

    // --- Added Struct & Storage for Card Details ---
    struct CardDetails {
        bytes32 businessId;
        address card;
        address settlement;
        address accessKey;
        address relayer;
        uint64 createdAt;
        uint256 createdBlock;
    }

    mapping(bytes32 businessId => address card) public cardOf;
    mapping(address card => bytes32 businessId) public businessIdOf;
    mapping(bytes32 businessId => CardDetails) public cardDetailsOf; // Stores detailed info onchain
    uint256 public totalCards;

    bool public withdrawalsHalted;
    address public defaultImplementation;
    mapping(address implementation => bool) public approved;
    mapping(address implementation => uint64) public upgradeReadyAt;
    ICardFactory.FeeConfig public defaultFeeConfig;
    mapping(address card => bool) public hasCardFeeOverride;
    mapping(address card => ICardFactory.FeeConfig) public cardFeeConfig;

    event CardCreated(
        bytes32 indexed businessId,
        address indexed card,
        address settlement,
        address relayer
    );
    event WithdrawalsHaltChanged(bool halted, address by);
    event UpgradeProposed(address indexed implementation, uint64 readyAt);
    event UpgradeCancelled(address indexed implementation, address by);
    event UpgradeApproved(address indexed implementation, bool isDefault);
    event UpgradeRevoked(address indexed implementation, address by);
    event DefaultFeeConfigChanged(
        uint16 feeBps,
        uint256 feeCap,
        uint256 maxDailyWithdraw,
        uint256 maxPerTx,
        uint64 holdPeriod,
        address by
    );
    event CardFeeConfigChanged(
        address indexed card,
        uint16 feeBps,
        uint256 feeCap,
        uint256 maxDailyWithdraw,
        uint256 maxPerTx,
        uint64 holdPeriod,
        address by
    );
    event ReceiverSwept(
        bytes32 indexed businessId,
        bytes32 indexed invoiceId,
        address receiver,
        address card,
        uint256 amount,
        uint256 expectedAmount,
        uint256 fee,
        uint256 net
    );

    error BadId();
    error BadAmount();
    error CardExists(address card);
    error NoChange();
    error BadImplementation(address implementation);
    error NotProposed(address implementation);
    error AlreadyApproved(address implementation);
    error TooEarly(uint64 readyAt);
    error NotApproved(address implementation);
    error InvalidFeeConfig();
    error NoCard(bytes32 businessId);
    error NothingToSweep();
    error ReceiverMismatch();
    error NotRelayer();

    constructor(
        uint48 adminDelay,
        address admin
    ) AccessControlDefaultAdminRules(adminDelay, admin) {
        address first = address(new BusinessCard(address(this)));
        approved[first] = true;
        defaultImplementation = first;
        emit UpgradeApproved(first, true);
    }

    function createCard(
        bytes32 businessId,
        address settlement,
        address accessKey,
        address relayer
    ) external onlyRole(CREATOR_ROLE) whenNotPaused returns (address card) {
        if (businessId == bytes32(0)) revert BadId();
        if (cardOf[businessId] != address(0))
            revert CardExists(cardOf[businessId]);
        if (!approved[defaultImplementation])
            revert NotApproved(defaultImplementation);

        card = address(new BusinessCardProxy(defaultImplementation));
        cardOf[businessId] = card;
        businessIdOf[card] = businessId;
        totalCards += 1;

        // Store Card Details onchain
        cardDetailsOf[businessId] = CardDetails({
            businessId: businessId,
            card: card,
            settlement: settlement,
            accessKey: accessKey,
            relayer: relayer,
            createdAt: uint64(block.timestamp),
            createdBlock: block.number
        });

        BusinessCard(payable(card)).initialize(
            businessId,
            settlement,
            accessKey,
            relayer
        );
        emit CardCreated(businessId, card, settlement, relayer);
    }

    // --- Onchain View Getters ---

    function getCardInfo(bytes32 businessId) external view returns (CardDetails memory) {
        if (cardOf[businessId] == address(0)) revert NoCard(businessId);
        return cardDetailsOf[businessId];
    }

    function getCardInfoByAddress(address card) external view returns (CardDetails memory) {
        bytes32 bId = businessIdOf[card];
        if (bId == bytes32(0)) revert NoCard(bytes32(0));
        return cardDetailsOf[bId];
    }

    function isCard(address account) external view returns (bool) {
        return businessIdOf[account] != bytes32(0);
    }

    function receiverSalt(
        bytes32 businessId,
        bytes32 invoiceId
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(businessId, invoiceId));
    }

    function predictReceiver(
        bytes32 businessId,
        bytes32 invoiceId,
        uint256 expectedAmount
    ) public view returns (address) {
        address card = cardOf[businessId];
        if (card == address(0)) revert NoCard(businessId);
        if (expectedAmount == 0) revert BadAmount();

        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(PaymentReceiver).creationCode,
                abi.encode(card, address(this), expectedAmount)
            )
        );
        return
            Create2.computeAddress(
                receiverSalt(businessId, invoiceId),
                initCodeHash,
                address(this)
            );
    }

    function sweep(
        bytes32 businessId,
        bytes32 invoiceId,
        uint256 expectedAmount
    ) external returns (uint256 amount) {
        address card = cardOf[businessId];

        if (card == address(0)) {
            revert NoCard(businessId);
        }

        if (!BusinessCard(payable(card)).isRelayer(msg.sender)) {
            revert NotRelayer();
        }

        address receiver = predictReceiver(businessId, invoiceId, expectedAmount);
        amount = receiver.balance;

        if (amount == 0) {
            return 0;
        }

        if (receiver.code.length == 0) {
            address deployed = address(
                new PaymentReceiver{
                    salt: receiverSalt(businessId, invoiceId)
                }(
                    payable(card),
                    payable(address(this)),
                    expectedAmount
                )
            );
        
            if (deployed != receiver) revert ReceiverMismatch();
        }
        
        (uint256 fee, uint256 net) = PaymentReceiver(payable(receiver)).sweep(
            payable(msg.sender)
        );

        emit ReceiverSwept(
            businessId,
            invoiceId,
            receiver,
            card,
            amount,
            expectedAmount,
            fee,
            net
        );
    }

    function proposeUpgrade(
        address implementation
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (implementation.code.length == 0)
            revert BadImplementation(implementation);
        if (approved[implementation]) revert AlreadyApproved(implementation);

        try BusinessCard(payable(implementation)).factory() returns (
            ICardFactory f
        ) {
            if (address(f) != address(this))
                revert BadImplementation(implementation);
        } catch {
            revert BadImplementation(implementation);
        }
        try IERC1822Proxiable(implementation).proxiableUUID() returns (
            bytes32 slot
        ) {
            if (slot != ERC1967Utils.IMPLEMENTATION_SLOT)
                revert BadImplementation(implementation);
        } catch {
            revert BadImplementation(implementation);
        }

        upgradeReadyAt[implementation] =
            uint64(block.timestamp) +
            UPGRADE_DELAY;
        emit UpgradeProposed(implementation, upgradeReadyAt[implementation]);
    }

    function cancelUpgrade(address implementation) external {
        if (
            !hasRole(GUARDIAN_ROLE, msg.sender) &&
            !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)
        ) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        if (upgradeReadyAt[implementation] == 0)
            revert NotProposed(implementation);
        delete upgradeReadyAt[implementation];
        emit UpgradeCancelled(implementation, msg.sender);
    }

    function approveUpgrade(
        address implementation,
        bool makeDefault
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint64 readyAt = upgradeReadyAt[implementation];
        if (readyAt == 0) revert NotProposed(implementation);
        if (block.timestamp < readyAt) revert TooEarly(readyAt);

        delete upgradeReadyAt[implementation];
        approved[implementation] = true;
        if (makeDefault) defaultImplementation = implementation;
        emit UpgradeApproved(implementation, makeDefault);
    }

    function revokeUpgrade(
        address implementation
    ) external onlyRole(GUARDIAN_ROLE) {
        if (!approved[implementation]) revert NotApproved(implementation);
        approved[implementation] = false;
        emit UpgradeRevoked(implementation, msg.sender);
    }

    function setDefaultImplementation(
        address implementation
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!approved[implementation]) revert NotApproved(implementation);
        if (implementation == defaultImplementation) revert NoChange();
        defaultImplementation = implementation;
    }

    function haltWithdrawals() external onlyRole(GUARDIAN_ROLE) {
        if (withdrawalsHalted) revert NoChange();
        withdrawalsHalted = true;
        emit WithdrawalsHaltChanged(true, msg.sender);
    }

    function resumeWithdrawals() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!withdrawalsHalted) revert NoChange();
        withdrawalsHalted = false;
        emit WithdrawalsHaltChanged(false, msg.sender);
    }

    function pauseCreation() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpauseCreation() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function isGuardian(address account) external view returns (bool) {
        return hasRole(GUARDIAN_ROLE, account);
    }

    function isRecovery(address account) external view returns (bool) {
        return
            hasRole(GUARDIAN_ROLE, account) || hasRole(RECOVERY_ROLE, account);
    }

    function setDefaultFeeConfig(
        uint16 feeBps,
        uint256 feeCap,
        uint256 maxDailyWithdraw,
        uint256 maxPerTx,
        uint64 holdPeriod
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > 1000) revert InvalidFeeConfig();
        if (feeCap > 10 ether) revert InvalidFeeConfig();
        defaultFeeConfig = ICardFactory.FeeConfig({
            feeBps: feeBps,
            feeCap: feeCap,
            maxDailyWithdraw: maxDailyWithdraw,
            maxPerTx: maxPerTx,
            holdPeriod: holdPeriod
        });
        emit DefaultFeeConfigChanged(
            feeBps,
            feeCap,
            maxDailyWithdraw,
            maxPerTx,
            holdPeriod,
            msg.sender
        );
    }

    function setCardFeeConfig(
        address card,
        uint16 feeBps,
        uint256 feeCap,
        uint256 maxDailyWithdraw,
        uint256 maxPerTx,
        uint64 holdPeriod
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (card == address(0)) revert BadId();
        if (feeBps > 1000) revert InvalidFeeConfig();
        if (feeCap > 10 ether) revert InvalidFeeConfig();
        cardFeeConfig[card] = ICardFactory.FeeConfig({
            feeBps: feeBps,
            feeCap: feeCap,
            maxDailyWithdraw: maxDailyWithdraw,
            maxPerTx: maxPerTx,
            holdPeriod: holdPeriod
        });
        hasCardFeeOverride[card] = true;
        emit CardFeeConfigChanged(
            card,
            feeBps,
            feeCap,
            maxDailyWithdraw,
            maxPerTx,
            holdPeriod,
            msg.sender
        );
    }

    function getFeeConfig(
        address card
    ) external view returns (ICardFactory.FeeConfig memory) {
        if (hasCardFeeOverride[card]) return cardFeeConfig[card];
        return defaultFeeConfig;
    }
}