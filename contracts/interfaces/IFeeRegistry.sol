// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

interface IFeeRegistry {
  function registerFeeDestinations(
    address collection,
    address setter,
    address[] calldata destinations,
    uint16[] calldata bpsSplits
  ) external;

  function getFeeInfo(address collection)
    external
    view
    returns (
      address,
      address[] calldata,
      uint16[] calldata
    );
}
