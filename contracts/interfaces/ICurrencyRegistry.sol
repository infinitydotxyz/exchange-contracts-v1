// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

interface ICurrencyRegistry {
  function isCurrencyWhitelisted(address currency) external view returns (bool);
}
