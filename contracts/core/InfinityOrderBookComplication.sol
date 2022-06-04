// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {OrderTypes} from '../libs/OrderTypes.sol';
import {IComplication} from '../interfaces/IComplication.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import 'hardhat/console.sol';

/**
 * @title InfinityOrderBookComplication
 * @notice Complication to execute orderbook orders
 */
contract InfinityOrderBookComplication is IComplication, Ownable {
  using OrderTypes for OrderTypes.Order;
  using OrderTypes for OrderTypes.OrderItem;

  uint256 public immutable PROTOCOL_FEE;
  uint256 public ERROR_BOUND; // error bound for prices in wei

  event NewErrorbound(uint256 errorBound);

  /**
   * @notice Constructor
   * @param _protocolFee protocol fee (200 --> 2%, 400 --> 4%)
   * @param _errorBound price error bound in wei
   */
  constructor(uint256 _protocolFee, uint256 _errorBound) {
    PROTOCOL_FEE = _protocolFee;
    ERROR_BOUND = _errorBound;
  }

  function canExecOrder(
    OrderTypes.Order calldata sell,
    OrderTypes.Order calldata buy,
    OrderTypes.Order calldata constructed
  ) external view returns (bool, uint256) {
    // console.log('running canExecOrder in InfinityOrderBookComplication');
    bool isTimeValid = _isTimeValid(sell, buy);
    (bool isAmountValid, uint256 execPrice) = _isAmountValid(sell, buy, constructed);
    bool numItemsValid = _areNumItemsValid(sell, buy, constructed);
    bool itemsIntersect = _checkItemsIntersect(sell, constructed) && _checkItemsIntersect(buy, constructed);
    // console.log('isTimeValid', isTimeValid);
    // console.log('isAmountValid', isAmountValid);
    // console.log('numItemsValid', numItemsValid);
    // console.log('itemsIntersect', itemsIntersect);
    return (isTimeValid && isAmountValid && numItemsValid && itemsIntersect, execPrice);
  }

  function canExecTakeOrder(OrderTypes.Order calldata makerOrder, OrderTypes.Order calldata takerOrder)
    external
    view
    returns (bool, uint256)
  {
    // console.log('running canExecTakeOrder in InfinityOrderBookComplication');
    // check timestamps
    (uint256 startTime, uint256 endTime) = (makerOrder.constraints[3], makerOrder.constraints[4]);
    bool isTimeValid = startTime <= block.timestamp && endTime >= block.timestamp;

    (uint256 currentMakerPrice, uint256 currentTakerPrice) = (
      _getCurrentPrice(makerOrder),
      _getCurrentPrice(takerOrder)
    );
    bool isAmountValid = _arePricesWithinErrorBound(currentMakerPrice, currentTakerPrice);
    bool numItemsValid = _areTakerNumItemsValid(makerOrder, takerOrder);
    bool itemsIntersect = _checkItemsIntersect(makerOrder, takerOrder);
    // console.log('isTimeValid', isTimeValid);
    // console.log('isAmountValid', isAmountValid);
    // console.log('numItemsValid', numItemsValid);
    // console.log('itemsIntersect', itemsIntersect);

    return (isTimeValid && isAmountValid && numItemsValid && itemsIntersect, currentTakerPrice);
  }

  /**
   * @notice Return protocol fee for this complication
   * @return protocol fee
   */
  function getProtocolFee() external view override returns (uint256) {
    return PROTOCOL_FEE;
  }

  function setErrorBound(uint256 _errorBound) external onlyOwner {
    ERROR_BOUND = _errorBound;
    emit NewErrorbound(_errorBound);
  }

  // ============================================== INTERNAL FUNCTIONS ===================================================

  function _isTimeValid(OrderTypes.Order calldata sell, OrderTypes.Order calldata buy) internal view returns (bool) {
    (uint256 sellStartTime, uint256 sellEndTime) = (sell.constraints[3], sell.constraints[4]);
    (uint256 buyStartTime, uint256 buyEndTime) = (buy.constraints[3], buy.constraints[4]);
    bool isSellTimeValid = sellStartTime <= block.timestamp && sellEndTime >= block.timestamp;
    bool isBuyTimeValid = buyStartTime <= block.timestamp && buyEndTime >= block.timestamp;
    // console.log('isSellTimeValid', isSellTimeValid);
    // console.log('isBuyTimeValid', isBuyTimeValid);
    return isSellTimeValid && isBuyTimeValid;
  }

  function _isAmountValid(
    OrderTypes.Order calldata sell,
    OrderTypes.Order calldata buy,
    OrderTypes.Order calldata constructed
  ) internal view returns (bool, uint256) {
    (uint256 currentSellPrice, uint256 currentBuyPrice, uint256 currentConstructedPrice) = (
      _getCurrentPrice(sell),
      _getCurrentPrice(buy),
      _getCurrentPrice(constructed)
    );
    return (
      currentBuyPrice >= currentSellPrice && currentConstructedPrice <= currentSellPrice,
      currentConstructedPrice
    );
  }

  function _areNumItemsValid(
    OrderTypes.Order calldata sell,
    OrderTypes.Order calldata buy,
    OrderTypes.Order calldata constructed
  ) internal pure returns (bool) {
    bool numItemsWithinBounds = constructed.constraints[0] >= buy.constraints[0] &&
      buy.constraints[0] <= sell.constraints[0];

    uint256 numConstructedItems = 0;
    for (uint256 i = 0; i < constructed.nfts.length; ) {
      unchecked {
        numConstructedItems += constructed.nfts[i].tokens.length;
        ++i;
      }
    }
    bool numConstructedItemsMatch = constructed.constraints[0] == numConstructedItems;
    // console.log('numItemsWithinBounds', numItemsWithinBounds);
    // console.log('numConstructedItemsMatch', numConstructedItemsMatch);
    return numItemsWithinBounds && numConstructedItemsMatch;
  }

  function _areTakerNumItemsValid(OrderTypes.Order calldata makerOrder, OrderTypes.Order calldata takerOrder)
    internal
    pure
    returns (bool)
  {
    bool numItemsEqual = makerOrder.constraints[0] == takerOrder.constraints[0];

    uint256 numTakerItems = 0;
    for (uint256 i = 0; i < takerOrder.nfts.length; ) {
      unchecked {
        numTakerItems += takerOrder.nfts[i].tokens.length;
        ++i;
      }
    }
    bool numTakerItemsMatch = takerOrder.constraints[0] == numTakerItems;
    // console.log('numItemsEqual', numItemsEqual);
    // console.log('numTakerItemsMatch', numTakerItemsMatch);
    return numItemsEqual && numTakerItemsMatch;
  }

  function _getCurrentPrice(OrderTypes.Order calldata order) internal view returns (uint256) {
    (uint256 startPrice, uint256 endPrice) = (order.constraints[1], order.constraints[2]);
    // console.log('startPrice', startPrice, 'endPrice', endPrice);
    (uint256 startTime, uint256 endTime) = (order.constraints[3], order.constraints[4]);
    // console.log('startTime', startTime, 'endTime', endTime);
    // console.log('block.timestamp', block.timestamp);
    uint256 duration = endTime - startTime;
    // console.log('duration', duration);
    uint256 priceDiff;
    if (startPrice > endPrice) {
      priceDiff = startPrice - endPrice;
    } else {
      priceDiff = endPrice - startPrice;
    }
    if (priceDiff == 0 || duration == 0) {
      return startPrice;
    }
    uint256 elapsedTime = block.timestamp - startTime;
    // console.log('elapsedTime', elapsedTime);
    uint256 PRECISION = 10**4; // precision for division; similar to bps
    uint256 portionBps = elapsedTime > duration ? 1 : ((elapsedTime * PRECISION) / duration);
    // console.log('portion', portionBps);
    priceDiff = (priceDiff * portionBps) / PRECISION;
    // console.log('priceDiff', priceDiff);
    uint256 currentPrice;
    if (startPrice > endPrice) {
      currentPrice = startPrice - priceDiff;
    } else {
      currentPrice = startPrice + priceDiff;
    }
    // console.log('current price', currentPrice);
    return currentPrice;
  }

  function _arePricesWithinErrorBound(uint256 price1, uint256 price2) internal view returns (bool) {
    // console.log('price1', price1, 'price2', price2);
    // console.log('ERROR_BOUND', ERROR_BOUND);
    if (price1 == price2) {
      return true;
    } else if (price1 > price2 && price1 - price2 <= ERROR_BOUND) {
      return true;
    } else if (price2 > price1 && price2 - price1 <= ERROR_BOUND) {
      return true;
    } else {
      return false;
    }
  }

  function _checkItemsIntersect(OrderTypes.Order calldata makerOrder, OrderTypes.Order calldata takerOrder)
    internal
    pure
    returns (bool)
  {
    // case where maker/taker didn't specify any items
    if (makerOrder.nfts.length == 0 || takerOrder.nfts.length == 0) {
      return true;
    }

    uint256 numCollsMatched = 0;
    // check if taker has all items in maker
    for (uint256 i = 0; i < takerOrder.nfts.length; ) {
      for (uint256 j = 0; j < makerOrder.nfts.length; ) {
        if (makerOrder.nfts[j].collection == takerOrder.nfts[i].collection) {
          // increment numCollsMatched
          unchecked {
            ++numCollsMatched;
          }
          // check if tokenIds intersect
          bool tokenIdsIntersect = _checkTokenIdsIntersect(makerOrder.nfts[j], takerOrder.nfts[i]);
          require(tokenIdsIntersect, 'taker cant have more tokenIds per coll than maker');
          // short circuit
          break;
        }
        unchecked {
          ++j;
        }
      }
      unchecked {
        ++i;
      }
    }
    // console.log('collections intersect', numCollsMatched == takerOrder.nfts.length);
    return numCollsMatched == takerOrder.nfts.length;
  }

  function _checkTokenIdsIntersect(OrderTypes.OrderItem calldata makerItem, OrderTypes.OrderItem calldata takerItem)
    internal
    pure
    returns (bool)
  {
    // case where maker/taker didn't specify any tokenIds for this collection
    if (makerItem.tokens.length == 0 || takerItem.tokens.length == 0) {
      return true;
    }
    uint256 numTokenIdsPerCollMatched = 0;
    for (uint256 k = 0; k < takerItem.tokens.length; ) {
      for (uint256 l = 0; l < makerItem.tokens.length; ) {
        if (
          makerItem.tokens[l].tokenId == takerItem.tokens[k].tokenId &&
          makerItem.tokens[l].numTokens == takerItem.tokens[k].numTokens
        ) {
          // increment numTokenIdsPerCollMatched
          unchecked {
            ++numTokenIdsPerCollMatched;
          }
          break;
        }
        unchecked {
          ++l;
        }
      }
      unchecked {
        ++k;
      }
    }
    // console.log('token ids per collection intersect', numTokenIdsPerCollMatched == takerItem.tokens.length);
    return numTokenIdsPerCollMatched == takerItem.tokens.length;
  }
}
