// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

import {OrderTypes} from '../libs/OrderTypes.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import {ICurrencyRegistry} from '../interfaces/ICurrencyRegistry.sol';
import {IComplicationRegistry} from '../interfaces/IComplicationRegistry.sol';
import {IComplication} from '../interfaces/IComplication.sol';
import {IInfinityExchange} from '../interfaces/IInfinityExchange.sol';
import {IInfinityFeeTreasury} from '../interfaces/IInfinityFeeTreasury.sol';
import {IInfinityTradingRewards} from '../interfaces/IInfinityTradingRewards.sol';
import {SignatureChecker} from '../libs/SignatureChecker.sol';
import {IERC165} from '@openzeppelin/contracts/interfaces/IERC165.sol';
import {IERC721} from '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import {IERC1155} from '@openzeppelin/contracts/token/ERC1155/IERC1155.sol';
import {IERC20, SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import 'hardhat/console.sol';

/**
 * @title InfinityExchange

NFTNFTNFT...........................................NFTNFTNFT
NFTNFT                                                 NFTNFT
NFT                                                       NFT
.                                                           .
.                                                           .
.                                                           .
.                                                           .
.               NFTNFTNFT            NFTNFTNFT              .
.            NFTNFTNFTNFTNFT      NFTNFTNFTNFTNFT           .
.           NFTNFTNFTNFTNFTNFT   NFTNFTNFTNFTNFTNFT         .
.         NFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFT        .
.         NFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFT        .
.         NFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFTNFT        .
.          NFTNFTNFTNFTNFTNFTN   NFTNFTNFTNFTNFTNFT         .
.            NFTNFTNFTNFTNFT      NFTNFTNFTNFTNFT           .
.               NFTNFTNFT            NFTNFTNFT              .
.                                                           .
.                                                           .
.                                                           .
.                                                           .
NFT                                                       NFT
NFTNFT                                                 NFTNFT
NFTNFTNFT...........................................NFTNFTNFT 

*/
contract InfinityExchange is IInfinityExchange, ReentrancyGuard, Ownable {
  using OrderTypes for OrderTypes.Order;
  using OrderTypes for OrderTypes.OrderItem;
  using SafeERC20 for IERC20;

  address public immutable WETH;
  bytes32 public immutable DOMAIN_SEPARATOR;

  ICurrencyRegistry public currencyRegistry;
  IComplicationRegistry public complicationRegistry;
  IInfinityFeeTreasury public infinityFeeTreasury;
  IInfinityTradingRewards public infinityTradingRewards;

  mapping(address => uint256) public userMinOrderNonce;
  mapping(address => mapping(uint256 => bool)) public isUserOrderNonceExecutedOrCancelled;
  address public matchExecutor;

  event CancelAllOrders(address user, uint256 newMinNonce);
  event CancelMultipleOrders(address user, uint256[] orderNonces);
  event NewCurrencyRegistry(address currencyRegistry);
  event NewComplicationRegistry(address complicationRegistry);
  event NewInfinityFeeTreasury(address infinityFeeTreasury);
  event NewInfinityTradingRewards(address infinityTradingRewards);
  event NewMatchExecutor(address matchExecutor);

  event OrderFulfilled(
    bytes32 sellOrderHash,
    bytes32 buyOrderHash,
    address indexed seller,
    address indexed buyer,
    address indexed complication, // address of the complication that defines the execution
    address currency, // token address of the transacting currency
    OrderTypes.OrderItem[] nfts, // nfts sold;
    uint256 amount // amount spent on the order
  );

  /**
   * @notice Constructor
   * @param _currencyRegistry currency manager address
   * @param _complicationRegistry execution manager address
   * @param _WETH wrapped ether address (for other chains, use wrapped native asset)
   * @param _matchExecutor executor address for matches
   */
  constructor(
    address _currencyRegistry,
    address _complicationRegistry,
    address _WETH,
    address _matchExecutor
  ) {
    // Calculate the domain separator
    DOMAIN_SEPARATOR = keccak256(
      abi.encode(
        keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
        keccak256('InfinityExchange'),
        keccak256(bytes('1')), // for versionId = 1
        block.chainid,
        address(this)
      )
    );

    currencyRegistry = ICurrencyRegistry(_currencyRegistry);
    complicationRegistry = IComplicationRegistry(_complicationRegistry);
    WETH = _WETH;
    matchExecutor = _matchExecutor;
  }

  // =================================================== USER FUNCTIONS =======================================================

  /**
   * @notice Cancel all pending orders
   * @param minNonce minimum user nonce
   */
  function cancelAllOrders(uint256 minNonce) external {
    // console.log('user min order nonce', msg.sender, userMinOrderNonce[msg.sender]);
    // console.log('new min order nonce', msg.sender, minNonce);
    require(minNonce > userMinOrderNonce[msg.sender], 'nonce too low');
    require(minNonce < userMinOrderNonce[msg.sender] + 1000000, 'too many');
    userMinOrderNonce[msg.sender] = minNonce;
    emit CancelAllOrders(msg.sender, minNonce);
  }

  /**
   * @notice Cancel multiple orders
   * @param orderNonces array of order nonces
   */
  function cancelMultipleOrders(uint256[] calldata orderNonces) external {
    require(orderNonces.length > 0, 'cannot be empty');
    // console.log('user min order nonce', msg.sender, userMinOrderNonce[msg.sender]);
    for (uint256 i = 0; i < orderNonces.length; i++) {
      // console.log('order nonce', orderNonces[i]);
      require(orderNonces[i] >= userMinOrderNonce[msg.sender], 'nonce too low');
      require(!isUserOrderNonceExecutedOrCancelled[msg.sender][orderNonces[i]], 'nonce already executed or cancelled');
      isUserOrderNonceExecutedOrCancelled[msg.sender][orderNonces[i]] = true;
    }
    emit CancelMultipleOrders(msg.sender, orderNonces);
  }

  function matchOrders(
    OrderTypes.Order[] calldata sells,
    OrderTypes.Order[] calldata buys,
    OrderTypes.Order[] calldata constructs,
    bool tradingRewards,
    bool feeDiscountEnabled
  ) external override nonReentrant {
    uint256 startGas = gasleft();
    // check pre-conditions
    require(sells.length == buys.length, 'mismatched lengths');
    require(sells.length == constructs.length, 'mismatched lengths');

    if (tradingRewards) {
      address[] memory sellers = new address[](sells.length);
      address[] memory buyers = new address[](sells.length);
      address[] memory currencies = new address[](sells.length);
      uint256[] memory amounts = new uint256[](sells.length);
      // execute orders one by one
      for (uint256 i = 0; i < sells.length; ) {
        (sellers[i], buyers[i], currencies[i], amounts[i]) = _matchOrders(
          sells[i],
          buys[i],
          constructs[i],
          feeDiscountEnabled
        );
        unchecked {
          ++i;
        }
      }
      infinityTradingRewards.updateRewards(sellers, buyers, currencies, amounts);
    } else {
      for (uint256 i = 0; i < sells.length; ) {
        _matchOrders(sells[i], buys[i], constructs[i], feeDiscountEnabled);
        unchecked {
          ++i;
        }
      }
    }
    // refund gas to match executor
    infinityFeeTreasury.refundMatchExecutionGasFee(startGas, sells, matchExecutor, WETH);
  }

  function takeOrders(
    OrderTypes.Order[] calldata makerOrders,
    OrderTypes.Order[] calldata takerOrders,
    bool tradingRewards,
    bool feeDiscountEnabled
  ) external payable override nonReentrant {
    // check pre-conditions
    require(makerOrders.length == takerOrders.length, 'mismatched lengths');

    if (tradingRewards) {
      // console.log('trading rewards enabled');
      address[] memory sellers = new address[](makerOrders.length);
      address[] memory buyers = new address[](makerOrders.length);
      address[] memory currencies = new address[](makerOrders.length);
      uint256[] memory amounts = new uint256[](makerOrders.length);
      // execute orders one by one
      for (uint256 i = 0; i < makerOrders.length; ) {
        (sellers[i], buyers[i], currencies[i], amounts[i]) = _takeOrders(
          makerOrders[i],
          takerOrders[i],
          feeDiscountEnabled
        );
        unchecked {
          ++i;
        }
      }
      infinityTradingRewards.updateRewards(sellers, buyers, currencies, amounts);
    } else {
      // console.log('no trading rewards');
      for (uint256 i = 0; i < makerOrders.length; ) {
        _takeOrders(makerOrders[i], takerOrders[i], feeDiscountEnabled);
        unchecked {
          ++i;
        }
      }
    }
  }

  function batchTransferNFTs(address to, OrderTypes.OrderItem[] calldata items) external nonReentrant {
    _batchTransferNFTs(msg.sender, to, items);
  }

  // ====================================================== VIEW FUNCTIONS ======================================================

  /**
   * @notice Check whether user order nonce is executed or cancelled
   * @param user address of user
   * @param nonce nonce of the order
   */
  function isNonceValid(address user, uint256 nonce) external view returns (bool) {
    return !isUserOrderNonceExecutedOrCancelled[user][nonce] && nonce > userMinOrderNonce[user];
  }

  function verifyOrderSig(OrderTypes.Order calldata order) external view returns (bool) {
    // Verify the validity of the signature
    // console.log('verifying order signature');
    (bytes32 r, bytes32 s, uint8 v) = abi.decode(order.sig, (bytes32, bytes32, uint8));
    // console.log('domain sep:');
    // console.logBytes32(DOMAIN_SEPARATOR);
    // console.log('signature:');
    // console.logBytes32(r);
    // console.logBytes32(s);
    // console.log(v);
    // console.log('signer', order.signer);
    return SignatureChecker.verify(_hash(order), order.signer, r, s, v, DOMAIN_SEPARATOR);
  }

  // ====================================================== INTERNAL FUNCTIONS ================================================

  function _matchOrders(
    OrderTypes.Order calldata sell,
    OrderTypes.Order calldata buy,
    OrderTypes.Order calldata constructed,
    bool feeDiscountEnabled
  )
    internal
    returns (
      address,
      address,
      address,
      uint256
    )
  {
    bytes32 sellOrderHash = _hash(sell);
    bytes32 buyOrderHash = _hash(buy);

    // if this order is not valid, just return and continue with other orders
    (bool orderVerified, uint256 execPrice) = _verifyOrders(sellOrderHash, buyOrderHash, sell, buy, constructed);
    if (!orderVerified) {
      // console.log('skipping invalid order');
      return (address(0), address(0), address(0), 0);
    }

    return _execMatchOrders(sellOrderHash, buyOrderHash, sell, buy, constructed, execPrice, feeDiscountEnabled);
  }

  function _execMatchOrders(
    bytes32 sellOrderHash,
    bytes32 buyOrderHash,
    OrderTypes.Order calldata sell,
    OrderTypes.Order calldata buy,
    OrderTypes.Order calldata constructed,
    uint256 execPrice,
    bool feeDiscountEnabled
  )
    internal
    returns (
      address,
      address,
      address,
      uint256
    )
  {
    // exec order
    return
      _execOrder(
        sellOrderHash,
        buyOrderHash,
        sell.signer,
        buy.signer,
        sell.constraints[6],
        buy.constraints[6],
        sell.constraints[5],
        constructed,
        execPrice,
        feeDiscountEnabled
      );
  }

  function _takeOrders(
    OrderTypes.Order calldata makerOrder,
    OrderTypes.Order calldata takerOrder,
    bool feeDiscountEnabled
  )
    internal
    returns (
      address,
      address,
      address,
      uint256
    )
  {
    // console.log('taking order');
    bytes32 makerOrderHash = _hash(makerOrder);
    bytes32 takerOrderHash = _hash(takerOrder);

    // if this order is not valid, just return and continue with other orders
    (bool orderVerified, uint256 execPrice) = _verifyTakeOrders(makerOrderHash, makerOrder, takerOrder);
    if (!orderVerified) {
      // console.log('skipping invalid order');
      return (address(0), address(0), address(0), 0);
    }

    // exec order
    return _exectakeOrders(makerOrderHash, takerOrderHash, makerOrder, takerOrder, execPrice, feeDiscountEnabled);
  }

  function _exectakeOrders(
    bytes32 makerOrderHash,
    bytes32 takerOrderHash,
    OrderTypes.Order calldata makerOrder,
    OrderTypes.Order calldata takerOrder,
    uint256 execPrice,
    bool feeDiscountEnabled
  )
    internal
    returns (
      address,
      address,
      address,
      uint256
    )
  {
    // exec order
    bool isTakerSell = takerOrder.isSellOrder;
    if (isTakerSell) {
      return _execTakerSellOrder(takerOrderHash, makerOrderHash, takerOrder, makerOrder, execPrice, feeDiscountEnabled);
    } else {
      return _execTakerBuyOrder(takerOrderHash, makerOrderHash, takerOrder, makerOrder, execPrice, feeDiscountEnabled);
    }
  }

  function _execTakerSellOrder(
    bytes32 takerOrderHash,
    bytes32 makerOrderHash,
    OrderTypes.Order calldata takerOrder,
    OrderTypes.Order calldata makerOrder,
    uint256 execPrice,
    bool feeDiscountEnabled
  )
    internal
    returns (
      address,
      address,
      address,
      uint256
    )
  {
    // console.log('executing taker sell order');
    return
      _execOrder(
        takerOrderHash,
        makerOrderHash,
        takerOrder.signer,
        makerOrder.signer,
        takerOrder.constraints[6],
        makerOrder.constraints[6],
        takerOrder.constraints[5],
        takerOrder,
        execPrice,
        feeDiscountEnabled
      );
  }

  function _execTakerBuyOrder(
    bytes32 takerOrderHash,
    bytes32 makerOrderHash,
    OrderTypes.Order calldata takerOrder,
    OrderTypes.Order calldata makerOrder,
    uint256 execPrice,
    bool feeDiscountEnabled
  )
    internal
    returns (
      address,
      address,
      address,
      uint256
    )
  {
    // console.log('executing taker buy order');
    return
      _execOrder(
        makerOrderHash,
        takerOrderHash,
        makerOrder.signer,
        takerOrder.signer,
        makerOrder.constraints[6],
        takerOrder.constraints[6],
        makerOrder.constraints[5],
        takerOrder,
        execPrice,
        feeDiscountEnabled
      );
  }

  function _verifyOrders(
    bytes32 sellOrderHash,
    bytes32 buyOrderHash,
    OrderTypes.Order calldata sell,
    OrderTypes.Order calldata buy,
    OrderTypes.Order calldata constructed
  ) internal view returns (bool, uint256) {
    // console.log('verifying match orders');
    bool sidesMatch = sell.isSellOrder && !buy.isSellOrder;
    bool complicationsMatch = sell.execParams[0] == buy.execParams[0];
    bool currenciesMatch = sell.execParams[1] == buy.execParams[1];
    bool sellOrderValid = _isOrderValid(sell, sellOrderHash);
    bool buyOrderValid = _isOrderValid(buy, buyOrderHash);
    (bool executionValid, uint256 execPrice) = IComplication(sell.execParams[0]).canExecOrder(sell, buy, constructed);
    // console.log('sidesMatch', sidesMatch);
    // console.log('complicationsMatch', complicationsMatch);
    // console.log('currenciesMatch', currenciesMatch);
    // console.log('sellOrderValid', sellOrderValid);
    // console.log('buyOrderValid', buyOrderValid);
    // console.log('executionValid', executionValid);
    return (
      sidesMatch && complicationsMatch && currenciesMatch && sellOrderValid && buyOrderValid && executionValid,
      execPrice
    );
  }

  function _verifyTakeOrders(
    bytes32 makerOrderHash,
    OrderTypes.Order calldata maker,
    OrderTypes.Order calldata taker
  ) internal view returns (bool, uint256) {
    // console.log('verifying take orders');
    bool msgSenderIsTaker = msg.sender == taker.signer;
    bool sidesMatch = (maker.isSellOrder && !taker.isSellOrder) || (!maker.isSellOrder && taker.isSellOrder);
    bool complicationsMatch = maker.execParams[0] == taker.execParams[0];
    bool currenciesMatch = maker.execParams[1] == taker.execParams[1];
    bool makerOrderValid = _isOrderValid(maker, makerOrderHash);
    (bool executionValid, uint256 execPrice) = IComplication(maker.execParams[0]).canExecTakeOrder(maker, taker);
    // console.log('msgSenderIsTaker', msgSenderIsTaker);
    // console.log('sidesMatch', sidesMatch);
    // console.log('complicationsMatch', complicationsMatch);
    // console.log('currenciesMatch', currenciesMatch);
    // console.log('makerOrderValid', makerOrderValid);
    // console.log('executionValid', executionValid);
    return (
      msgSenderIsTaker && sidesMatch && complicationsMatch && currenciesMatch && makerOrderValid && executionValid,
      execPrice
    );
  }

  /**
   * @notice Verifies the validity of the order
   * @param order the order
   * @param orderHash computed hash of the order
   */
  function _isOrderValid(OrderTypes.Order calldata order, bytes32 orderHash) internal view returns (bool) {
    return
      _orderValidity(
        order.signer,
        order.sig,
        orderHash,
        order.execParams[0],
        order.execParams[1],
        order.constraints[6]
      );
  }

  function _orderValidity(
    address signer,
    bytes calldata sig,
    bytes32 orderHash,
    address complication,
    address currency,
    uint256 nonce
  ) internal view returns (bool) {
    // console.log('checking order validity');
    bool orderExpired = isUserOrderNonceExecutedOrCancelled[signer][nonce] || nonce < userMinOrderNonce[signer];
    // console.log('order expired:', orderExpired);
    // Verify the validity of the signature
    (bytes32 r, bytes32 s, uint8 v) = abi.decode(sig, (bytes32, bytes32, uint8));
    bool sigValid = SignatureChecker.verify(orderHash, signer, r, s, v, DOMAIN_SEPARATOR);

    if (
      orderExpired ||
      !sigValid ||
      signer == address(0) ||
      !currencyRegistry.isCurrencyWhitelisted(currency) ||
      !complicationRegistry.isComplicationWhitelisted(complication)
    ) {
      return false;
    }
    return true;
  }

  function _execOrder(
    bytes32 sellOrderHash,
    bytes32 buyOrderHash,
    address seller,
    address buyer,
    uint256 sellNonce,
    uint256 buyNonce,
    uint256 minBpsToSeller,
    OrderTypes.Order calldata constructed,
    uint256 execPrice,
    bool feeDiscountEnabled
  )
    internal
    returns (
      address,
      address,
      address,
      uint256
    )
  {
    // console.log('executing order');
    // Update order execution status to true (prevents replay)
    isUserOrderNonceExecutedOrCancelled[seller][sellNonce] = true;
    isUserOrderNonceExecutedOrCancelled[buyer][buyNonce] = true;

    _transferNFTsAndFees(
      seller,
      buyer,
      constructed.nfts,
      execPrice,
      constructed.execParams[1],
      minBpsToSeller,
      constructed.execParams[0],
      feeDiscountEnabled
    );

    _emitEvent(sellOrderHash, buyOrderHash, seller, buyer, constructed, execPrice);

    return (seller, buyer, constructed.execParams[1], execPrice);
  }

  function _emitEvent(
    bytes32 sellOrderHash,
    bytes32 buyOrderHash,
    address seller,
    address buyer,
    OrderTypes.Order calldata constructed,
    uint256 amount
  ) internal {
    emit OrderFulfilled(
      sellOrderHash,
      buyOrderHash,
      seller,
      buyer,
      constructed.execParams[0],
      constructed.execParams[1],
      constructed.nfts,
      amount
    );
  }

  function _transferNFTsAndFees(
    address seller,
    address buyer,
    OrderTypes.OrderItem[] calldata nfts,
    uint256 amount,
    address currency,
    uint256 minBpsToSeller,
    address complication,
    bool feeDiscountEnabled
  ) internal {
    // console.log('transfering nfts and fees');
    // transfer NFTs
    _batchTransferNFTs(seller, buyer, nfts);
    // transfer fees
    _transferFees(seller, buyer, nfts, amount, currency, minBpsToSeller, complication, feeDiscountEnabled);
  }

  function _batchTransferNFTs(
    address from,
    address to,
    OrderTypes.OrderItem[] calldata nfts
  ) internal {
    // console.log('batch transfering nfts');
    for (uint256 i = 0; i < nfts.length; ) {
      _transferNFTs(from, to, nfts[i]);
      unchecked {
        ++i;
      }
    }
  }

  /**
   * @notice Transfer NFT
   * @param from address of the sender
   * @param to address of the recipient
   * @param item item to transfer
   */
  function _transferNFTs(
    address from,
    address to,
    OrderTypes.OrderItem calldata item
  ) internal {
    if (IERC165(item.collection).supportsInterface(0x80ac58cd)) {
      _transferERC721s(from, to, item);
    } else if (IERC165(item.collection).supportsInterface(0xd9b67a26)) {
      _transferERC1155s(from, to, item);
    }
  }

  function _transferERC721s(
    address from,
    address to,
    OrderTypes.OrderItem calldata item
  ) internal {
    for (uint256 i = 0; i < item.tokens.length; ) {
      // console.log('transfering erc721 from collection', item.collection, 'with tokenId', item.tokens[i].tokenId);
      // console.log('from address', from, 'to address', to);
      IERC721(item.collection).safeTransferFrom(from, to, item.tokens[i].tokenId);
      unchecked {
        ++i;
      }
    }
  }

  function _transferERC1155s(
    address from,
    address to,
    OrderTypes.OrderItem calldata item
  ) internal {
    for (uint256 i = 0; i < item.tokens.length; ) {
      // console.log('transfering erc1155 from collection', item.collection, 'with tokenId', item.tokens[i].tokenId);
      // console.log('num tokens', item.tokens[i].numTokens);
      // console.log('from address', from, 'to address', to);
      IERC1155(item.collection).safeTransferFrom(from, to, item.tokens[i].tokenId, item.tokens[i].numTokens, '');
      unchecked {
        ++i;
      }
    }
  }

  function _transferFees(
    address seller,
    address buyer,
    OrderTypes.OrderItem[] calldata nfts,
    uint256 amount,
    address currency,
    uint256 minBpsToSeller,
    address complication,
    bool feeDiscountEnabled
  ) internal {
    // console.log('transfering fees');
    infinityFeeTreasury.allocateFees{value: msg.value}(
      seller,
      buyer,
      nfts,
      amount,
      currency,
      minBpsToSeller,
      complication,
      feeDiscountEnabled
    );
  }

  function _hash(OrderTypes.Order calldata order) internal pure returns (bytes32) {
    // keccak256('Order(bool isSellOrder,address signer,uint256[] constraints,OrderItem[] nfts,address[] execParams,bytes extraParams)OrderItem(address collection,TokenInfo[] tokens)TokenInfo(uint256 tokenId,uint256 numTokens)')
    bytes32 ORDER_HASH = 0x7bcfb5a29031e6b8d34ca1a14dd0a1f5cb11b20f755bb2a31ee3c4b143477e4a;
    bytes32 orderHash = keccak256(
      abi.encode(
        ORDER_HASH,
        order.isSellOrder,
        order.signer,
        keccak256(abi.encodePacked(order.constraints)),
        _nftsHash(order.nfts),
        keccak256(abi.encodePacked(order.execParams)),
        keccak256(order.extraParams)
      )
    );
    // console.log('order hash:');
    // console.logBytes32(orderHash);
    return orderHash;
  }

  function _nftsHash(OrderTypes.OrderItem[] calldata nfts) internal pure returns (bytes32) {
    // keccak256('OrderItem(address collection,TokenInfo[] tokens)TokenInfo(uint256 tokenId,uint256 numTokens)')
    // console.log('calculating nfts hash');
    bytes32 ORDER_ITEM_HASH = 0xf73f37e9f570369ceaab59cef16249ae1c0ad1afd592d656afac0be6f63b87e0;
    bytes32[] memory hashes = new bytes32[](nfts.length);
    // console.log('nfts length', nfts.length);
    for (uint256 i = 0; i < nfts.length; ) {
      bytes32 hash = keccak256(abi.encode(ORDER_ITEM_HASH, nfts[i].collection, _tokensHash(nfts[i].tokens)));
      hashes[i] = hash;
      unchecked {
        ++i;
      }
    }
    bytes32 nftsHash = keccak256(abi.encodePacked(hashes));
    // console.log('nfts hash:');
    // console.logBytes32(nftsHash);
    return nftsHash;
  }

  function _tokensHash(OrderTypes.TokenInfo[] calldata tokens) internal pure returns (bytes32) {
    // keccak256('TokenInfo(uint256 tokenId,uint256 numTokens)')
    // console.log('calculating tokens hash');
    bytes32 TOKEN_INFO_HASH = 0x88f0bd19d14f8b5d22c0605a15d9fffc285ebc8c86fb21139456d305982906f1;
    bytes32[] memory hashes = new bytes32[](tokens.length);
    // console.log('tokens length:', tokens.length);
    for (uint256 i = 0; i < tokens.length; ) {
      bytes32 hash = keccak256(abi.encode(TOKEN_INFO_HASH, tokens[i].tokenId, tokens[i].numTokens));
      hashes[i] = hash;
      unchecked {
        ++i;
      }
    }
    bytes32 tokensHash = keccak256(abi.encodePacked(hashes));
    // console.log('tokens hash:');
    // console.logBytes32(tokensHash);
    return tokensHash;
  }

  // ====================================================== ADMIN FUNCTIONS ======================================================

  function rescueTokens(
    address destination,
    address currency,
    uint256 amount
  ) external onlyOwner {
    IERC20(currency).safeTransfer(destination, amount);
  }

  function rescueETH(address destination) external payable onlyOwner {
    (bool sent, ) = destination.call{value: msg.value}('');
    require(sent, 'failed');
  }

  /**
   * @notice Update currency manager
   * @param _currencyRegistry new currency manager address
   */
  function updateCurrencyRegistry(address _currencyRegistry) external onlyOwner {
    currencyRegistry = ICurrencyRegistry(_currencyRegistry);
    emit NewCurrencyRegistry(_currencyRegistry);
  }

  /**
   * @notice Update execution manager
   * @param _complicationRegistry new execution manager address
   */
  function updateComplicationRegistry(address _complicationRegistry) external onlyOwner {
    complicationRegistry = IComplicationRegistry(_complicationRegistry);
    emit NewComplicationRegistry(_complicationRegistry);
  }

  /**
   * @notice Update fee distributor
   * @param _infinityFeeTreasury new address
   */
  function updateInfinityFeeTreasury(address _infinityFeeTreasury) external onlyOwner {
    infinityFeeTreasury = IInfinityFeeTreasury(_infinityFeeTreasury);
    emit NewInfinityFeeTreasury(_infinityFeeTreasury);
  }

  function updateInfinityTradingRewards(address _infinityTradingRewards) external onlyOwner {
    infinityTradingRewards = IInfinityTradingRewards(_infinityTradingRewards);
    emit NewInfinityTradingRewards(_infinityTradingRewards);
  }

  function updateMatchExecutor(address _matchExecutor) external onlyOwner {
    matchExecutor = _matchExecutor;
    emit NewMatchExecutor(_matchExecutor);
  }
}
