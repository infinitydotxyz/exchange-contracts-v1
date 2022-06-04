const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deployContract } = require('../tasks/utils');
const { prepareOBOrder, getCurrentSignedOrderPrice, signFormattedOrder } = require('../helpers/orders');
const { nowSeconds } = require('../tasks/utils');
const { erc721Abi } = require('../abi/erc721');

describe('Exchange_ETH_Creator_Fee_Maker_Sell_Taker_Buy', function () {
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

  let signer1EthBalance = 0;
  let signer2EthBalance = 0;
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
    await currencyRegistry.addCurrency(ZERO_ADDRESS);

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
      const execParams = { complicationAddress: obComplication.address, currencyAddress: ZERO_ADDRESS };
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
      const execParams = { complicationAddress: obComplication.address, currencyAddress: ZERO_ADDRESS };
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
      const salePriceInEth = parseFloat(ethers.utils.formatEther(salePrice));

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
      signer1EthBalance = parseFloat(ethers.utils.formatEther(await ethers.provider.getBalance(signer1.address)));
      signer2EthBalance = parseFloat(ethers.utils.formatEther(await ethers.provider.getBalance(signer2.address)));

      // perform exchange
      const options = {
        value: salePrice
      };
      await infinityExchange.connect(signer1).takeOrders([sellOrder], [buyOrder], false, false, options);

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
      const feeInEth = parseFloat(ethers.utils.formatEther(fee));
      totalCuratorFees = totalCuratorFees.add(fee);
      expect(await ethers.provider.getBalance(infinityFeeTreasury.address)).to.equal(totalCuratorFees);
      expect(await ethers.provider.getBalance(infinityExchange.address)).to.equal(0);
      signer1EthBalance = signer1EthBalance - salePriceInEth;
      signer2EthBalance = signer2EthBalance + (salePriceInEth - feeInEth);
      const signer1EthBalanceAfter = parseFloat(
        ethers.utils.formatEther(await ethers.provider.getBalance(signer1.address))
      );
      const signer2EthBalanceAfter = parseFloat(
        ethers.utils.formatEther(await ethers.provider.getBalance(signer2.address))
      );
      expect(signer1EthBalanceAfter).to.be.lessThan(signer1EthBalance); // to account for gas
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
      const salePriceInEth = parseFloat(ethers.utils.formatEther(salePrice));

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

      // perform exchange
      const options = {
        value: salePrice
      };
      await infinityExchange.connect(signer1).takeOrders([sellOrder], [buyOrder], false, false, options);

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
      const totalFeeInEth = parseFloat(ethers.utils.formatEther(totalFee));

      totalFeeSoFar = totalCuratorFees.add(totalCreatorFees);
      expect(await ethers.provider.getBalance(infinityFeeTreasury.address)).to.equal(totalFeeSoFar);
      expect(await ethers.provider.getBalance(infinityExchange.address)).to.equal(0);

      const result = await mockRoyaltyEngine.getRoyaltyView(mock721Contract1.address, 0, salePrice);
      const recipient = result[0][0];
      const amount = result[1][0];
      if (!creatorFees[recipient]) {
        creatorFees[recipient] = toBN(0);
      }
      expect(amount).to.equal(creatorFee);
      creatorFees[recipient] = creatorFees[recipient].add(creatorFee);
      // console.log('creatorFees recepient', recipient, creatorFees[recipient]);

      const allocatedCreatorFee = await infinityFeeTreasury.creatorFees(recipient, ZERO_ADDRESS);
      expect(allocatedCreatorFee.toString()).to.equal(creatorFees[recipient].toString());

      signer1EthBalance = signer1EthBalance - salePriceInEth;
      signer2EthBalance = signer2EthBalance + (salePriceInEth - totalFeeInEth);
      const signer1EthBalanceAfter = parseFloat(
        ethers.utils.formatEther(await ethers.provider.getBalance(signer1.address))
      );
      const signer2EthBalanceAfter = parseFloat(
        ethers.utils.formatEther(await ethers.provider.getBalance(signer2.address))
      );
      expect(signer1EthBalanceAfter).to.be.lessThan(signer1EthBalance); // to account for gas
      // expect(signer2EthBalanceAfter).to.equal(signer2EthBalance);
    });
  });

  describe('Claim creator fees', () => {
    it('Should claim', async function () {
      // pre
      let feeTreasuryBalance = toBN(await ethers.provider.getBalance(infinityFeeTreasury.address));
      let creatorFeeBalance1 = toBN(await infinityFeeTreasury.creatorFees(signer1.address, ZERO_ADDRESS));
      let signer1Balance = toBN(await ethers.provider.getBalance(signer1.address));

      // claim
      await infinityFeeTreasury.connect(signer1).claimCreatorFees(ZERO_ADDRESS);

      // post
      feeTreasuryBalance = feeTreasuryBalance.sub(creatorFeeBalance1);
      signer1Balance = signer1Balance.add(creatorFeeBalance1);

      expect(await ethers.provider.getBalance(infinityFeeTreasury.address)).to.equal(feeTreasuryBalance);
      expect(await await infinityFeeTreasury.creatorFees(signer1.address, ZERO_ADDRESS)).to.equal(0);

      // claiming again should fail
      await expect(infinityFeeTreasury.connect(signer1).claimCreatorFees(ZERO_ADDRESS)).to.be.revertedWith(
        'Fees: No creator fees to claim'
      );
      await expect(infinityFeeTreasury.connect(signer2).claimCreatorFees(ZERO_ADDRESS)).to.be.revertedWith(
        'Fees: No creator fees to claim'
      );
    });
  });
});
