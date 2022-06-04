// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {IRoyaltyEngine} from './interfaces/IRoyaltyEngine.sol';

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';

import 'hardhat/console.sol';

contract MockRoyaltyEngine is IRoyaltyEngine, Ownable {
  mapping(address => uint16) royaltyBps;

  function getRoyaltyView(
    address collection,
    uint256,
    uint256 salePrice
  ) external view returns (address[] memory, uint256[] memory) {
    // console.log('mockRoyaltyEngine.getRoyalty owner', owner());
    address[] memory recipients = new address[](1);
    uint256[] memory amounts = new uint256[](1);
    recipients[0] = owner();
    amounts[0] = (salePrice * royaltyBps[collection]) / 10000;
    return (recipients, amounts);
  }

  function setRoyaltyBps(address collection, uint16 bps) external onlyOwner {
    royaltyBps[collection] = bps;
  }
}
