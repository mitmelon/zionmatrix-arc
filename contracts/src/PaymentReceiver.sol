// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/**
 * PaymentReceiver
 * ---------------
 * One receiver per invoice, deployed lazily by the factory (CREATE2).
 *
 * `expectedAmount` is the exact amount the business is owed for this invoice. It is fixed in the
 * constructor, so it is part of the CREATE2 address: funds sent to a predicted address can only
 * ever be swept by a receiver deployed with that same expected amount.
 *
 * On sweep:
 *   - the card (business) gets everything up to the expected amount,
 *   - anything above the expected amount (the excess) goes to the relayer as the fee,
 *   - if there is no excess, no fee is taken and the card gets the whole balance.
 *
 * `deliveredToCard` tracks what the card has received so far, so payments that arrive in several
 * transfers (or after an earlier sweep) can never push the business above what it is owed, and a
 * later top-up that is really the fee is still routed to the relayer.
 */
contract PaymentReceiver {
    event FundsSwept(
        address indexed receiver,
        address indexed card,
        address indexed feeRecipient,
        uint256 amount,
        uint256 expectedAmount,
        uint256 fee,
        uint256 net
    );

    address payable public immutable card;
    address payable public immutable factory;
    uint256 public immutable expectedAmount;

    uint256 public deliveredToCard;

    error ForwardFailed();
    error NotFactory();
    error NotRelayer();
    error ZeroAddress();
    error ZeroExpectedAmount();

    constructor(address payable card_, address payable factory_, uint256 expectedAmount_) {
        if (card_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        if (expectedAmount_ == 0) revert ZeroExpectedAmount();

        card = card_;
        factory = factory_;
        expectedAmount = expectedAmount_;
    }

    receive() external payable {}

    function sweep(address payable feeRecipient) external returns (uint256 fee, uint256 net) {
        if (msg.sender != factory) revert NotFactory();
        if (feeRecipient == address(0)) revert NotRelayer();

        uint256 amount = address(this).balance;
        if (amount == 0) return (0, 0);

        // What the business is still owed. Never more than the expected amount in total.
        uint256 delivered = deliveredToCard;
        uint256 remaining = expectedAmount > delivered ? expectedAmount - delivered : 0;

        net = amount < remaining ? amount : remaining;
        fee = amount - net; // excess over what is owed; 0 when the payer sent exactly or less

        deliveredToCard = delivered + net;

        if (net > 0) {
            (bool cardOk,) = card.call{value: net}("");
            if (!cardOk) revert ForwardFailed();
        }

        if (fee > 0) {
            (bool feeOk,) = feeRecipient.call{value: fee}("");
            if (!feeOk) revert ForwardFailed();
        }

        emit FundsSwept(address(this), card, feeRecipient, amount, expectedAmount, fee, net);
    }
}
