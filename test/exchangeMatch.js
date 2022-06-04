const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deployContract } = require('../tasks/utils');
const {
  prepareOBOrder,
  getCurrentSignedOrderPrice,
  approveERC20,
  getCurrentOrderPrice
} = require('../helpers/orders');
const { nowSeconds } = require('../tasks/utils');
const { erc721Abi } = require('../abi/erc721');

describe('Exchange_Match', function () {
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
  let signer3Balance = toBN(0);
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
      [0, 1_000_000]
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
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // one specific collection, any one of multiple specific tokens, max price
  describe('OneCollectionAnyOneOfMultipleTokensBuy', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer1.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: [
            { tokenId: 12, numTokens: 1 },
            { tokenId: 13, numTokens: 1 },
            { tokenId: 14, numTokens: 1 }
          ]
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      let numItems = 1;
      const order = {
        id: orderId,
        chainId,
        isSellOrder: false,
        signerAddress: user.address,
        numItems,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(10 * 60),
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

  // one specific collection, any one token, max price
  describe('OneCollectionAnyOneTokenBuy', () => {
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
        numItems: 1,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // multiple specific collections, multiple specific tokens per collection, max aggregate price
  describe('MultipleCollectionsMultipleTokensBuy', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer1.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: [{ tokenId: 11, numTokens: 1 }]
        },
        {
          collection: mock721Contract2.address,
          tokens: [
            { tokenId: 0, numTokens: 1 },
            { tokenId: 1, numTokens: 1 }
          ]
        },
        {
          collection: mock721Contract3.address,
          tokens: [
            { tokenId: 0, numTokens: 1 },
            { tokenId: 1, numTokens: 1 },
            { tokenId: 2, numTokens: 1 }
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
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // any collection, any one token, max price
  describe('AnyCollectionAnyOneTokenBuy', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer1.address
      };
      const chainId = network.config.chainId;
      const nfts = [];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      const order = {
        id: orderId,
        chainId,
        isSellOrder: false,
        signerAddress: user.address,
        numItems: 1,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // any collection, any multiple tokens, max aggregate price, min aggregate number of tokens
  describe('AnyCollectionAnyMultipleTokensBuy', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer1.address
      };
      const chainId = network.config.chainId;
      const nfts = [];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      const order = {
        id: orderId,
        chainId,
        isSellOrder: false,
        signerAddress: user.address,
        numItems: 12,
        startPrice: ethers.utils.parseEther('5'),
        endPrice: ethers.utils.parseEther('5'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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
        isSellOrder: true,
        signerAddress: user.address,
        numItems,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // one specific collection, any one of multiple specific tokens, min price
  describe('OneCollectionAnyOneOfMultipleTokensSell', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer2.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: [
            { tokenId: 12, numTokens: 1 },
            { tokenId: 13, numTokens: 1 },
            { tokenId: 14, numTokens: 1 }
          ]
        }
      ];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      let numItems = 1;
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(10 * 60),
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

  // one specific collection, any one token, min price
  describe('OneCollectionAnyOneTokenSell', () => {
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
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems: 1,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems: 4,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // multiple specific collections, multiple specific tokens per collection, min aggregate price
  describe('MultipleCollectionsMultipleTokensSell', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer2.address
      };
      const chainId = network.config.chainId;
      const nfts = [
        {
          collection: mock721Contract1.address,
          tokens: [{ tokenId: 11, numTokens: 1 }]
        },
        {
          collection: mock721Contract2.address,
          tokens: [
            { tokenId: 0, numTokens: 1 },
            { tokenId: 1, numTokens: 1 }
          ]
        },
        {
          collection: mock721Contract3.address,
          tokens: [
            { tokenId: 0, numTokens: 1 },
            { tokenId: 1, numTokens: 1 },
            { tokenId: 2, numTokens: 1 }
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
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // any collection, any one token, min price
  describe('AnyCollectionAnyOneTokenSell', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer2.address
      };
      const chainId = network.config.chainId;
      const nfts = [];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems: 1,
        startPrice: ethers.utils.parseEther('1'),
        endPrice: ethers.utils.parseEther('1'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // any collection, any multiple tokens, min aggregate price, max aggregate number of tokens
  describe('AnyCollectionAnyMultipleTokensSell', () => {
    it('Signed order should be valid', async function () {
      const user = {
        address: signer2.address
      };
      const chainId = network.config.chainId;
      const nfts = [];
      const execParams = { complicationAddress: obComplication.address, currencyAddress: token.address };
      const extraParams = {};
      const nonce = ++orderNonce;
      const orderId = ethers.utils.solidityKeccak256(['address', 'uint256', 'uint256'], [user.address, nonce, chainId]);
      const order = {
        id: orderId,
        chainId,
        isSellOrder: true,
        signerAddress: user.address,
        numItems: 12,
        startPrice: ethers.utils.parseEther('5'),
        endPrice: ethers.utils.parseEther('5'),
        startTime: nowSeconds(),
        endTime: nowSeconds().add(24 * 60 * 60),
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

  // ================================================== MATCH ORDERS ===================================================

  describe('Match_OneCollectionOneToken', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[0];
      const sellOrder = sellOrders[0];
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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(INITIAL_SUPPLY.div(2));
      expect(await token.balanceOf(signer2.address)).to.equal(INITIAL_SUPPLY.div(2));

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = INITIAL_SUPPLY.div(2).sub(salePrice);
      signer2Balance = INITIAL_SUPPLY.div(2).add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });

  describe('Match_OneCollectionMultipleTokens', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[1];
      const sellOrder = sellOrders[1];
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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });

  describe('Match_OneCollectionAnyOneOfMultipleTokens', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[2];
      const sellOrder = sellOrders[2];
      const constructedOrder = { ...sellOrder };

      // form matching nfts
      const nfts = [];
      for (const buyOrderNft of buyOrder.nfts) {
        const collection = buyOrderNft.collection;
        const nft = {
          collection,
          tokens: [
            {
              tokenId: 12,
              numTokens: 1
            }
          ]
        };
        nfts.push(nft);
      }
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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });

  describe('Match_OneCollectionAnyOneToken', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[3];
      const sellOrder = sellOrders[3];
      const constructedOrder = { ...sellOrder };

      // form matching nfts
      const nfts = [];
      for (const buyOrderNft of buyOrder.nfts) {
        const collection = buyOrderNft.collection;
        const nft = {
          collection,
          tokens: [
            {
              tokenId: 4,
              numTokens: 1
            }
          ]
        };
        nfts.push(nft);
      }
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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });

  describe('Match_OneCollectionAnyMultipleTokens', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[4];
      const sellOrder = sellOrders[4];
      const constructedOrder = { ...sellOrder };

      // form matching nfts
      const nfts = [];
      for (const buyOrderNft of buyOrder.nfts) {
        const collection = buyOrderNft.collection;
        const nft = {
          collection,
          tokens: [
            {
              tokenId: 5,
              numTokens: 1
            },
            {
              tokenId: 6,
              numTokens: 1
            },
            {
              tokenId: 7,
              numTokens: 1
            },
            {
              tokenId: 8,
              numTokens: 1
            }
          ]
        };
        nfts.push(nft);
      }
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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });

  describe('Match_MultipleCollectionsMultipleTokensBuy', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[5];
      const sellOrder = sellOrders[5];
      const constructedOrder = { ...sellOrder };
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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });

  describe('Match_MultipleCollectionsAnyTokensBuy', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[6];
      const sellOrder = sellOrders[6];
      const constructedOrder = { ...sellOrder };

      // form matching nfts
      const nfts = [];
      let i = 0;
      for (const buyOrderNft of buyOrder.nfts) {
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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });

  describe('Match_AnyCollectionAnyOneTokenBuy', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[7];
      const sellOrder = sellOrders[7];
      const constructedOrder = { ...sellOrder };

      // form matching nfts
      const nfts = [];
      const collection = mock721Contract3.address;
      const nft = {
        collection,
        tokens: [
          {
            tokenId: 15,
            numTokens: 1
          }
        ]
      };
      nfts.push(nft);
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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });

  describe('Match_AnyCollectionAnyMultipleTokensBuy', () => {
    it('Should match valid order', async function () {
      const buyOrder = buyOrders[8];
      const sellOrder = sellOrders[8];
      const constructedOrder = { ...sellOrder };

      // form matching nfts
      const nfts = [];
      const nft1 = {
        collection: mock721Contract1.address,
        tokens: [
          {
            tokenId: 30,
            numTokens: 1
          },
          {
            tokenId: 31,
            numTokens: 1
          },
          {
            tokenId: 32,
            numTokens: 1
          }
        ]
      };
      const nft2 = {
        collection: mock721Contract2.address,
        tokens: [
          {
            tokenId: 35,
            numTokens: 1
          },
          {
            tokenId: 36,
            numTokens: 1
          },
          {
            tokenId: 37,
            numTokens: 1
          },
          {
            tokenId: 38,
            numTokens: 1
          },
          {
            tokenId: 39,
            numTokens: 1
          }
        ]
      };
      const nft3 = {
        collection: mock721Contract3.address,
        tokens: [
          {
            tokenId: 20,
            numTokens: 1
          },
          {
            tokenId: 21,
            numTokens: 1
          },
          {
            tokenId: 22,
            numTokens: 1
          },
          {
            tokenId: 23,
            numTokens: 1
          }
        ]
      };

      nfts.push(nft1);
      nfts.push(nft2);
      nfts.push(nft3);

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

      // sale price
      const salePrice = getCurrentSignedOrderPrice(constructedOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const gasEstimate = await infinityExchange
        .connect(signer3)
        .estimateGas.matchOrders([sellOrder], [buyOrder], [constructedOrder], false, false);
      // console.log('gasEstimate', gasEstimate);
      const gasPrice = await signer3.provider.getGasPrice();
      // console.log('gasPrice', gasPrice);
      const gasCost = gasEstimate.mul(gasPrice);
      // console.log('gasCost', gasCost.toString());

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

      // balance after sale
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);

      const signer2TokenBalance = await token.balanceOf(signer2.address);
      const signer3TokenBalance = await token.balanceOf(signer3.address);

      const sellerBalance1 = parseFloat(ethers.utils.formatEther(signer2TokenBalance));
      const sellerBalance2 = parseFloat(ethers.utils.formatEther(signer2Balance));
      expect(sellerBalance1).to.be.lessThan(sellerBalance2); // less than because of the gas refund

      signer3Balance = signer2Balance.sub(signer2TokenBalance);
      expect(signer3TokenBalance).to.equal(signer3Balance);
    });
  });
});
