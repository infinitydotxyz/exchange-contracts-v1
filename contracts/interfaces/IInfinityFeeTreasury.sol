// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;
import {OrderTypes} from '../libs/OrderTypes.sol';

interface IInfinityFeeTreasury {
  function getEffectiveFeeBps(address user) external view returns (uint16);

  function allocateFees(
    address seller,
    address buyer,
    OrderTypes.OrderItem[] calldata items,
    uint256 amount,
    address currency,
    uint256 minBpsToSeller,
    address execComplication,
    bool feeDiscountEnabled
  ) external payable;

  function refundMatchExecutionGasFee(
    uint256 startGas,
    OrderTypes.Order[] calldata sells,
    address matchExecutor,
    address weth
  ) external;

  function claimCreatorFees(address currency) external;

  function claimCuratorFees(
    address currency,
    uint256 cumulativeAmount,
    bytes32 expectedMerkleRoot,
    bytes32[] calldata merkleProof
  ) external;
}
