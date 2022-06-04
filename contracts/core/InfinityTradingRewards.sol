// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20, SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IStaker, StakeLevel, Duration} from '../interfaces/IStaker.sol';
import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import {IInfinityTradingRewards} from '../interfaces/IInfinityTradingRewards.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import 'hardhat/console.sol';

/**
 * @title InfinityTradingRewards
 * @notice allocates and distributes trading rewards
 */
contract InfinityTradingRewards is IInfinityTradingRewards, Ownable, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using EnumerableSet for EnumerableSet.AddressSet;

  EnumerableSet.AddressSet private _rewardTokens;

  address public INFINTY_EXCHANGE;
  address public INFINITY_STAKER;
  address public INFINITY_TOKEN;

  // user to reward currency to balance
  mapping(address => mapping(address => uint256)) public earnedRewards;
  // txn currency to reward currency to amount; e.g: 1 WETH = how many $NFT?
  mapping(address => mapping(address => uint256)) public rewardsMap;

  event RewardClaimed(address indexed user, address currency, uint256 amount);
  event RewardStaked(address indexed user, address currency, uint256 amount);
  event RewardTokenAdded(address indexed rewardToken);
  event RewardTokenRemoved(address indexed rewardToken);
  event Funded(address rewardToken, address source, uint256 amount);

  constructor(
    address _infinityExchange,
    address _staker,
    address _infinityToken
  ) {
    INFINTY_EXCHANGE = _infinityExchange;
    INFINITY_STAKER = _staker;
    INFINITY_TOKEN = _infinityToken;
  }

  // Fallback
  fallback() external payable {}

  receive() external payable {}

  function updateRewards(
    address[] calldata sellers,
    address[] calldata buyers,
    address[] calldata currencies,
    uint256[] calldata amounts
  ) external override nonReentrant {
    require(sellers.length == buyers.length, 'sellers and buyers must be same length');
    require(sellers.length == currencies.length, 'sellers and currencies must be same length');
    require(sellers.length == amounts.length, 'sellers and amounts must be same length');
    require(msg.sender == INFINTY_EXCHANGE, 'only INFINTY_EXCHANGE');

    for (uint256 j = 0; j < _rewardTokens.length(); ) {
      address rewardToken = _rewardTokens.at(j);
      for (uint256 i = 0; i < sellers.length; ) {
        uint256 rewardRatio = rewardsMap[currencies[i]][rewardToken];
        uint256 reward = amounts[i] * rewardRatio;
        earnedRewards[sellers[i]][rewardToken] += reward;
        earnedRewards[buyers[i]][rewardToken] += reward;
        unchecked {
          ++i;
        }
      }
      unchecked {
        ++j;
      }
    }
  }

  function claimRewards(address currency, uint256 amount) external override nonReentrant {
    require(earnedRewards[msg.sender][currency] >= amount, 'Not enough rewards to claim');
    earnedRewards[msg.sender][currency] -= amount;
    IERC20(currency).safeTransfer(msg.sender, amount);
    emit RewardClaimed(msg.sender, currency, amount);
  }

  function stakeInfinityRewards(uint256 amount, Duration duration) external override nonReentrant {
    // console.log('staking InfinityRewards', amount);
    require(amount > 0, 'Stake amount must be greater than 0');
    require(amount <= earnedRewards[msg.sender][INFINITY_TOKEN], 'Not enough rewards to stake');
    earnedRewards[msg.sender][INFINITY_TOKEN] -= amount;
    IERC20(INFINITY_TOKEN).safeTransfer(INFINITY_STAKER, amount);
    IStaker(INFINITY_STAKER).stake(msg.sender, amount, duration);
    emit RewardStaked(msg.sender, INFINITY_TOKEN, amount);
  }

  // ====================================================== VIEW FUNCTIONS ================================================

  function isRewardTokenAdded(address rewardToken) external view returns (bool) {
    return _rewardTokens.contains(rewardToken);
  }

  function numRewardTokens() external view returns (uint256) {
    return _rewardTokens.length();
  }

  /**
   * @notice See added reward tokens
   * @param cursor cursor (should start at 0 for first request)
   * @param size size of the response (e.g., 50)
   */
  function getRewardTokens(uint256 cursor, uint256 size) external view returns (address[] memory, uint256) {
    uint256 length = size;

    if (length > _rewardTokens.length() - cursor) {
      length = _rewardTokens.length() - cursor;
    }

    address[] memory rewardTokens = new address[](length);

    for (uint256 i = 0; i < length; i++) {
      rewardTokens[i] = _rewardTokens.at(cursor + i);
    }

    return (rewardTokens, cursor + length);
  }

  // ================================================= ADMIN FUNCTIONS ==================================================

  function rescueTokens(
    address destination,
    address currency,
    uint256 amount
  ) external onlyOwner {
    IERC20(currency).safeTransfer(destination, amount);
  }

  function rescueETH(address destination) external payable onlyOwner {
    (bool sent, ) = destination.call{value: msg.value}('');
    require(sent, 'Failed to send Ether');
  }

  function updateInfinityExchange(address infinityExchange) external onlyOwner {
    INFINTY_EXCHANGE = infinityExchange;
  }

  function updateInfinityToken(address infinityToken) external onlyOwner {
    INFINITY_TOKEN = infinityToken;
  }

  function updateInfinityStaker(address infinityStaker) external onlyOwner {
    INFINITY_STAKER = infinityStaker;
  }

  function updateRewardsMap(
    address txnCurrency,
    address rewardCurrency,
    uint256 amount
  ) external onlyOwner {
    rewardsMap[txnCurrency][rewardCurrency] = amount;
  }

  /**
   * @notice Adds a reward tokens
   * @param rewardToken address of the token
   */
  function addRewardToken(address rewardToken) external onlyOwner {
    require(!_rewardTokens.contains(rewardToken), 'Reward token already exists');
    _rewardTokens.add(rewardToken);

    emit RewardTokenAdded(rewardToken);
  }

  function removeRewardToken(address rewardToken) external onlyOwner {
    require(_rewardTokens.contains(rewardToken), 'Reward token does not exist');
    _rewardTokens.remove(rewardToken);

    emit RewardTokenRemoved(rewardToken);
  }

  function fundWithRewardToken(
    address rewardToken,
    address source,
    uint256 amount
  ) external onlyOwner {
    require(_rewardTokens.contains(rewardToken), 'Reward token does not exist');
    IERC20(rewardToken).safeTransferFrom(source, address(this), amount);
    emit Funded(rewardToken, source, amount);
  }
}
