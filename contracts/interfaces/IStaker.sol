// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {OrderTypes} from '../libs/OrderTypes.sol';

enum Duration {
  NONE,
  THREE_MONTHS,
  SIX_MONTHS,
  TWELVE_MONTHS
}

enum StakeLevel {
  NONE,
  BRONZE,
  SILVER,
  GOLD,
  PLATINUM
}

interface IStaker {
  function stake(
    address user,
    uint256 amount,
    Duration duration
  ) external;

  function changeDuration(
    uint256 amount,
    Duration oldDuration,
    Duration newDuration
  ) external;

  function unstake(uint256 amount) external;

  function rageQuit() external;

  function getUserTotalStaked(address user) external view returns (uint256);

  function getUserTotalVested(address user) external view returns (uint256);

  function getRageQuitAmounts(address user) external view returns (uint256, uint256);

  function getUserStakePower(address user) external view returns (uint256);

  function getUserStakeLevel(address user) external view returns (StakeLevel);
}
