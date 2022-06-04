// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IFeeRegistry} from '../interfaces/IFeeRegistry.sol';

/**
 * @title InfinityCreatorsFeeRegistry
 */
contract InfinityCreatorsFeeRegistry is IFeeRegistry, Ownable {
  address CREATORS_FEE_MANAGER;
  struct FeeInfo {
    address setter;
    address[] destinations;
    uint16[] bpsSplits;
  }

  mapping(address => FeeInfo) private _creatorsFeeInfo;

  event CreatorsFeeUpdate(
    address indexed collection,
    address indexed setter,
    address[] destinations,
    uint16[] bpsSplits
  );

  event CreatorsFeeManagerUpdated(address indexed manager);

  /**
   * @notice Update creators fee for collection
   * @param collection address of the NFT contract
   * @param setter address that sets destinations
   * @param destinations receivers for the fee
   * @param bpsSplits fee (500 = 5%, 1,000 = 10%)
   */
  function registerFeeDestinations(
    address collection,
    address setter,
    address[] calldata destinations,
    uint16[] calldata bpsSplits
  ) external override {
    require(msg.sender == CREATORS_FEE_MANAGER, 'Creators Fee Registry: Only creators fee manager');
    _creatorsFeeInfo[collection] = FeeInfo({setter: setter, destinations: destinations, bpsSplits: bpsSplits});
    emit CreatorsFeeUpdate(collection, setter, destinations, bpsSplits);
  }

  /**
   * @notice View creator fee info for a collection address
   * @param collection collection address
   */
  function getFeeInfo(address collection)
    external
    view
    override
    returns (
      address,
      address[] memory,
      uint16[] memory
    )
  {
    return (
      _creatorsFeeInfo[collection].setter,
      _creatorsFeeInfo[collection].destinations,
      _creatorsFeeInfo[collection].bpsSplits
    );
  }

  // ===================================================== ADMIN FUNCTIONS =====================================================

  function updateCreatorsFeeManager(address manager) external onlyOwner {
    CREATORS_FEE_MANAGER = manager;
    emit CreatorsFeeManagerUpdated(manager);
  }
}
