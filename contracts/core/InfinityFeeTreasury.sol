// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IInfinityFeeTreasury, OrderTypes} from '../interfaces/IInfinityFeeTreasury.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import {IERC20, SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IComplication} from '../interfaces/IComplication.sol';
import {IStaker, StakeLevel} from '../interfaces/IStaker.sol';
import {IFeeManager, FeeParty} from '../interfaces/IFeeManager.sol';
import {IMerkleDistributor} from '../interfaces/IMerkleDistributor.sol';
import 'hardhat/console.sol';

/**
 * @title InfinityFeeTreasury
 * @notice allocates and disburses fees to all parties: creators/curators
 */
contract InfinityFeeTreasury is IInfinityFeeTreasury, IMerkleDistributor, Ownable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  address public INFINITY_EXCHANGE;
  address public STAKER_CONTRACT;
  address public CREATOR_FEE_MANAGER;

  uint16 public CURATOR_FEE_BPS = 250;

  uint16 public BRONZE_EFFECTIVE_FEE_BPS = 10000;
  uint16 public SILVER_EFFECTIVE_FEE_BPS = 10000;
  uint16 public GOLD_EFFECTIVE_FEE_BPS = 10000;
  uint16 public PLATINUM_EFFECTIVE_FEE_BPS = 10000;

  event CreatorFeesClaimed(address indexed user, address currency, uint256 amount);
  event CuratorFeesClaimed(address indexed user, address currency, uint256 amount);

  event StakerContractUpdated(address stakingContract);
  event CreatorFeeManagerUpdated(address manager);
  event CollectorFeeManagerUpdated(address manager);

  event CuratorFeeUpdated(uint16 newBps);
  event EffectiveFeeBpsUpdated(StakeLevel level, uint16 newBps);

  event FeeAllocated(address collection, address currency, uint256 totalFees);

  // creator address to currency to amount
  mapping(address => mapping(address => uint256)) public creatorFees;
  // currency to amount
  mapping(address => uint256) public curatorFees;
  // currency address to root
  mapping(address => bytes32) public merkleRoots;
  // user to currency to claimed amount
  mapping(address => mapping(address => uint256)) public cumulativeClaimed;

  constructor(
    address _infinityExchange,
    address _stakerContract,
    address _creatorFeeManager
  ) {
    INFINITY_EXCHANGE = _infinityExchange;
    STAKER_CONTRACT = _stakerContract;
    CREATOR_FEE_MANAGER = _creatorFeeManager;
  }

  fallback() external payable {}

  receive() external payable {}

  function allocateFees(
    address seller,
    address buyer,
    OrderTypes.OrderItem[] calldata items,
    uint256 amount,
    address currency,
    uint256 minBpsToSeller,
    address execComplication,
    bool feeDiscountEnabled
  ) external payable override nonReentrant {
    // console.log('allocating fees');
    require(msg.sender == INFINITY_EXCHANGE, 'Fee distribution: Only Infinity exchange');
    // token staker discount
    uint16 effectiveFeeBps = 10000;
    if (feeDiscountEnabled) {
      effectiveFeeBps = _getEffectiveFeeBps(seller);
    }
    // console.log('effective fee bps', effectiveFeeBps);

    // creator fee
    uint256 totalFees = _allocateFeesToCreators(execComplication, items, amount, currency);

    // curator fee
    totalFees += _allocateFeesToCurators(amount, currency, effectiveFeeBps);

    // check min bps to seller is met
    // console.log('amount:', amount);
    // console.log('totalFees:', totalFees);
    uint256 remainingAmount = amount - totalFees;
    // console.log('remainingAmount:', remainingAmount);
    require((remainingAmount * 10000) >= (minBpsToSeller * amount), 'Fees: Higher than expected');

    // transfer fees to contract
    // console.log('transferring total fees', totalFees);
    // ETH
    if (currency == address(0)) {
      require(msg.value >= amount, 'insufficient amount sent');
      // transfer amount to seller
      (bool sent, ) = seller.call{value: remainingAmount}('');
      require(sent, 'failed to send ether to seller');
    } else {
      IERC20(currency).safeTransferFrom(buyer, address(this), totalFees);
      // transfer final amount (post-fees) to seller
      IERC20(currency).safeTransferFrom(buyer, seller, remainingAmount);
    }

    // emit events
    for (uint256 i = 0; i < items.length; ) {
      // fee allocated per collection is simply totalFee divided by number of collections in the order
      emit FeeAllocated(items[i].collection, currency, totalFees / items.length);
      unchecked {
        ++i;
      }
    }
  }

  function refundMatchExecutionGasFee(
    uint256 startGas,
    OrderTypes.Order[] calldata sells,
    address matchExecutor,
    address weth
  ) external override nonReentrant {
    // console.log('refunding gas fees');
    require(msg.sender == INFINITY_EXCHANGE, 'Gas fee refund: Only Infinity exchange');
    for (uint256 i = 0; i < sells.length; ) {
      _refundMatchExecutionGasFee(startGas, sells[i].signer, matchExecutor, weth);
      unchecked {
        ++i;
      }
    }
  }

  function _refundMatchExecutionGasFee(
    uint256 startGas,
    address seller,
    address matchExecutor,
    address weth
  ) internal {
    // console.log('refunding gas fees to executor for sale executed on behalf of', seller);
    uint256 gasCost = (startGas - gasleft() + 50000) * tx.gasprice;
    // console.log('gasCost:', gasCost);
    IERC20(weth).safeTransferFrom(seller, matchExecutor, gasCost);
  }

  function claimCreatorFees(address currency) external override nonReentrant {
    require(creatorFees[msg.sender][currency] > 0, 'Fees: No creator fees to claim');
    // ETH
    if (currency == address(0)) {
      (bool sent, ) = msg.sender.call{value: creatorFees[msg.sender][currency]}('');
      require(sent, 'failed to send ether');
    } else {
      IERC20(currency).safeTransfer(msg.sender, creatorFees[msg.sender][currency]);
    }
    creatorFees[msg.sender][currency] = 0;
    emit CreatorFeesClaimed(msg.sender, currency, creatorFees[msg.sender][currency]);
  }

  function claimCuratorFees(
    address currency,
    uint256 cumulativeAmount,
    bytes32 expectedMerkleRoot,
    bytes32[] calldata merkleProof
  ) external override nonReentrant {
    // process
    _processClaim(currency, cumulativeAmount, expectedMerkleRoot, merkleProof);

    // transfer
    unchecked {
      uint256 amount = cumulativeAmount - cumulativeClaimed[msg.sender][currency];
      curatorFees[currency] -= amount;
      if (currency == address(0)) {
        (bool sent, ) = msg.sender.call{value: amount}('');
        require(sent, 'failed to send ether');
      } else {
        IERC20(currency).safeTransfer(msg.sender, amount);
      }
      emit CuratorFeesClaimed(msg.sender, currency, amount);
    }
  }

  function verify(
    bytes32[] calldata proof,
    bytes32 root,
    bytes32 leaf
  ) external pure override returns (bool) {
    return _verifyAsm(proof, root, leaf);
  }

  // ====================================================== INTERNAL FUNCTIONS ================================================

  function _processClaim(
    address currency,
    uint256 cumulativeAmount,
    bytes32 expectedMerkleRoot,
    bytes32[] calldata merkleProof
  ) internal {
    require(merkleRoots[currency] == expectedMerkleRoot, 'invalid merkle root');

    // Verify the merkle proof
    bytes32 leaf = keccak256(abi.encodePacked(msg.sender, cumulativeAmount));
    require(_verifyAsm(merkleProof, expectedMerkleRoot, leaf), 'invalid merkle proof');

    // Mark it claimed
    uint256 preclaimed = cumulativeClaimed[msg.sender][currency];
    require(preclaimed < cumulativeAmount, 'merkle: nothing to claim');
    cumulativeClaimed[msg.sender][currency] = cumulativeAmount;
  }

  function _getEffectiveFeeBps(address user) internal view returns (uint16) {
    StakeLevel stakeLevel = IStaker(STAKER_CONTRACT).getUserStakeLevel(user);
    if (stakeLevel == StakeLevel.BRONZE) {
      // console.log('user is bronze');
      return BRONZE_EFFECTIVE_FEE_BPS;
    } else if (stakeLevel == StakeLevel.SILVER) {
      // console.log('user is silver');
      return SILVER_EFFECTIVE_FEE_BPS;
    } else if (stakeLevel == StakeLevel.GOLD) {
      // console.log('user is gold');
      return GOLD_EFFECTIVE_FEE_BPS;
    } else if (stakeLevel == StakeLevel.PLATINUM) {
      // console.log('user is platinum');
      return PLATINUM_EFFECTIVE_FEE_BPS;
    }
    return 10000;
  }

  function _allocateFeesToCreators(
    address execComplication,
    OrderTypes.OrderItem[] calldata items,
    uint256 amount,
    address currency
  ) internal returns (uint256) {
    // console.log('allocating fees to creators');
    // console.log('avg sale price', amount / items.length);
    uint256 creatorsFee = 0;
    IFeeManager feeManager = IFeeManager(CREATOR_FEE_MANAGER);
    for (uint256 h = 0; h < items.length; ) {
      (, address[] memory feeRecipients, uint256[] memory feeAmounts) = feeManager.calcFeesAndGetRecipients(
        execComplication,
        items[h].collection,
        0, // to comply with ierc2981 and royalty registry
        amount / items.length // amount per collection on avg
      );
      // console.log('collection', items[h].collection, 'num feeRecipients:', feeRecipients.length);
      for (uint256 i = 0; i < feeRecipients.length; ) {
        if (feeRecipients[i] != address(0) && feeAmounts[i] != 0) {
          // console.log('fee amount', i, feeAmounts[i]);
          creatorFees[feeRecipients[i]][currency] += feeAmounts[i];
          creatorsFee += feeAmounts[i];
        }
        unchecked {
          ++i;
        }
      }
      unchecked {
        ++h;
      }
    }
    // console.log('creatorsFee:', creatorsFee);
    return creatorsFee;
  }

  function _allocateFeesToCurators(
    uint256 amount,
    address currency,
    uint16 effectiveFeeBps
  ) internal returns (uint256) {
    // console.log('allocating fees to curators');
    uint256 curatorsFee = (((CURATOR_FEE_BPS * amount) / 10000) * effectiveFeeBps) / 10000;
    // update storage
    curatorFees[currency] += curatorsFee;
    // console.log('curatorsFee:', curatorsFee);
    return curatorsFee;
  }

  function _verifyAsm(
    bytes32[] calldata proof,
    bytes32 root,
    bytes32 leaf
  ) private pure returns (bool valid) {
    // solhint-disable-next-line no-inline-assembly
    assembly {
      let mem1 := mload(0x40)
      let mem2 := add(mem1, 0x20)
      let ptr := proof.offset

      for {
        let end := add(ptr, mul(0x20, proof.length))
      } lt(ptr, end) {
        ptr := add(ptr, 0x20)
      } {
        let node := calldataload(ptr)

        switch lt(leaf, node)
        case 1 {
          mstore(mem1, leaf)
          mstore(mem2, node)
        }
        default {
          mstore(mem1, node)
          mstore(mem2, leaf)
        }

        leaf := keccak256(mem1, 0x40)
      }

      valid := eq(root, leaf)
    }
  }

  // ====================================================== VIEW FUNCTIONS ================================================

  function getEffectiveFeeBps(address user) external view override returns (uint16) {
    return _getEffectiveFeeBps(user);
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

  function updateStakingContractAddress(address _stakerContract) external onlyOwner {
    STAKER_CONTRACT = _stakerContract;
    emit StakerContractUpdated(_stakerContract);
  }

  function updateCreatorFeeManager(address manager) external onlyOwner {
    CREATOR_FEE_MANAGER = manager;
    emit CreatorFeeManagerUpdated(manager);
  }

  function updateCuratorFees(uint16 bps) external onlyOwner {
    CURATOR_FEE_BPS = bps;
    emit CuratorFeeUpdated(bps);
  }

  function updateEffectiveFeeBps(StakeLevel stakeLevel, uint16 bps) external onlyOwner {
    if (stakeLevel == StakeLevel.BRONZE) {
      BRONZE_EFFECTIVE_FEE_BPS = bps;
    } else if (stakeLevel == StakeLevel.SILVER) {
      SILVER_EFFECTIVE_FEE_BPS = bps;
    } else if (stakeLevel == StakeLevel.GOLD) {
      GOLD_EFFECTIVE_FEE_BPS = bps;
    } else if (stakeLevel == StakeLevel.PLATINUM) {
      PLATINUM_EFFECTIVE_FEE_BPS = bps;
    }
    emit EffectiveFeeBpsUpdated(stakeLevel, bps);
  }

  function setMerkleRoot(address currency, bytes32 _merkleRoot) external override onlyOwner {
    emit MerkelRootUpdated(currency, merkleRoots[currency], _merkleRoot);
    merkleRoots[currency] = _merkleRoot;
  }
}
