const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deployContract } = require('../tasks/utils');
const {
  prepareOBOrder,
  getCurrentSignedOrderPrice,
  approveERC20,
  signFormattedOrder
} = require('../helpers/orders');
const { nowSeconds, NULL_ADDRESS } = require('../tasks/utils');
const { erc721Abi } = require('../abi/erc721');

describe('Exchange_Creator_Fee_Maker_Sell_Taker_Buy', function () {
  let signers,
    signer1,
    signer2,
    signer3,
    token,
    infinityExchange,
    mock721Contract1,
    mock721ContractRoyalty,
    mock721Contract3,
    mock721Contract4,
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

  const sellOrders = [];

  let signer1Balance = toBN(0);
  let signer2Balance = toBN(0);
  let totalCuratorFees = toBN(0);
  let totalCreatorFees = toBN(0);
  let totalFeeSoFar = toBN(0);
  let creatorFees = {};
  let orderNonce = 0;
  let numTakeOrders = -1;

  const CURATOR_FEE_BPS = 250;
  const CREATOR_FEE_BPS_ENGINE = 200;
  const CREATOR_FEE_BPS = 400;
  const CREATOR_FEE_BPS_IERC2981 = 300;
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

  function toFloor(val) {
    return toBN(Math.floor(val));
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
    mock721ContractRoyalty = await deployContract(
      'MockERC721WithRoyalty',
      await ethers.getContractFactory('MockERC721WithRoyalty'),
      signer1,
      ['Mock NFT Royalty', 'MCKNFTROY']
    );
    mock721Contract3 = await deployContract('MockERC721', await ethers.getContractFactory('MockERC721'), signer1, [
      'Mock NFT 3',
      'MCKNFT3'
    ]);
    mock721Contract4 = await deployContract('MockERC721', await ethers.getContractFactory('MockERC721'), signer2, [
      'Mock NFT 4',
      'MCKNFT4'
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

    // set creator fee manager on registry
    await infinityCreatorsFeeRegistry.updateCreatorsFeeManager(infinityCreatorsFeeManager.address);

    // send assets
    await token.transfer(signer2.address, INITIAL_SUPPLY.div(2).toString());
    for (let i = 0; i < numNFTsToTransfer; i++) {
      await mock721Contract1.transferFrom(signer1.address, signer2.address, i);
      await mock721ContractRoyalty.transferFrom(signer1.address, signer2.address, i);
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

      expect(await mock721ContractRoyalty.balanceOf(signer1.address)).to.equal(numNFTsLeft);
      expect(await mock721ContractRoyalty.balanceOf(signer2.address)).to.equal(numNFTsToTransfer);

      expect(await mock721Contract3.balanceOf(signer1.address)).to.equal(numNFTsLeft);
      expect(await mock721Contract3.balanceOf(signer2.address)).to.equal(numNFTsToTransfer);
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
          collection: mock721ContractRoyalty.address,
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
          collection: mock721ContractRoyalty.address,
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

  // ================================================== TAKE SELL ORDERS ===================================================

  describe('Take_OneCollectionOneTokenSell', () => {
    it('Should take valid order with no royalty', async function () {
      const sellOrder = sellOrders[++numTakeOrders];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const nfts = sellOrder.nfts;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

      // approve currency
      const salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);

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
      expect(await token.balanceOf(signer1.address)).to.equal(INITIAL_SUPPLY.div(2));
      expect(await token.balanceOf(signer2.address)).to.equal(INITIAL_SUPPLY.div(2));

      // perform exchange
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
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      signer1Balance = INITIAL_SUPPLY.div(2).sub(salePrice);
      signer2Balance = INITIAL_SUPPLY.div(2).add(salePrice.sub(fee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
    });
  });

  describe('Set_Royalty_In_RoyaltyEngine', () => {
    it('Should set royalty', async function () {
      await mockRoyaltyEngine.connect(signer1).setRoyaltyBps(mock721Contract1.address, CREATOR_FEE_BPS_ENGINE);
      const result = await mockRoyaltyEngine.getRoyaltyView(mock721Contract1.address, 0, ethers.utils.parseEther('1'));
      // console.log('get royalty result', result, result[0], result[1], result[0][0], result[1][0]);
      const recipient = result[0][0];
      const amount = result[1][0];
      const calcRoyalty = ethers.utils.parseEther('1').mul(CREATOR_FEE_BPS_ENGINE).div(10000);
      expect(recipient).to.equal(signer1.address);
      expect(amount.toString()).to.equal(calcRoyalty);
    });
  });

  describe('Take_OneCollectionMultipleTokensSell', () => {
    it('Should take valid order with royalty from royalty engine', async function () {
      const sellOrder = sellOrders[++numTakeOrders];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const nfts = sellOrder.nfts;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

      // approve currency
      const salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);

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
      const creatorFee = salePrice.mul(CREATOR_FEE_BPS_ENGINE).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFee);
      const totalFee = creatorFee.add(fee);
      totalFeeSoFar = totalCuratorFees.add(totalCreatorFees);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalFeeSoFar);

      const result = await mockRoyaltyEngine.getRoyaltyView(mock721Contract1.address, 0, salePrice);
      const recipient = result[0][0];
      const amount = result[1][0];
      if (!creatorFees[recipient]) {
        creatorFees[recipient] = toBN(0);
      }
      expect(amount).to.equal(creatorFee);
      creatorFees[recipient] = creatorFees[recipient].add(creatorFee);
      // console.log('creatorFees recepient', recipient, creatorFees[recipient]);

      const allocatedCreatorFee = await infinityFeeTreasury.creatorFees(recipient, token.address);
      expect(allocatedCreatorFee.toString()).to.equal(creatorFees[recipient].toString());

      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(totalFee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
    });
  });

  describe('Set_Royalty_In_InfinityRoyaltyRegistry', () => {
    it('Should set royalty', async function () {
      await infinityCreatorsFeeManager
        .connect(signer1)
        .setupCollectionForCreatorFeeShare(
          mock721Contract1.address,
          [signer1.address, signer2.address],
          [CREATOR_FEE_BPS / 2, CREATOR_FEE_BPS / 2]
        );
      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract1.address,
        0,
        ethers.utils.parseEther('1')
      );
      const setter = result[0];
      const dest1 = result[1][0];
      const dest2 = result[1][1];
      const bpsSplit1 = result[2][0];
      const bpsSplit2 = result[2][1];
      const amount1 = result[3][0];
      const amount2 = result[3][1];
      const calcRoyalty1 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 2)
        .div(10000);
      const calcRoyalty2 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 2)
        .div(10000);
      expect(setter).to.equal(signer1.address);
      expect(dest1).to.equal(signer1.address);
      expect(dest2).to.equal(signer2.address);
      expect(bpsSplit1).to.equal(CREATOR_FEE_BPS / 2);
      expect(bpsSplit2).to.equal(CREATOR_FEE_BPS / 2);
      expect(amount1.toString()).to.equal(calcRoyalty1);
      expect(amount2.toString()).to.equal(calcRoyalty2);
    });
  });

  describe('Take_OneCollectionAnyOneTokenSell', () => {
    it('Should take valid order with royalty from infinity royalty registry', async function () {
      const sellOrder = sellOrders[++numTakeOrders];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const sellOrderNfts = sellOrder.nfts;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

      // form matching nfts
      const nfts = [];
      for (const buyOrderNft of sellOrderNfts) {
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

      // approve currency
      let salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);

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

      // sale price
      salePrice = getCurrentSignedOrderPrice(buyOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
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
      const creatorFee = salePrice.mul(CREATOR_FEE_BPS).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFee);
      const totalFee = creatorFee.add(fee);
      totalFeeSoFar = totalCuratorFees.add(totalCreatorFees);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalFeeSoFar);

      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(mock721Contract1.address, 0, salePrice);
      const dest1 = result[1][0];
      const dest2 = result[1][1];
      const bpsSplit1 = result[2][0];
      const bpsSplit2 = result[2][1];
      const amount1 = result[3][0];
      const amount2 = result[3][1];
      if (!creatorFees[dest1]) {
        creatorFees[dest1] = toBN(0);
      }
      if (!creatorFees[dest2]) {
        creatorFees[dest2] = toBN(0);
      }
      expect(amount1).to.equal(creatorFee.mul(bpsSplit1).div(CREATOR_FEE_BPS));
      expect(amount2).to.equal(creatorFee.mul(bpsSplit2).div(CREATOR_FEE_BPS));
      creatorFees[dest1] = creatorFees[dest1].add(amount1);
      creatorFees[dest2] = creatorFees[dest2].add(amount2);
      // console.log('creatorFees dest1', dest1, creatorFees[dest1], 'creatorFees dest2', dest2, creatorFees[dest2]);

      const allocatedCreatorFee1 = await infinityFeeTreasury.creatorFees(dest1, token.address);
      expect(allocatedCreatorFee1.toString()).to.equal(creatorFees[dest1].toString());
      const allocatedCreatorFee2 = await infinityFeeTreasury.creatorFees(dest2, token.address);
      expect(allocatedCreatorFee2.toString()).to.equal(creatorFees[dest2].toString());

      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(totalFee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
    });
  });

  describe('Update_Royalty_In_InfinityRoyaltyRegistry', () => {
    it('Should update royalty', async function () {
      await infinityCreatorsFeeManager
        .connect(signer1)
        .setupCollectionForCreatorFeeShare(
          mock721Contract1.address,
          [signer2.address, signer3.address],
          [CREATOR_FEE_BPS / 2, CREATOR_FEE_BPS / 2]
        );
      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract1.address,
        0,
        ethers.utils.parseEther('1')
      );
      const setter = result[0];
      const dest1 = result[1][0];
      const dest2 = result[1][1];
      const bpsSplit1 = result[2][0];
      const bpsSplit2 = result[2][1];
      const amount1 = result[3][0];
      const amount2 = result[3][1];
      const calcRoyalty1 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 2)
        .div(10000);
      const calcRoyalty2 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 2)
        .div(10000);
      expect(setter).to.equal(signer1.address);
      expect(dest1).to.equal(signer2.address);
      expect(dest2).to.equal(signer3.address);
      expect(bpsSplit1).to.equal(CREATOR_FEE_BPS / 2);
      expect(bpsSplit2).to.equal(CREATOR_FEE_BPS / 2);
      expect(amount1.toString()).to.equal(calcRoyalty1);
      expect(amount2.toString()).to.equal(calcRoyalty2);
    });
  });

  describe('Take_OneCollectionAnyMultipleTokensSell', () => {
    it('Should take valid order with updated royalty from infinity registry', async function () {
      const sellOrder = sellOrders[++numTakeOrders];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const sellOrderNfts = sellOrder.nfts;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

      // form matching nfts
      const nfts = [];
      for (const sellOrderNft of sellOrderNfts) {
        const collection = sellOrderNft.collection;
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

      // approve currency
      let salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);

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

      // sale price
      salePrice = getCurrentSignedOrderPrice(buyOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
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
      const creatorFee = salePrice.mul(CREATOR_FEE_BPS).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFee);
      const totalFee = creatorFee.add(fee);
      totalFeeSoFar = totalCuratorFees.add(totalCreatorFees);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalFeeSoFar);

      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(mock721Contract1.address, 0, salePrice);
      const dest1 = result[1][0];
      const dest2 = result[1][1];
      const bpsSplit1 = result[2][0];
      const bpsSplit2 = result[2][1];
      const amount1 = result[3][0];
      const amount2 = result[3][1];
      if (!creatorFees[dest1]) {
        creatorFees[dest1] = toBN(0);
      }
      if (!creatorFees[dest2]) {
        creatorFees[dest2] = toBN(0);
      }
      expect(amount1).to.equal(creatorFee.mul(bpsSplit1).div(CREATOR_FEE_BPS));
      expect(amount2).to.equal(creatorFee.mul(bpsSplit2).div(CREATOR_FEE_BPS));
      creatorFees[dest1] = creatorFees[dest1].add(amount1);
      creatorFees[dest2] = creatorFees[dest2].add(amount2);

      // console.log('creatorFees dest1', dest1, creatorFees[dest1], 'creatorFees dest2', dest2, creatorFees[dest2]);

      const allocatedCreatorFee1 = await infinityFeeTreasury.creatorFees(dest1, token.address);
      expect(allocatedCreatorFee1.toString()).to.equal(creatorFees[dest1].toString());
      const allocatedCreatorFee2 = await infinityFeeTreasury.creatorFees(dest2, token.address);
      expect(allocatedCreatorFee2.toString()).to.equal(creatorFees[dest2].toString());

      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(totalFee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
    });
  });

  describe('Set_Royalty_In_IERC2981_Collection2', () => {
    it('Should set royalty', async function () {
      await mock721ContractRoyalty.connect(signer1).setRoyaltyBps(CREATOR_FEE_BPS_IERC2981);
      const result = await mock721ContractRoyalty.royaltyInfo(0, ethers.utils.parseEther('1'));
      const recipient = result[0];
      const amount = result[1];
      const calcRoyalty = ethers.utils.parseEther('1').mul(CREATOR_FEE_BPS_IERC2981).div(10000);
      expect(recipient).to.equal(signer1.address);
      expect(amount.toString()).to.equal(calcRoyalty);
    });
  });

  describe('Set_Royalty_In_RoyaltyEngine_Collection3', () => {
    it('Should set royalty', async function () {
      await mockRoyaltyEngine.connect(signer1).setRoyaltyBps(mock721Contract3.address, CREATOR_FEE_BPS_ENGINE);
      const result = await mockRoyaltyEngine.getRoyaltyView(mock721Contract3.address, 0, ethers.utils.parseEther('1'));
      const recipient = result[0][0];
      const amount = result[1][0];
      const calcRoyalty = ethers.utils.parseEther('1').mul(CREATOR_FEE_BPS_ENGINE).div(10000);
      expect(recipient).to.equal(signer1.address);
      expect(amount.toString()).to.equal(calcRoyalty);
    });
  });

  describe('Take_MultipleCollectionsMultipleTokensSell', () => {
    it('Should take valid order from infinity registry, ierc2981 and royalty engine', async function () {
      const sellOrder = sellOrders[++numTakeOrders];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const nfts = sellOrder.nfts;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

      // approve currency
      let salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);

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

      // sale price
      salePrice = getCurrentSignedOrderPrice(buyOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
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
      const numColls = nfts.length;
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      // console.log('salePrice', salePrice.toString());
      // console.log('sale price by numColls', numColls, salePrice.div(numColls).toString());
      const creatorFeeInfinityRegistry = salePrice.div(numColls).mul(CREATOR_FEE_BPS).div(10000).sub(1); // sub 1 for rounding
      totalCreatorFees = totalCreatorFees.add(creatorFeeInfinityRegistry);
      const creatorFeeIerc2981 = salePrice.div(numColls).mul(CREATOR_FEE_BPS_IERC2981).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFeeIerc2981);
      const creatorFeeRoyaltyEngine = salePrice.div(numColls).mul(CREATOR_FEE_BPS_ENGINE).div(10000);
      // console.log('creatorFeeInfinityRegistry', creatorFeeInfinityRegistry.toString());
      // console.log('creatorFeeIerc2981', creatorFeeIerc2981.toString());
      // console.log('creatorFeeRoyaltyEngine', creatorFeeRoyaltyEngine.toString());
      totalCreatorFees = totalCreatorFees.add(creatorFeeRoyaltyEngine);

      const totalFee = fee.add(creatorFeeInfinityRegistry.add(creatorFeeRoyaltyEngine).add(creatorFeeIerc2981));
      // console.log(
      //   'fee',
      //   fee,
      //   'total fee',
      //   totalFee.toString(),
      //   'totalCuratorFees',
      //   totalCuratorFees.toString(),
      //   'totalCreatorFees',
      //   totalCreatorFees.toString()
      // );
      totalFeeSoFar = totalCuratorFees.add(totalCreatorFees);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalFeeSoFar);

      const result1 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract1.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest1 = result1[1][0];
      const dest2 = result1[1][1];
      const bpsSplit1 = result1[2][0];
      const bpsSplit2 = result1[2][1];
      const amount1 = result1[3][0];
      const amount2 = result1[3][1];
      if (!creatorFees[dest1]) {
        creatorFees[dest1] = toBN(0);
      }
      if (!creatorFees[dest2]) {
        creatorFees[dest2] = toBN(0);
      }
      expect(amount1).to.equal(creatorFeeInfinityRegistry.mul(bpsSplit1).div(CREATOR_FEE_BPS));
      expect(amount2).to.equal(creatorFeeInfinityRegistry.mul(bpsSplit2).div(CREATOR_FEE_BPS));
      creatorFees[dest1] = creatorFees[dest1].add(amount1);
      creatorFees[dest2] = creatorFees[dest2].add(amount2);

      const result2 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721ContractRoyalty.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest2_1 = result2[1][0];
      const amount2_1 = result2[3][0];
      // console.log(
      //   'creator fees dest1',
      //   dest1,
      //   creatorFees[dest1],
      //   'creator fees dest2',
      //   dest2,
      //   creatorFees[dest2],
      //   'creator fees dest2_1',
      //   dest2_1,
      //   creatorFees[dest2_1]
      // );
      if (!creatorFees[dest2_1]) {
        creatorFees[dest2_1] = toBN(0);
      }
      expect(amount2_1).to.equal(creatorFeeIerc2981);
      creatorFees[dest2_1] = creatorFees[dest2_1].add(amount2_1);

      const result3 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract3.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest3_1 = result3[1][0];
      const amount3_1 = result3[3][0];
      if (!creatorFees[dest3_1]) {
        creatorFees[dest3_1] = toBN(0);
      }
      expect(amount3_1).to.equal(creatorFeeRoyaltyEngine);
      creatorFees[dest3_1] = creatorFees[dest3_1].add(amount3_1);

      const allocatedCreatorFee1 = await infinityFeeTreasury.creatorFees(dest1, token.address);
      expect(allocatedCreatorFee1.toString()).to.equal(creatorFees[dest1].toString());
      const allocatedCreatorFee2 = await infinityFeeTreasury.creatorFees(dest2, token.address);
      expect(allocatedCreatorFee2.toString()).to.equal(creatorFees[dest2].toString());
      const allocatedCreatorFee2_1 = await infinityFeeTreasury.creatorFees(dest2_1, token.address);
      expect(allocatedCreatorFee2_1.toString()).to.equal(creatorFees[dest2_1].toString());
      const allocatedCreatorFee3_1 = await infinityFeeTreasury.creatorFees(dest3_1, token.address);
      expect(allocatedCreatorFee3_1.toString()).to.equal(creatorFees[dest3_1].toString());

      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(totalFee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
    });
  });

  describe('Setup_IERC2981_Collection_With_Infinity_Registry', () => {
    it('Should succeed', async function () {
      await infinityCreatorsFeeManager
        .connect(signer1)
        .setupCollectionForCreatorFeeShare(mock721ContractRoyalty.address, [signer2.address], [CREATOR_FEE_BPS]);

      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721ContractRoyalty.address,
        0,
        ethers.utils.parseEther('1')
      );
      const setter = result[0];
      const dest1 = result[1][0];
      const bpsSplit1 = result[2][0];
      const amount1 = result[3][0];
      const calcRoyalty1 = ethers.utils.parseEther('1').mul(CREATOR_FEE_BPS).div(10000);
      expect(setter).to.equal(signer1.address);
      expect(dest1).to.equal(signer2.address);
      expect(bpsSplit1).to.equal(CREATOR_FEE_BPS);
      expect(amount1.toString()).to.equal(calcRoyalty1);
    });
  });

  describe('Take_MultipleCollectionsAnyTokensSell', () => {
    it('Should take valid order from infinity registry, infinity registry again and royalty engine', async function () {
      const sellOrder = sellOrders[++numTakeOrders];
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

      // approve currency
      let salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);

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

      // sale price
      salePrice = getCurrentSignedOrderPrice(buyOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
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
      const numColls = nfts.length;
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      const creatorFeeInfinityRegistry = salePrice.div(numColls).mul(CREATOR_FEE_BPS).div(10000).sub(1); // sub 1 for rounding;
      totalCreatorFees = totalCreatorFees.add(creatorFeeInfinityRegistry);
      const creatorFeeInfinityRegistry2 = salePrice.div(numColls).mul(CREATOR_FEE_BPS).div(10000).sub(1); // sub 1 for rounding
      totalCreatorFees = totalCreatorFees.add(creatorFeeInfinityRegistry2);
      const creatorFeeRoyaltyEngine = salePrice.div(numColls).mul(CREATOR_FEE_BPS_ENGINE).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFeeRoyaltyEngine);

      const totalFee = fee
        .add(creatorFeeInfinityRegistry)
        .add(creatorFeeInfinityRegistry2)
        .add(creatorFeeRoyaltyEngine);
      totalFeeSoFar = totalCreatorFees.add(totalCuratorFees).add(1); // add 1 for rounding;
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalFeeSoFar);

      const result1 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract1.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest1 = result1[1][0];
      const dest2 = result1[1][1];
      const bpsSplit1 = result1[2][0];
      const bpsSplit2 = result1[2][1];
      const amount1 = result1[3][0];
      const amount2 = result1[3][1];
      if (!creatorFees[dest1]) {
        creatorFees[dest1] = toBN(0);
      }
      if (!creatorFees[dest2]) {
        creatorFees[dest2] = toBN(0);
      }
      expect(amount1).to.equal(creatorFeeInfinityRegistry.mul(bpsSplit1).div(CREATOR_FEE_BPS));
      expect(amount2).to.equal(creatorFeeInfinityRegistry.mul(bpsSplit2).div(CREATOR_FEE_BPS));
      creatorFees[dest1] = creatorFees[dest1].add(amount1);
      creatorFees[dest2] = creatorFees[dest2].add(amount2);

      const result2 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721ContractRoyalty.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest2_1 = result2[1][0];
      const bpsSplit2_1 = result2[2][0];
      const amount2_1 = result2[3][0];
      if (!creatorFees[dest2_1]) {
        creatorFees[dest2_1] = toBN(0);
      }
      expect(amount2_1).to.equal(creatorFeeInfinityRegistry2.mul(bpsSplit2_1).div(CREATOR_FEE_BPS));
      creatorFees[dest2_1] = creatorFees[dest2_1].add(amount2_1);

      const result3 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract3.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest3_1 = result3[1][0];
      const amount3_1 = result3[3][0];
      if (!creatorFees[dest3_1]) {
        creatorFees[dest3_1] = toBN(0);
      }
      expect(amount3_1).to.equal(creatorFeeRoyaltyEngine);
      creatorFees[dest3_1] = creatorFees[dest3_1].add(amount3_1);

      const allocatedCreatorFee1 = await infinityFeeTreasury.creatorFees(dest1, token.address);
      expect(allocatedCreatorFee1.toString()).to.equal(creatorFees[dest1].add(1).toString());
      const allocatedCreatorFee2 = await infinityFeeTreasury.creatorFees(dest2, token.address);
      expect(allocatedCreatorFee2.toString()).to.equal(creatorFees[dest2].toString());
      const allocatedCreatorFee2_1 = await infinityFeeTreasury.creatorFees(dest2_1, token.address);
      expect(allocatedCreatorFee2_1.toString()).to.equal(creatorFees[dest2_1].add(1).toString());
      const allocatedCreatorFee3_1 = await infinityFeeTreasury.creatorFees(dest3_1, token.address);
      expect(allocatedCreatorFee3_1.toString()).to.equal(creatorFees[dest3_1].toString());

      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(totalFee).sub(1)); // sub 1 for rounding
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
    });
  });

  describe('Setup_Royalty_Engine_Collection_With_Infinity_Registry', () => {
    it('Should succeed', async function () {
      await infinityCreatorsFeeManager
        .connect(signer1)
        .setupCollectionForCreatorFeeShare(mock721Contract3.address, [signer3.address], [CREATOR_FEE_BPS]);

      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract3.address,
        0,
        ethers.utils.parseEther('1')
      );
      const setter = result[0];
      const dest1 = result[1][0];
      const bpsSplit1 = result[2][0];
      const amount1 = result[3][0];
      const calcRoyalty1 = ethers.utils.parseEther('1').mul(CREATOR_FEE_BPS).div(10000);
      expect(setter).to.equal(signer1.address);
      expect(dest1).to.equal(signer3.address);
      expect(bpsSplit1).to.equal(CREATOR_FEE_BPS);
      expect(amount1.toString()).to.equal(calcRoyalty1);
    });
  });

  describe('Take_AnyCollectionAnyOneTokenSell', () => {
    it('Should take valid order from infinity registry', async function () {
      const sellOrder = sellOrders[++numTakeOrders];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

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

      // approve currency
      let salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);

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

      // sale price
      salePrice = getCurrentSignedOrderPrice(buyOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
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
      const numColls = nfts.length;
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      const creatorFeeInfinityRegistry = salePrice.div(numColls).mul(CREATOR_FEE_BPS).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFeeInfinityRegistry);

      const totalFee = fee.add(creatorFeeInfinityRegistry);
      totalFeeSoFar = totalCreatorFees.add(totalCuratorFees).add(1); // add 1 for rounding
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalFeeSoFar);

      const result3 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract3.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest3_1 = result3[1][0];
      const bpsSplit3_1 = result3[2][0];
      const amount3_1 = result3[3][0];
      if (!creatorFees[dest3_1]) {
        creatorFees[dest3_1] = toBN(0);
      }
      expect(amount3_1).to.equal(creatorFeeInfinityRegistry.mul(bpsSplit3_1).div(CREATOR_FEE_BPS));
      creatorFees[dest3_1] = creatorFees[dest3_1].add(amount3_1);
      const allocatedCreatorFee3_1 = await infinityFeeTreasury.creatorFees(dest3_1, token.address);
      expect(allocatedCreatorFee3_1.toString()).to.equal(creatorFees[dest3_1].toString());

      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(totalFee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
    });
  });

  describe('Reset_Collection2_From_Infinity_Registry', () => {
    it('Should succeed', async function () {
      await infinityCreatorsFeeManager
        .connect(signer1)
        .setupCollectionForCreatorFeeShare(mock721ContractRoyalty.address, [], []);

      const salePrice = toBN(ethers.utils.parseEther('1'));
      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(mock721ContractRoyalty.address, 0, salePrice);
      const setter = result[0];
      const dest1 = result[1][0];
      const bpsSplit1 = result[2][0];
      const amount1 = result[3][0];
      expect(setter).to.equal(NULL_ADDRESS);
      expect(dest1).to.equal(signer1.address);
      expect(bpsSplit1).to.equal(undefined);
      expect(amount1).to.equal(salePrice.mul(CREATOR_FEE_BPS_IERC2981).div(10000));
    });
  });

  describe('Reset_Collection3_From_Infinity_Registry', () => {
    it('Should succeed', async function () {
      await infinityCreatorsFeeManager
        .connect(signer1)
        .setupCollectionForCreatorFeeShare(mock721Contract3.address, [], []);

      const salePrice = toBN(ethers.utils.parseEther('1'));
      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(mock721Contract3.address, 0, salePrice);
      const setter = result[0];
      const dest1 = result[1][0];
      const bpsSplit1 = result[2][0];
      const amount1 = result[3][0];
      expect(setter).to.equal(NULL_ADDRESS);
      expect(dest1).to.equal(signer1.address);
      expect(bpsSplit1).to.equal(undefined);
      expect(amount1).to.equal(salePrice.mul(CREATOR_FEE_BPS_ENGINE).div(10000));
    });
  });

  describe('Take_AnyCollectionAnyMultipleTokensSell', () => {
    it('Should take valid order from infinity registry, ierc2981 and royalty engine', async function () {
      const sellOrder = sellOrders[++numTakeOrders];
      const chainId = network.config.chainId;
      const contractAddress = infinityExchange.address;
      const isSellOrder = false;

      const constraints = sellOrder.constraints;
      const execParams = sellOrder.execParams;
      const extraParams = sellOrder.extraParams;

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
        collection: mock721ContractRoyalty.address,
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

      // approve currency
      let salePrice = getCurrentSignedOrderPrice(sellOrder);
      await approveERC20(signer1.address, execParams[1], salePrice, signer1, infinityFeeTreasury.address);

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

      // sale price
      salePrice = getCurrentSignedOrderPrice(buyOrder);

      // balance before sale
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);

      // perform exchange
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
      const numColls = nfts.length;
      const fee = salePrice.mul(CURATOR_FEE_BPS).div(10000);
      totalCuratorFees = totalCuratorFees.add(fee);
      const creatorFeeInfinityRegistry = salePrice.div(numColls).mul(CREATOR_FEE_BPS).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFeeInfinityRegistry);
      const creatorFeeIerc2981 = salePrice.div(numColls).mul(CREATOR_FEE_BPS_IERC2981).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFeeIerc2981);
      const creatorFeeRoyaltyEngine = salePrice.div(numColls).mul(CREATOR_FEE_BPS_ENGINE).div(10000);
      totalCreatorFees = totalCreatorFees.add(creatorFeeRoyaltyEngine);

      totalFeeSoFar = totalCreatorFees.add(totalCuratorFees).add(1);
      const totalFee = fee.add(creatorFeeInfinityRegistry).add(creatorFeeRoyaltyEngine).add(creatorFeeIerc2981);
      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(totalFeeSoFar);

      const result1 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract1.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest1 = result1[1][0];
      const dest2 = result1[1][1];
      const bpsSplit1 = result1[2][0];
      const bpsSplit2 = result1[2][1];
      const amount1 = result1[3][0];
      const amount2 = result1[3][1];
      if (!creatorFees[dest1]) {
        creatorFees[dest1] = toBN(0);
      }
      if (!creatorFees[dest2]) {
        creatorFees[dest2] = toBN(0);
      }
      expect(amount1).to.equal(creatorFeeInfinityRegistry.mul(bpsSplit1).div(CREATOR_FEE_BPS).add(3));
      expect(amount2).to.equal(creatorFeeInfinityRegistry.mul(bpsSplit2).div(CREATOR_FEE_BPS).add(3));
      creatorFees[dest1] = creatorFees[dest1].add(amount1);
      creatorFees[dest2] = creatorFees[dest2].add(amount2);

      const result2 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721ContractRoyalty.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest2_1 = result2[1][0];
      const amount2_1 = result2[3][0];
      if (!creatorFees[dest2_1]) {
        creatorFees[dest2_1] = toBN(0);
      }
      expect(amount2_1).to.equal(creatorFeeIerc2981.add(5));
      creatorFees[dest2_1] = creatorFees[dest2_1].add(amount2_1);

      const result3 = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract3.address,
        0,
        toFloor(salePrice.div(numColls))
      );
      const dest3_1 = result3[1][0];
      const amount3_1 = result3[3][0];
      if (!creatorFees[dest3_1]) {
        creatorFees[dest3_1] = toBN(0);
      }
      expect(amount3_1).to.equal(creatorFeeRoyaltyEngine.add(3));
      creatorFees[dest3_1] = creatorFees[dest3_1].add(amount3_1);

      const allocatedCreatorFee1 = await infinityFeeTreasury.creatorFees(dest1, token.address);
      expect(allocatedCreatorFee1.toString()).to.equal(creatorFees[dest1].sub(2).toString());
      const allocatedCreatorFee2 = await infinityFeeTreasury.creatorFees(dest2, token.address);
      expect(allocatedCreatorFee2.toString()).to.equal(creatorFees[dest2].sub(3).toString());
      const allocatedCreatorFee2_1 = await infinityFeeTreasury.creatorFees(dest2_1, token.address);
      expect(allocatedCreatorFee2_1.toString()).to.equal(creatorFees[dest2_1].sub(8).toString());
      const allocatedCreatorFee3_1 = await infinityFeeTreasury.creatorFees(dest3_1, token.address);
      expect(allocatedCreatorFee3_1.toString()).to.equal(creatorFees[dest3_1].sub(8).toString());

      signer1Balance = signer1Balance.sub(salePrice);
      signer2Balance = signer2Balance.add(salePrice.sub(totalFee));
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
    });
  });

  describe('Try_SetBps_TooHigh', () => {
    it('Should not succeed', async function () {
      await expect(
        infinityCreatorsFeeManager
          .connect(signer1)
          .setupCollectionForCreatorFeeShare(
            mock721Contract1.address,
            [signer1.address, signer2.address],
            [CREATOR_FEE_BPS * 2, CREATOR_FEE_BPS * 2]
          )
      ).to.be.revertedWith('bps too high');

      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract1.address,
        0,
        ethers.utils.parseEther('1')
      );
      const setter = result[0];
      const dest1 = result[1][0];
      const dest2 = result[1][1];
      const bpsSplit1 = result[2][0];
      const bpsSplit2 = result[2][1];
      const amount1 = result[3][0];
      const amount2 = result[3][1];
      const calcRoyalty1 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 2)
        .div(10000);
      const calcRoyalty2 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 2)
        .div(10000);
      expect(setter).to.equal(signer1.address);
      expect(dest1).to.equal(signer2.address);
      expect(dest2).to.equal(signer3.address);
      expect(bpsSplit1).to.equal(CREATOR_FEE_BPS / 2);
      expect(bpsSplit2).to.equal(CREATOR_FEE_BPS / 2);
      expect(amount1.toString()).to.equal(calcRoyalty1);
      expect(amount2.toString()).to.equal(calcRoyalty2);
    });
  });

  describe('Try_Setup_Collection_NonOwner', () => {
    it('Should not succeed', async function () {
      await expect(
        infinityCreatorsFeeManager
          .connect(signer2)
          .setupCollectionForCreatorFeeShare(
            mock721Contract1.address,
            [signer1.address, signer2.address],
            [CREATOR_FEE_BPS / 4, CREATOR_FEE_BPS / 4]
          )
      ).to.be.revertedWith('unauthorized');

      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract1.address,
        0,
        ethers.utils.parseEther('1')
      );
      const setter = result[0];
      const dest1 = result[1][0];
      const dest2 = result[1][1];
      const bpsSplit1 = result[2][0];
      const bpsSplit2 = result[2][1];
      const amount1 = result[3][0];
      const amount2 = result[3][1];
      const calcRoyalty1 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 2)
        .div(10000);
      const calcRoyalty2 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 2)
        .div(10000);
      expect(setter).to.equal(signer1.address);
      expect(dest1).to.equal(signer2.address);
      expect(dest2).to.equal(signer3.address);
      expect(bpsSplit1).to.equal(CREATOR_FEE_BPS / 2);
      expect(bpsSplit2).to.equal(CREATOR_FEE_BPS / 2);
      expect(amount1.toString()).to.equal(calcRoyalty1);
      expect(amount2.toString()).to.equal(calcRoyalty2);
    });
  });

  describe('Setup_Collection_NonOwner_ButAdmin', () => {
    it('Should succeed', async function () {
      await infinityCreatorsFeeManager
        .connect(signer1)
        .setupCollectionForCreatorFeeShare(
          mock721Contract4.address,
          [signer1.address, signer2.address],
          [CREATOR_FEE_BPS / 4, CREATOR_FEE_BPS / 4]
        );

      const result = await infinityCreatorsFeeManager.getCreatorsFeeInfo(
        mock721Contract4.address,
        0,
        ethers.utils.parseEther('1')
      );
      const setter = result[0];
      const dest1 = result[1][0];
      const dest2 = result[1][1];
      const bpsSplit1 = result[2][0];
      const bpsSplit2 = result[2][1];
      const amount1 = result[3][0];
      const amount2 = result[3][1];
      const calcRoyalty1 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 4)
        .div(10000);
      const calcRoyalty2 = ethers.utils
        .parseEther('1')
        .mul(CREATOR_FEE_BPS / 4)
        .div(10000);
      expect(setter).to.equal(signer1.address);
      expect(dest1).to.equal(signer1.address);
      expect(dest2).to.equal(signer2.address);
      expect(bpsSplit1).to.equal(CREATOR_FEE_BPS / 4);
      expect(bpsSplit2).to.equal(CREATOR_FEE_BPS / 4);
      expect(amount1.toString()).to.equal(calcRoyalty1);
      expect(amount2.toString()).to.equal(calcRoyalty2);

      // reset
      await infinityCreatorsFeeManager
        .connect(signer1)
        .setupCollectionForCreatorFeeShare(mock721Contract4.address, [], []);
    });
  });

  describe('Claim creator fees', () => {
    it('Should claim', async function () {
      // pre
      let feeTreasuryBalance = toBN(await token.balanceOf(infinityFeeTreasury.address));
      let creatorFeeBalance1 = toBN(await infinityFeeTreasury.creatorFees(signer1.address, token.address));
      let creatorFeeBalance2 = toBN(await infinityFeeTreasury.creatorFees(signer2.address, token.address));
      let signer1Balance = toBN(await token.balanceOf(signer1.address));
      let signer2Balance = toBN(await token.balanceOf(signer2.address));

      // claim
      await infinityFeeTreasury.connect(signer1).claimCreatorFees(token.address);
      await infinityFeeTreasury.connect(signer2).claimCreatorFees(token.address);

      // post
      feeTreasuryBalance = feeTreasuryBalance.sub(creatorFeeBalance1).sub(creatorFeeBalance2);
      signer1Balance = signer1Balance.add(creatorFeeBalance1);
      signer2Balance = signer2Balance.add(creatorFeeBalance2);

      expect(await token.balanceOf(infinityFeeTreasury.address)).to.equal(feeTreasuryBalance);
      expect(await token.balanceOf(signer1.address)).to.equal(signer1Balance);
      expect(await token.balanceOf(signer2.address)).to.equal(signer2Balance);
      expect(await await infinityFeeTreasury.creatorFees(signer1.address, token.address)).to.equal(0);
      expect(await await infinityFeeTreasury.creatorFees(signer2.address, token.address)).to.equal(0);

      // claiming again should fail
      await expect(infinityFeeTreasury.connect(signer1).claimCreatorFees(token.address)).to.be.revertedWith(
        'Fees: No creator fees to claim'
      );
      await expect(infinityFeeTreasury.connect(signer2).claimCreatorFees(token.address)).to.be.revertedWith(
        'Fees: No creator fees to claim'
      );
    });
  });
});
