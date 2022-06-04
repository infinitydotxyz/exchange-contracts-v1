// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import {IComplicationRegistry} from '../interfaces/IComplicationRegistry.sol';

/**
 * @title InfinityComplicationRegistry
 * @notice allows adding/removing complications for trading on the Infinity exchange
 */
contract InfinityComplicationRegistry is IComplicationRegistry, Ownable {
  using EnumerableSet for EnumerableSet.AddressSet;

  EnumerableSet.AddressSet private _whitelistedComplications;

  event ComplicationRemoved(address indexed complication);
  event ComplicationWhitelisted(address indexed complication);

  /**
   * @notice Adds an execution complication
   * @param complication address of the complication to add
   */
  function addComplication(address complication) external onlyOwner {
    require(!_whitelistedComplications.contains(complication), 'Complication: Already whitelisted');
    _whitelistedComplications.add(complication);

    emit ComplicationWhitelisted(complication);
  }

  /**
   * @notice Remove an execution complication
   * @param complication address of the complication to remove
   */
  function removeComplication(address complication) external onlyOwner {
    require(_whitelistedComplications.contains(complication), 'Complication: Not whitelisted');
    _whitelistedComplications.remove(complication);

    emit ComplicationRemoved(complication);
  }

  /**
   * @notice Returns if an execution complication was whitelisted
   * @param complication address of the complication
   */
  function isComplicationWhitelisted(address complication) external view override returns (bool) {
    return _whitelistedComplications.contains(complication);
  }

  /**
   * @notice View number of whitelisted complications
   */
  function numWhitelistedComplications() external view returns (uint256) {
    return _whitelistedComplications.length();
  }

  /**
   * @notice See whitelisted complications
   * @param cursor cursor (should start at 0 for first request)
   * @param size size of the response (e.g., 50)
   */
  function getWhitelistedComplications(uint256 cursor, uint256 size) external view returns (address[] memory, uint256) {
    uint256 length = size;

    if (length > _whitelistedComplications.length() - cursor) {
      length = _whitelistedComplications.length() - cursor;
    }

    address[] memory whitelistedComplications = new address[](length);

    for (uint256 i = 0; i < length; i++) {
      whitelistedComplications[i] = _whitelistedComplications.at(cursor + i);
    }

    return (whitelistedComplications, cursor + length);
  }
}
