// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20, SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Pausable} from '@openzeppelin/contracts/security/Pausable.sol';
import {IStaker, Duration, StakeLevel} from '../interfaces/IStaker.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import 'hardhat/console.sol';

contract InfinityStaker is IStaker, Ownable, Pausable, ReentrancyGuard {
  using SafeERC20 for IERC20;
  struct StakeAmount {
    uint256 amount;
    uint256 timestamp;
  }
  mapping(address => mapping(Duration => StakeAmount)) public userstakedAmounts;
  address public INFINITY_TOKEN;
  address public INFINITY_TREASURY;
  address public INFINITY_REWARDS_CONTRACT;
  uint16 public BRONZE_STAKE_THRESHOLD = 1000;
  uint16 public SILVER_STAKE_THRESHOLD = 5000;
  uint16 public GOLD_STAKE_THRESHOLD = 10000;
  uint16 public PLATINUM_STAKE_THRESHOLD = 20000;
  uint16 public THREE_MONTH_PENALTY = 2;
  uint16 public SIX_MONTH_PENALTY = 3;
  uint16 public TWELVE_MONTH_PENALTY = 4;

  event Staked(address indexed user, uint256 amount, Duration duration);
  event DurationChanged(address indexed user, uint256 amount, Duration oldDuration, Duration newDuration);
  event UnStaked(address indexed user, uint256 amount);
  event RageQuit(address indexed user, uint256 totalToUser, uint256 penalty);

  constructor(address _tokenAddress, address _infinityTreasury) {
    INFINITY_TOKEN = _tokenAddress;
    INFINITY_TREASURY = _infinityTreasury;
  }

  // Fallback
  fallback() external payable {}

  receive() external payable {}

  // =================================================== USER FUNCTIONS =======================================================
  function stake(
    address user,
    uint256 amount,
    Duration duration
  ) external override nonReentrant whenNotPaused {
    // console.log('stake msg sender', msg.sender, 'infinity rewards contract', INFINITY_REWARDS_CONTRACT);
    require(msg.sender == user || msg.sender == INFINITY_REWARDS_CONTRACT, 'Only user or infinity rewards can stake');
    require(amount != 0, 'stake amount cant be 0');
    require(IERC20(INFINITY_TOKEN).balanceOf(user) >= amount, 'insufficient balance to stake');
    // console.log('staking for user', user, 'amount', amount);
    // update storage
    // console.log('block timestmap at stake', block.timestamp);
    userstakedAmounts[user][duration].amount += amount;
    userstakedAmounts[user][duration].timestamp = block.timestamp;
    // perform transfer
    // console.log('transferring', amount, 'from', user);
    // console.log('user balance before', IERC20(INFINITY_TOKEN).balanceOf(user));
    // console.log('contract balance before', IERC20(INFINITY_TOKEN).balanceOf(address(this)));
    if (msg.sender != INFINITY_REWARDS_CONTRACT) {
      IERC20(INFINITY_TOKEN).safeTransferFrom(user, address(this), amount);
    }
    // console.log('user balance after', IERC20(INFINITY_TOKEN).balanceOf(user));
    // console.log('contract balance after', IERC20(INFINITY_TOKEN).balanceOf(address(this)));
    // emit event
    emit Staked(user, amount, duration);
  }

  function changeDuration(
    uint256 amount,
    Duration oldDuration,
    Duration newDuration
  ) external override nonReentrant whenNotPaused {
    require(amount != 0, 'amount cant be 0');
    require(
      userstakedAmounts[msg.sender][oldDuration].amount >= amount,
      'insufficient staked amount to change duration'
    );
    require(newDuration > oldDuration, 'new duration must be greater than old duration');

    // update storage
    userstakedAmounts[msg.sender][oldDuration].amount -= amount;
    userstakedAmounts[msg.sender][newDuration].amount += amount;
    // only update timestamp for new duration
    userstakedAmounts[msg.sender][newDuration].timestamp = block.timestamp;
    // emit event
    emit DurationChanged(msg.sender, amount, oldDuration, newDuration);
  }

  function unstake(uint256 amount) external override nonReentrant whenNotPaused {
    require(amount != 0, 'stake amount cant be 0');
    uint256 noVesting = userstakedAmounts[msg.sender][Duration.NONE].amount;
    uint256 vestedThreeMonths = _getVestedAmount(msg.sender, Duration.THREE_MONTHS);
    uint256 vestedsixMonths = _getVestedAmount(msg.sender, Duration.SIX_MONTHS);
    uint256 vestedTwelveMonths = _getVestedAmount(msg.sender, Duration.TWELVE_MONTHS);
    uint256 totalVested = noVesting + vestedThreeMonths + vestedsixMonths + vestedTwelveMonths;
    require(totalVested >= amount, 'insufficient balance to unstake');

    // update storage
    _updateUserStakedAmounts(msg.sender, amount, noVesting, vestedThreeMonths, vestedsixMonths, vestedTwelveMonths);
    // perform transfer
    IERC20(INFINITY_TOKEN).safeTransfer(msg.sender, amount);
    // emit event
    emit UnStaked(msg.sender, amount);
  }

  function rageQuit() external override nonReentrant {
    (uint256 totalToUser, uint256 penalty) = _getRageQuitAmounts(msg.sender);
    // update storage
    _clearUserStakedAmounts(msg.sender);
    // perform transfers
    IERC20(INFINITY_TOKEN).safeTransfer(msg.sender, totalToUser);
    IERC20(INFINITY_TOKEN).safeTransfer(INFINITY_TREASURY, penalty);
    // emit event
    emit RageQuit(msg.sender, totalToUser, penalty);
  }

  // ====================================================== VIEW FUNCTIONS ======================================================

  function getUserTotalStaked(address user) external view override returns (uint256) {
    return _getUserTotalStaked(user);
  }

  function getUserTotalVested(address user) external view override returns (uint256) {
    return _getUserTotalVested(user);
  }

  function getRageQuitAmounts(address user) external view override returns (uint256, uint256) {
    return _getRageQuitAmounts(user);
  }

  function getUserStakeLevel(address user) external view override returns (StakeLevel) {
    uint256 totalPower = _getUserStakePower(user);
    // console.log('totalPower', totalPower);
    if (totalPower <= BRONZE_STAKE_THRESHOLD) {
      return StakeLevel.NONE;
    } else if (totalPower > BRONZE_STAKE_THRESHOLD && totalPower <= SILVER_STAKE_THRESHOLD) {
      return StakeLevel.BRONZE;
    } else if (totalPower > SILVER_STAKE_THRESHOLD && totalPower <= GOLD_STAKE_THRESHOLD) {
      return StakeLevel.SILVER;
    } else if (totalPower > GOLD_STAKE_THRESHOLD && totalPower <= PLATINUM_STAKE_THRESHOLD) {
      return StakeLevel.GOLD;
    } else {
      return StakeLevel.PLATINUM;
    }
  }

  function getUserStakePower(address user) external view override returns (uint256) {
    return _getUserStakePower(user);
  }

  function getVestingInfo(address user) external view returns (StakeAmount[] memory) {
    StakeAmount[] memory vestingInfo = new StakeAmount[](4);
    vestingInfo[0] = userstakedAmounts[user][Duration.NONE];
    vestingInfo[1] = userstakedAmounts[user][Duration.THREE_MONTHS];
    vestingInfo[2] = userstakedAmounts[user][Duration.SIX_MONTHS];
    vestingInfo[3] = userstakedAmounts[user][Duration.TWELVE_MONTHS];
    return vestingInfo;
  }

  // ====================================================== INTERNAL FUNCTIONS ================================================

  function _getUserTotalStaked(address user) internal view returns (uint256) {
    return
      userstakedAmounts[user][Duration.NONE].amount +
      userstakedAmounts[user][Duration.THREE_MONTHS].amount +
      userstakedAmounts[user][Duration.SIX_MONTHS].amount +
      userstakedAmounts[user][Duration.TWELVE_MONTHS].amount;
  }

  function _getUserTotalVested(address user) internal view returns (uint256) {
    uint256 noVesting = _getVestedAmount(user, Duration.NONE);
    uint256 vestedThreeMonths = _getVestedAmount(user, Duration.THREE_MONTHS);
    uint256 vestedsixMonths = _getVestedAmount(user, Duration.SIX_MONTHS);
    uint256 vestedTwelveMonths = _getVestedAmount(user, Duration.TWELVE_MONTHS);
    return noVesting + vestedThreeMonths + vestedsixMonths + vestedTwelveMonths;
  }

  function _getRageQuitAmounts(address user) internal view returns (uint256, uint256) {
    uint256 noLock = userstakedAmounts[user][Duration.NONE].amount;
    uint256 threeMonthLock = userstakedAmounts[user][Duration.THREE_MONTHS].amount;
    uint256 sixMonthLock = userstakedAmounts[user][Duration.SIX_MONTHS].amount;
    uint256 twelveMonthLock = userstakedAmounts[user][Duration.TWELVE_MONTHS].amount;

    uint256 threeMonthVested = _getVestedAmount(user, Duration.THREE_MONTHS);
    uint256 sixMonthVested = _getVestedAmount(user, Duration.SIX_MONTHS);
    uint256 twelveMonthVested = _getVestedAmount(user, Duration.TWELVE_MONTHS);

    uint256 totalVested = noLock + threeMonthVested + sixMonthVested + twelveMonthVested;
    uint256 totalStaked = noLock + threeMonthLock + sixMonthLock + twelveMonthLock;
    require(totalStaked >= 0, 'nothing staked to rage quit');

    uint256 totalToUser = totalVested +
      ((threeMonthLock - threeMonthVested) / THREE_MONTH_PENALTY) +
      ((sixMonthLock - sixMonthVested) / SIX_MONTH_PENALTY) +
      ((twelveMonthLock - twelveMonthVested) / TWELVE_MONTH_PENALTY);

    uint256 penalty = totalStaked - totalToUser;

    return (totalToUser, penalty);
  }

  function _getVestedAmount(address user, Duration duration) internal view returns (uint256) {
    uint256 amount = userstakedAmounts[user][duration].amount;
    uint256 timestamp = userstakedAmounts[user][duration].timestamp;
    // short circuit if no vesting for this duration
    if (timestamp == 0) {
      return 0;
    }
    uint256 durationInSeconds = _getDurationInSeconds(duration);
    uint256 secondsSinceStake = block.timestamp - timestamp;
    // console.log('====================== fetching vested amount =========================');
    // console.log('stake amount', amount);
    // console.log('durationInSeconds', durationInSeconds);
    // console.log('current block timestamp', block.timestamp);
    // console.log('stake timestamp', timestamp);
    // console.log('secondsSinceStake', secondsSinceStake);
    return secondsSinceStake >= durationInSeconds ? amount : 0;
  }

  function _getDurationInSeconds(Duration duration) internal pure returns (uint256) {
    if (duration == Duration.THREE_MONTHS) {
      return 90 days;
    } else if (duration == Duration.SIX_MONTHS) {
      return 180 days;
    } else if (duration == Duration.TWELVE_MONTHS) {
      return 360 days;
    } else {
      return 0 seconds;
    }
  }

  function _getUserStakePower(address user) internal view returns (uint256) {
    return
      ((userstakedAmounts[user][Duration.NONE].amount * 1) +
        (userstakedAmounts[user][Duration.THREE_MONTHS].amount * 2) +
        (userstakedAmounts[user][Duration.SIX_MONTHS].amount * 3) +
        (userstakedAmounts[user][Duration.TWELVE_MONTHS].amount * 4)) / (10**18);
  }

  // a recursive impl is possible but this is more gas efficient
  function _updateUserStakedAmounts(
    address user,
    uint256 amount,
    uint256 noVesting,
    uint256 vestedThreeMonths,
    uint256 vestedSixMonths,
    uint256 vestedTwelveMonths
  ) internal {
    if (amount > noVesting) {
      userstakedAmounts[user][Duration.NONE].amount = 0;
      userstakedAmounts[user][Duration.NONE].timestamp = 0;
      amount = amount - noVesting;
      if (amount > vestedThreeMonths) {
        userstakedAmounts[user][Duration.THREE_MONTHS].amount = 0;
        userstakedAmounts[user][Duration.THREE_MONTHS].timestamp = 0;
        amount = amount - vestedThreeMonths;
        if (amount > vestedSixMonths) {
          userstakedAmounts[user][Duration.SIX_MONTHS].amount = 0;
          userstakedAmounts[user][Duration.SIX_MONTHS].timestamp = 0;
          amount = amount - vestedSixMonths;
          if (amount > vestedTwelveMonths) {
            userstakedAmounts[user][Duration.TWELVE_MONTHS].amount = 0;
            userstakedAmounts[user][Duration.TWELVE_MONTHS].timestamp = 0;
          } else {
            userstakedAmounts[user][Duration.TWELVE_MONTHS].amount -= amount;
          }
        } else {
          userstakedAmounts[user][Duration.SIX_MONTHS].amount -= amount;
        }
      } else {
        userstakedAmounts[user][Duration.THREE_MONTHS].amount -= amount;
      }
    } else {
      userstakedAmounts[user][Duration.NONE].amount -= amount;
    }
  }

  function _clearUserStakedAmounts(address user) internal {
    // clear amounts
    userstakedAmounts[user][Duration.NONE].amount = 0;
    userstakedAmounts[user][Duration.THREE_MONTHS].amount = 0;
    userstakedAmounts[user][Duration.SIX_MONTHS].amount = 0;
    userstakedAmounts[user][Duration.TWELVE_MONTHS].amount = 0;

    // clear timestamps
    userstakedAmounts[user][Duration.NONE].timestamp = 0;
    userstakedAmounts[user][Duration.THREE_MONTHS].timestamp = 0;
    userstakedAmounts[user][Duration.SIX_MONTHS].timestamp = 0;
    userstakedAmounts[user][Duration.TWELVE_MONTHS].timestamp = 0;
  }

  // ====================================================== ADMIN FUNCTIONS ================================================

  function rescueETH(address destination) external payable onlyOwner {
    (bool sent, ) = destination.call{value: msg.value}('');
    require(sent, 'Failed to send Ether');
  }

  function updateStakeLevelThreshold(StakeLevel stakeLevel, uint16 threshold) external onlyOwner {
    if (stakeLevel == StakeLevel.BRONZE) {
      BRONZE_STAKE_THRESHOLD = threshold;
    } else if (stakeLevel == StakeLevel.SILVER) {
      SILVER_STAKE_THRESHOLD = threshold;
    } else if (stakeLevel == StakeLevel.GOLD) {
      GOLD_STAKE_THRESHOLD = threshold;
    } else if (stakeLevel == StakeLevel.PLATINUM) {
      PLATINUM_STAKE_THRESHOLD = threshold;
    }
  }

  function updatePenalties(
    uint16 threeMonthPenalty,
    uint16 sixMonthPenalty,
    uint16 twelveMonthPenalty
  ) external onlyOwner {
    THREE_MONTH_PENALTY = threeMonthPenalty;
    SIX_MONTH_PENALTY = sixMonthPenalty;
    TWELVE_MONTH_PENALTY = twelveMonthPenalty;
  }

  function updateInfinityTreasury(address _infinityTreasury) external onlyOwner {
    INFINITY_TREASURY = _infinityTreasury;
  }

  function updateInfinityRewardsContract(address _infinityRewardsContract) external onlyOwner {
    INFINITY_REWARDS_CONTRACT = _infinityRewardsContract;
  }
}
