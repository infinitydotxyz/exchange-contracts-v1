const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deployContract } = require('../tasks/utils');
const {
  prepareOBOrder,
  getCurrentSignedOrderPrice,
  approveERC721,
  approveERC20,
  getCurrentOrderPrice,
  calculateSignedOrderPriceAt,
  signFormattedOrder
} = require('../helpers/orders');
const { nowSeconds } = require('../tasks/utils');
const { erc721Abi } = require('../abi/erc721');

describe('Exchange_Varying_Prices', function () {
  let signers,
    signer1,
    signer2,
    signer3,
    token,
    infinityExchange,
    mock721Contract1,
    mock721Contract2,
    mock721Contract3,
    currencyRegistry,
    complicationRegistry,
    obComplication,
    infinityTreasury,
    infinityStaker,
    infinityTradingRewards,
    infinityFeeTreasury,
    infinityCreatorsFeeRegistry,
    mockRoyaltyEngine,
    infinityCreatorsFeeManager;

  const buyOrders = [];
  const sellOrders = [];

  let signer1Balance = toBN(0);
  let signer2Balance = toBN(0);
  let totalCuratorFees = toBN(0);
  let orderNonce = 0;

  const CURATOR_FEE_BPS = 250;
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const MINUTE = 60;
  const HOUR = MINUTE * 60;
  const DAY = HOUR * 24;
  const MONTH = DAY * 30;
  const YEAR = MONTH * 12;
  const UNIT = toBN(1e18);
  const INFLATION = toBN(300_000_000).mul(UNIT); // 40m
  const EPOCH_DURATION = YEAR;
  const CLIFF = toBN(3);
  const CLIFF_PERIOD = CLIFF.mul(YEAR);
  const MAX_EPOCHS = 6;
  const TIMELOCK = 30 * DAY;
  const INITIAL_SUPPLY = toBN(1_000_000_000).mul(UNIT); // 1b

  const totalNFTSupply = 100;
  const numNFTsToTransfer = 50;
  const numNFTsLeft = totalNFTSupply - numNFTsToTransfer;

  const ERROR_BOUND = '10000000000000000'; // 0.01 WETH

  function toBN(val) {
    return ethers.BigNumber.from(val.toString());
  }

  before(async () => {
    // signers
    signers = await ethers.getSigners();
    signer1 = signers[0];
    signer2 = signers[1];
    signer3 = signers[2];

    // token
    const tokenArgs = [
      signer1.address,
      INFLATION.toString(),
      EPOCH_DURATION.toString(),
      CLIFF_PERIOD.toString(),
      MAX_EPOCHS.toString(),
      TIMELOCK.toString(),
      INITIAL_SUPPLY.toString()
    ];
    token = await deployContract(
      'InfinityToken',
      await ethers.getContractFactory('InfinityToken'),
      signers[0],
      tokenArgs
    );

    // NFT contracts
    mock721Contract1 = await deployContract('MockERC721', await ethers.getContractFactory('MockERC721'), signer1, [
      'Mock NFT 1',
      'MCKNFT1'
    ]);
    mock721Contract2 = await deployContract('MockERC721', await ethers.getContractFactory('MockERC721'), signer1, [
      'Mock NFT 2',
      'MCKNFT2'
    ]);
    mock721Contract3 = await deployContract('MockERC721', await ethers.getContractFactory('MockERC721'), signer1, [
      'Mock NFT 3',
      'MCKNFT3'
    ]);

    // Currency registry
    currencyRegistry = await deployContract(
      'InfinityCurrencyRegistry',
      await ethers.getContractFactory('InfinityCurrencyRegistry'),
      signer1
    );

    // Complication registry
    complicationRegistry = await deployContract(
      'InfinityComplicationRegistry',
      await ethers.getContractFactory('InfinityComplicationRegistry'),
      signer1
    );

    // Exchange
    infinityExchange = await deployContract(
      'InfinityExchange',
      await ethers.getContractFactory('InfinityExchange'),
      signer1,
      [currencyRegistry.address, complicationRegistry.address, token.address, signer3.address]
    );

    // OB complication
    obComplication = await deployContract(
      'InfinityOrderBookComplication',
      await ethers.getContractFactory('InfinityOrderBookComplication'),
      signer1,
      [0, ERROR_BOUND]
    );

    // Infinity treasury
    infinityTreasury = signer1.address;

    // Infinity Staker
    infinityStaker = await deployContract(
      'InfinityStaker',
      await ethers.getContractFactory('InfinityStaker'),
      signer1,
      [token.address, infinityTreasury]
    );

    // Infinity Trading Rewards
    infinityTradingRewards = await deployContract(
      'InfinityTradingRewards',
      await ethers.getContractFactory('contracts/core/InfinityTradingRewards.sol:InfinityTradingRewards'),
      signer1,
      [infinityExchange.address, infinityStaker.address, token.address]
    );

    // Infinity Creator Fee Registry
    infinityCreatorsFeeRegistry = await deployContract(
      'InfinityCreatorsFeeRegistry',
      await ethers.getContractFactory('InfinityCreatorsFeeRegistry'),
      signer1
    );

    // Infinity Creators Fee Manager
    mockRoyaltyEngine = await deployContract(
      'MockRoyaltyEngine',
      await ethers.getContractFactory('MockRoyaltyEngine'),
      signer1
    );

    // Infinity Creators Fee Manager
    infinityCreatorsFeeManager = await deployContract(
      'InfinityCreatorsFeeManager',
      await ethers.getContractFactory('InfinityCreatorsFeeManager'),
      signer1,
      [mockRoyaltyEngine.address, infinityCreatorsFeeRegistry.address]
    );

    // Infinity Fee Treasury
    infinityFeeTreasury = await deployContract(
      'InfinityFeeTreasury',
      await ethers.getContractFactory('InfinityFeeTreasury'),
      signer1,
      [infinityExchange.address, infinityStaker.address, infinityCreatorsFeeManager.address]
    );

    // add currencies to registry
    await currencyRegistry.addCurrency(token.address);

    // add complications to registry
    await complicationRegistry.addComplication(obComplication.address);

    // set infinity fee treasury on exchange
    await infinityExchange.updateInfinityFeeTreasury(infinityFeeTreasury.address);

    // send assets
    await token.transfer(signer2.address, INITIAL_SUPPLY.div(2).toString());
    signer1Balance = INITIAL_SUPPLY.div(2);
    signer2Balance = INITIAL_SUPPLY.div(2);
    for (let i = 0; i < numNFTsToTransfer; i++) {
      await mock721Contract1.transferFrom(signer1.address, signer2.address, i);
      await mock721Contract2.transferFrom(signer1.address, signer2.address, i);
      await mock721Contract3.transferFrom(signer1.address, signer2.address, i);
    }
  });

  describe('Setup', () => {
    it('Should init properly', async function () {
      expect(await token.name()).to.equal('Infinity');
      expect(await token.symbol()).to.equal('NFT');
      expect(await token.decimals()).to.equal(18);
      expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY);

      expect(await token.balanceOf(signer1.address)).to.equal(INITIAL_SUPPLY.div(2));
      expect(await token.balanceOf(signer2.address)).to.equal(INITIAL_SUPPLY.div(2));

      expect(await mock721Contract1.balanceOf(signer1.address)).to.equal(numNFTsLeft);
      expect(await mock721Contract1.balanceOf(signer2.address)).to.equal(numNFTsToTransfer);

      expect(await mock721Contract2.balanceOf(signer1.address)).to.equal(numNFTsLeft);
      expect(await mock721Contract2.balanceOf(signer2.address)).to.equal(numNFTsToTransfer);

      expect(await mock721Contract3.balanceOf(signer1.address)).to.equal(numNFTsLeft);
      expect(await mock721Contract3.balanceOf(signer2.address)).to.equal(numNFTsToTransfer);
    });
  });

  // ================================================== MAKE BUY ORDERS ==================================================

  // one specific collection, one specific token, max price
  describe('OneCollectionOneTokenBuy', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer1.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: [{ tokenId: 0, numTokens: 1 }]
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      let numItems = 0;
      for (const nft of nfts) {
        numItems += nft.tokens.length;
      }
      const order = {
        id: orderId,
        chainId,
        isSellOrder: false,
        signerAddress: user.address,
        numItems,
        startPrice: ethers.utils.parseEther('2'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(1 * DAY),
        minBpsToSeller: 9000,
        nonce,
        nfts,
        execParams,
        extraParams
      };
      const signedOrder = await prepareOBOrder(
        user,
        chainId,
        signer1,
        order,
        infinityExchange,
        infinityFeeTreasury.address
      );
      expect(signedOrder).to.not.be.undefined;
      buyOrders.push(signedOrder);
    });
  });

  // one specific collection, multiple specific tokens, max aggregate price
  describe('OneCollectionMultipleTokensBuy', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer1.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: [
            { tokenId: 1, numTokens: 1 },
            { tokenId: 2, numTokens: 1 },
            { tokenId: 3, numTokens: 1 }
          ]
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      let numItems = 0;
      for (const nft of nfts) {
        numItems += nft.tokens.length;
      }
      const order = {
        id: orderId,
        chainId,
        isSellOrder: false,
        signerAddress: user.address,
        numItems,
        startPrice: ethers.utils.parseEther('10'),
        endPrice: ethers.utils.parseEther('6'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(1 * DAY),
        minBpsToSeller: 9000,
        nonce,
        nfts,
        execParams,
        extraParams
      };
      const signedOrder = await prepareOBOrder(
        user,
        chainId,
        signer1,
        order,
        infinityExchange,
        infinityFeeTreasury.address
      );
      expect(signedOrder).to.not.be.undefined;
      buyOrders.push(signedOrder);
    });
  });

  // multiple specific collections, any multiple tokens per collection, max aggregate price, min aggregate number of tokens
  describe('MultipleCollectionsAnyTokensBuy', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer1.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: []
        },
        {
          collection: mock721Contract2.address,
          tokens: []
        },
        {
          collection: mock721Contract3.address,
          tokens: []
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      const order = {
        id: orderId,
        chainId,
        isSellOrder: false,
        signerAddress: user.address,
        numItems: 5,
        startPrice: ethers.utils.parseEther('10'),
        endPrice: ethers.utils.parseEther('20'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(1 * DAY),
        minBpsToSeller: 9000,
        nonce,
        nfts,
        execParams,
        extraParams
      };
      const signedOrder = await prepareOBOrder(
        user,
        chainId,
        signer1,
        order,
        infinityExchange,
        infinityFeeTreasury.address
      );
      expect(signedOrder).to.not.be.undefined;
      buyOrders.push(signedOrder);
    });
  });

  // ================================================== MAKE SELL ORDERS ==================================================

  // one specific collection, one specific token, min price
  describe('OneCollectionOneTokenSell', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer2.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: [{ tokenId: 0, numTokens: 1 }]
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      let numItems = 0;
      for (const nft of nfts) {
        numItems += nft.tokens.length;
      }
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('2'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(1 * DAY),
        minBpsToSeller: 9000,
        nonce,
        nfts,
        execParams,
        extraParams
      };

      // approve currency (required for automatic execution)
      const salePrice = getCurrentOrderPrice(order);
      await approveERC20(user.address, execParams.currencyAddress, salePrice, signer2, infinityFeeTreasury.address);

      const signedOrder = await prepareOBOrder(
        user,
        chainId,
        signer2,
        order,
        infinityExchange,
        infinityFeeTreasury.address
      );
      expect(signedOrder).to.not.be.undefined;
      sellOrders.push(signedOrder);
    });
  });

  // one specific collection, multiple specific tokens, min aggregate price
  describe('OneCollectionMultipleTokensSell', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer2.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: [
            { tokenId: 31, numTokens: 1 },
            { tokenId: 32, numTokens: 1 },
            { tokenId: 33, numTokens: 1 }
          ]
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      let numItems = 0;
      for (const nft of nfts) {
        numItems += nft.tokens.length;
      }
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('2'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(1 * DAY),
        minBpsToSeller: 9000,
        nonce,
        nfts,
        execParams,
        extraParams
      };
      const signedOrder = await prepareOBOrder(
        user,
        chainId,
        signer2,
        order,
        infinityExchange,
        infinityFeeTreasury.address
      );
      expect(signedOrder).to.not.be.undefined;
      sellOrders.push(signedOrder);
    });
  });

  // multiple specific collections, any multiple tokens per collection, min aggregate price, max aggregate number of tokens
  describe('MultipleCollectionsAnyTokensSell', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer2.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: []
        },
        {
          collection: mock721Contract2.address,
          tokens: []
        },
        {
          collection: mock721Contract3.address,
          tokens: []
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems: 5,
        startPrice: ethers.utils.parseEther('8'),
        endPrice: ethers.utils.parseEther('4'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(1 * DAY),
        minBpsToSeller: 9000,
        nonce,
        nfts,
        execParams,
        extraParams
      };
      const signedOrder = await prepareOBOrder(
        user,
        chainId,
        signer2,
        order,
        infinityExchange,
        infinityFeeTreasury.address
      );
      expect(signedOrder).to.not.be.undefined;
      sellOrders.push(signedOrder);
    });
  });

  // ============================================ TAKE BUYS ============================================================

  describe('Take_OneCollectionMultipleTokensBuy', () => {
    it('Should take valid order', async function () {
      const buyOrder = buyOrders[1];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = true;

      const constraints = buyOrder.constraints;
      const nfts = buyOrder.nfts;
      const execParams = buyOrder.execParams;
      const extraParams = buyOrder.extraParams;

      // approve NFTs
      await approveERC721(signer2.address, nfts, signer2, infinityExchange.address);

      // sign order
      const sellOrder = {
        isSellOrder,
        signer: signer2.address,
        extraParams,
        nfts,
        constraints,
        execParams,
        sig: ''
      };
      sellOrder.sig = await signFormattedOrder(chainId, contractAddress, sellOrder, signer2);

      const isSigValid = await infinityExchange.verifyOrderSig(sellOrder);
      expect(isSigValid).to.equal(true);
      // owners before sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer2.address);
        }
      }

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // increase time
      await network.provider.send('evm_increaseTime', [1 * HOUR]);
      // sale price
      const totalEvmIncreasedTimeSoFarInTestCases = 1 * HOUR;
      const salePrice = calculateSignedOrderPriceAt(nowSeconds().add(totalEvmIncreasedTimeSoFarInTestCases), sellOrder);
      // console.log('======current salePrice=======', ethers.utils.formatEther(salePrice.toString()));
      // perform exchange
      await infinityExchange.connect(signer2).takeOrders([buyOrder], [sellOrder], false, false);

      // owners after sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer1.address);
        }
      }

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      const infinityFeeTreasuryBalance = await token.balanceOf(infinityFeeTreasury.address);
      const signer1TokenBalance = await token.balanceOf(signer1.address);
      const signer2TokenBalance = await token.balanceOf(signer2.address);
      // due to time delay
      expect(parseFloat(ethers.utils.formatEther(infinityFeeTreasuryBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(totalCuratorFees))
      );
      expect(parseFloat(ethers.utils.formatEther(signer1TokenBalance))).to.be.greaterThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer1Balance))
      );
      expect(parseFloat(ethers.utils.formatEther(signer2TokenBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer2Balance))
      );
      // update balances
      totalCuratorFees = infinityFeeTreasuryBalance;
      signer1Balance = signer1TokenBalance;
      signer2Balance = signer2TokenBalance;
    });
  });

  describe('Take_MultipleCollectionsAnyTokensBuy', () => {
    it('Should take valid order', async function () {
      const buyOrder = buyOrders[2];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = true;

      const constraints = buyOrder.constraints;
      const buyOrderNfts = buyOrder.nfts;
      const execParams = buyOrder.execParams;
      const extraParams = buyOrder.extraParams;

      // form matching nfts
      const nfts = [];
      let i = 0;
      for (const buyOrderNft of buyOrderNfts) {
        ++i;
        const collection = buyOrderNft.collection;
        let nft;
        if (i === 1) {
          nft = {
            collection,
            tokens: [
              {
                tokenId: 20,
                numTokens: 1
              },
              {
                tokenId: 21,
                numTokens: 1
              }
            ]
          };
        } else if (i === 2) {
          nft = {
            collection,
            tokens: [
              {
                tokenId: 10,
                numTokens: 1
              }
            ]
          };
        } else {
          nft = {
            collection,
            tokens: [
              {
                tokenId: 10,
                numTokens: 1
              },
              {
                tokenId: 11,
                numTokens: 1
              }
            ]
          };
        }

        nfts.push(nft);
      }

      // approve NFTs
      await approveERC721(signer2.address, nfts, signer2, infinityExchange.address);

      // sign order
      const sellOrder = {
        isSellOrder,
        signer: signer2.address,
        extraParams,
        nfts,
        constraints,
        execParams,
        sig: ''
      };
      sellOrder.sig = await signFormattedOrder(chainId, contractAddress, sellOrder, signer2);

      const isSigValid = await infinityExchange.verifyOrderSig(sellOrder);
      expect(isSigValid).to.equal(true);
      // owners before sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer2.address);
        }
      }

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
      await network.provider.send('evm_increaseTime', [30 * MINUTE]);
      // sale price
      const totalEvmIncreasedTimeSoFarInTestCases = 1 * HOUR + 30 * MINUTE;
      const salePrice = calculateSignedOrderPriceAt(nowSeconds().add(totalEvmIncreasedTimeSoFarInTestCases), sellOrder);
      // console.log('======current salePrice=======', ethers.utils.formatEther(salePrice.toString()));
      await infinityExchange.connect(signer2).takeOrders([buyOrder], [sellOrder], false, false);

      // owners after sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer1.address);
        }
      }

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      const infinityFeeTreasuryBalance = await token.balanceOf(infinityFeeTreasury.address);
      const signer1TokenBalance = await token.balanceOf(signer1.address);
      const signer2TokenBalance = await token.balanceOf(signer2.address);
      // due to time delay
      expect(parseFloat(ethers.utils.formatEther(infinityFeeTreasuryBalance))).to.be.greaterThanOrEqual(
        parseFloat(ethers.utils.formatEther(totalCuratorFees))
      );
      expect(parseFloat(ethers.utils.formatEther(signer1TokenBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer1Balance))
      );
      expect(parseFloat(ethers.utils.formatEther(signer2TokenBalance))).to.be.greaterThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer2Balance))
      );
      // update balances
      totalCuratorFees = infinityFeeTreasuryBalance;
      signer1Balance = signer1TokenBalance;
      signer2Balance = signer2TokenBalance;
    });
  });

  // ================================================== TAKE SELLS =======================================================

  describe('Take_OneCollectionMultipleTokensSell', () => {
    it('Should take valid order', async function () {
      const sellOrder = sellOrders[1];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const nfts = sellOrder.nfts;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

      // sign order
      const buyOrder = {
        isSellOrder,
        signer: signer1.address,
        extraParams,
        nfts,
        constraints,
        execParams,
        sig: ''
      };
      buyOrder.sig = await signFormattedOrder(chainId, contractAddress, buyOrder, signer1);

      const isSigValid = await infinityExchange.verifyOrderSig(buyOrder);
      expect(isSigValid).to.equal(true);
      // owners before sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer2.address);
        }
      }

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
      // not increasing time here
      // sale price
      const salePrice = calculateSignedOrderPriceAt(nowSeconds(), sellOrder);
      // console.log('======current salePrice=======', ethers.utils.formatEther(salePrice.toString()));
      // approve currency
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);
      await infinityExchange.connect(signer1).takeOrders([sellOrder], [buyOrder], false, false);

      // owners after sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer1.address);
        }
      }

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      const infinityFeeTreasuryBalance = await token.balanceOf(infinityFeeTreasury.address);
      const signer1TokenBalance = await token.balanceOf(signer1.address);
      const signer2TokenBalance = await token.balanceOf(signer2.address);
      // due to time delay
      expect(parseFloat(ethers.utils.formatEther(infinityFeeTreasuryBalance))).to.be.greaterThanOrEqual(
        parseFloat(ethers.utils.formatEther(totalCuratorFees))
      );
      expect(parseFloat(ethers.utils.formatEther(signer1TokenBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer1Balance))
      );
      expect(parseFloat(ethers.utils.formatEther(signer2TokenBalance))).to.be.greaterThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer2Balance))
      );
      // update balances
      totalCuratorFees = infinityFeeTreasuryBalance;
      signer1Balance = signer1TokenBalance;
      signer2Balance = signer2TokenBalance;
    });
  });

  describe('Take_MultipleCollectionsAnyTokensSell', () => {
    it('Should take valid order', async function () {
      const sellOrder = sellOrders[2];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const sellOrderNfts = sellOrder.nfts;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

      // form matching nfts
      const nfts = [];
      let i = 0;
      for (const buyOrderNft of sellOrderNfts) {
        ++i;
        const collection = buyOrderNft.collection;
        let nft;
        if (i === 1) {
          nft = {
            collection,
            tokens: [
              {
                tokenId: 40,
                numTokens: 1
              },
              {
                tokenId: 41,
                numTokens: 1
              }
            ]
          };
        } else if (i === 2) {
          nft = {
            collection,
            tokens: [
              {
                tokenId: 40,
                numTokens: 1
              }
            ]
          };
        } else {
          nft = {
            collection,
            tokens: [
              {
                tokenId: 40,
                numTokens: 1
              },
              {
                tokenId: 41,
                numTokens: 1
              }
            ]
          };
        }

        nfts.push(nft);
      }

      // approve currency
      let salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);
      // console.log('current salePrice', ethers.utils.formatEther(salePrice.toString()));

      // sign order
      const buyOrder = {
        isSellOrder,
        signer: signer1.address,
        extraParams,
        nfts,
        constraints,
        execParams,
        sig: ''
      };
      buyOrder.sig = await signFormattedOrder(chainId, contractAddress, buyOrder, signer1);

      const isSigValid = await infinityExchange.verifyOrderSig(buyOrder);
      expect(isSigValid).to.equal(true);
      // owners before sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer2.address);
        }
      }

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
      await network.provider.send('evm_increaseTime', [4 * HOUR]);
      const totalEvmIncreasedTimeSoFarInTestCases = 5 * HOUR + 30 * MINUTE;
      salePrice = calculateSignedOrderPriceAt(nowSeconds().add(totalEvmIncreasedTimeSoFarInTestCases), sellOrder);
      // console.log('======current salePrice=======', ethers.utils.formatEther(salePrice.toString()));
      await infinityExchange.connect(signer1).takeOrders([sellOrder], [buyOrder], false, false);

      // owners after sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer1.address);
        }
      }

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      const infinityFeeTreasuryBalance = await token.balanceOf(infinityFeeTreasury.address);
      const signer1TokenBalance = await token.balanceOf(signer1.address);
      const signer2TokenBalance = await token.balanceOf(signer2.address);
      // due to time delay
      expect(parseFloat(ethers.utils.formatEther(infinityFeeTreasuryBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(totalCuratorFees))
      );
      expect(parseFloat(ethers.utils.formatEther(signer1TokenBalance))).to.be.greaterThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer1Balance))
      );
      expect(parseFloat(ethers.utils.formatEther(signer2TokenBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer2Balance))
      );
      // update balances
      totalCuratorFees = infinityFeeTreasuryBalance;
      signer1Balance = signer1TokenBalance;
      signer2Balance = signer2TokenBalance;
    });
  });

  // ================================================== MATCH ORDERS ===================================================

  describe('Match_0_0', () => {
    it('Should not match due to price non overlap', async function () {
      const buyOrder = buyOrders[0];
      const sellOrder = sellOrders[0];
      const isSellOrder = true;
      const constraints = buyOrder.constraints;
      const buyOrderNfts = buyOrder.nfts;
      const execParams = buyOrder.execParams;
      const extraParams = buyOrder.extraParams;

      const constructedOrder = sellOrder;
      const nfts = constructedOrder.nfts;

      // owners before sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer2.address);
        }
      }

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

      // increase time
      await network.provider.send('evm_increaseTime', [13 * HOUR]);
      // sale price
      const totalEvmIncreasedTimeSoFarInTestCases = 5 * HOUR + 30 * MINUTE;
      const salePrice = calculateSignedOrderPriceAt(
        nowSeconds().add(totalEvmIncreasedTimeSoFarInTestCases),
        constructedOrder
      );

      const buyPrice = calculateSignedOrderPriceAt(nowSeconds().add(totalEvmIncreasedTimeSoFarInTestCases), buyOrder);
      // initiate exchange by 3rd party
      await infinityExchange.connect(signer3).matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);

      // owners after sale; should remain same
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer2.address);
        }
      }

      // balance after sale
      const signer1TokenBalance = await token.balanceOf(signer1.address);
      const signer2TokenBalance = await token.balanceOf(signer2.address);
      expect(parseFloat(ethers.utils.formatEther(signer1TokenBalance))).to.be.equal(
        parseFloat(ethers.utils.formatEther(signer1Balance))
      );
      // gas cost
      expect(parseFloat(ethers.utils.formatEther(signer2TokenBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer2Balance))
      );
      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      // console.log('sellerBalance1', sellerBalance1, 'sellerBalance2', sellerBalance2);
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund
      signer2Balance = signer2TokenBalance;
    });
  });

  // =========================================== NEW ORDERS FOR MATCHING ===========================================

  // one specific collection, any multiple tokens, max aggregate price, min number of tokens
  describe('OneCollectionAnyMultipleTokensBuy', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer1.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: []
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      const order = {
        id: orderId,
        chainId,
        isSellOrder: false,
        signerAddress: user.address,
        numItems: 4,
        startPrice: ethers.utils.parseEther('5'),
        endPrice: ethers.utils.parseEther('3'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(6 * DAY),
        minBpsToSeller: 9000,
        nonce,
        nfts,
        execParams,
        extraParams
      };
      const signedOrder = await prepareOBOrder(
        user,
        chainId,
        signer1,
        order,
        infinityExchange,
        infinityFeeTreasury.address
      );
      expect(signedOrder).to.not.be.undefined;
      buyOrders.push(signedOrder);
      // increase time
      await network.provider.send('evm_increaseTime', [3 * DAY]);
    });
  });

  // one specific collection, any multiple tokens, min aggregate price, max number of tokens
  describe('OneCollectionAnyMultipleTokensSell', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer2.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: []
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      const totalEvmIncreasedTimeSoFarSinceBuyOrderPlaced = 3 * DAY;
      const startTime = nowSeconds().add(totalEvmIncreasedTimeSoFarSinceBuyOrderPlaced);
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems: 4,
        startPrice: ethers.utils.parseEther('4'),
        endPrice: ethers.utils.parseEther('2'),
        startTime,
        endTime: startTime.add(2 * DAY),
        minBpsToSeller: 9000,
        nonce,
        nfts,
        execParams,
        extraParams
      };
      const signedOrder = await prepareOBOrder(
        user,
        chainId,
        signer2,
        order,
        infinityExchange,
        infinityFeeTreasury.address
      );
      expect(signedOrder).to.not.be.undefined;
      sellOrders.push(signedOrder);
    });
  });

  describe('Match_1_1', () => {
    it('Should match due to price overlap', async function () {
      const buyOrder = buyOrders[3];
      const sellOrder = sellOrders[3];

      // form matching nfts
      const nfts = [];
      for (const sellOrderNft of sellOrder.nfts) {
        const collection = sellOrderNft.collection;
        const nft = {
          collection,
          tokens: [
            {
              tokenId: 25,
              numTokens: 1
            },
            {
              tokenId: 26,
              numTokens: 1
            },
            {
              tokenId: 27,
              numTokens: 1
            },
            {
              tokenId: 28,
              numTokens: 1
            }
          ]
        };
        nfts.push(nft);
      }

      // form order
      const constructedOrder = { ...sellOrder };
      constructedOrder.nfts = nfts;

      // owners before sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer2.address);
        }
      }

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

      // sale price
      const totalEvmIncreasedTimeSoFarSinceBuyOrderPlaced = 3 * DAY;
      const totalEvmIncreasedTimeSoFarSinceSellOrderPlaced = 10;
      const buyPrice = calculateSignedOrderPriceAt(
        nowSeconds().add(totalEvmIncreasedTimeSoFarSinceBuyOrderPlaced),
        buyOrder
      );
      // console.log('=========current buy order price for match=========', ethers.utils.formatEther(buyPrice.toString()));
      const salePrice = calculateSignedOrderPriceAt(
        nowSeconds().add(totalEvmIncreasedTimeSoFarSinceSellOrderPlaced),
        sellOrder
      );
      // initiate exchange by 3rd party
      await infinityExchange.connect(signer3).matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);

      // owners after sale
      for (const item of nfts) {
        const collection = item.collection;
        const contract = new ethers.Contract(collection, erc721Abi, signer1);
        for (const token of item.tokens) {
          const tokenId = token.tokenId;
          expect(await contract.ownerOf(tokenId)).to.equal(signer1.address);
        }
      }

      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      const infinityFeeTreasuryBalance = await token.balanceOf(infinityFeeTreasury.address);
      const signer1TokenBalance = await token.balanceOf(signer1.address);
      const signer2TokenBalance = await token.balanceOf(signer2.address);
      // due to time delay
      expect(parseFloat(ethers.utils.formatEther(infinityFeeTreasuryBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(totalCuratorFees))
      );
      expect(parseFloat(ethers.utils.formatEther(signer1TokenBalance))).to.be.greaterThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer1Balance))
      );
      expect(parseFloat(ethers.utils.formatEther(signer2TokenBalance))).to.be.lessThanOrEqual(
        parseFloat(ethers.utils.formatEther(signer2Balance))
      );
      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      // console.log('sellerBalance1', sellerBalance1, 'sellerBalance2', sellerBalance2);
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund
      // update balances
      totalCuratorFees = infinityFeeTreasuryBalance;
      signer1Balance = signer1TokenBalance;
      signer2Balance = signer2TokenBalance;
    });
  });
});
