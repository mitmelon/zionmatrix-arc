// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ICardFactory {
    struct FeeConfig {
        uint16 feeBps;
        uint256 feeCap;
        uint256 maxDailyWithdraw;
        uint256 maxPerTx;
        uint64 holdPeriod;
    }

    function isGuardian(address account) external view returns (bool);
    function isRecovery(address account) external view returns (bool);
    function approved(address implementation) external view returns (bool);
    function withdrawalsHalted() external view returns (bool);
    function getFeeConfig(address card) external view returns (FeeConfig memory);
}
