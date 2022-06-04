// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {OrderTypes} from '../libs/OrderTypes.sol';

interface IInfinityExchange {
  function takeOrders(
    OrderTypes.Order[] calldata makerOrders,
    OrderTypes.Order[] calldata takerOrders,
    bool tradingRewards,
    bool feeDiscountEnabled
  ) external payable;

  function matchOrders(
    OrderTypes.Order[] calldata sells,
    OrderTypes.Order[] calldata buys,
    OrderTypes.Order[] calldata constructs,
    bool tradingRewards,
    bool feeDiscountEnabled
  ) external;
}
