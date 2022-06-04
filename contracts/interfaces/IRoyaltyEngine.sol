// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

interface IRoyaltyEngine {
  function getRoyaltyView(
    address tokenAddress,
    uint256 tokenId,
    uint256 value
  ) external view returns (address[] memory recipients, uint256[] memory amounts);
}
