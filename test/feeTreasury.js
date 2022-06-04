const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { MerkleTree } = require('merkletreejs');
const { keccak256, solidityKeccak256 } = require('ethers/lib/utils');

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

let signers, token, merkleDistributor, leaves, proofs, root, hashedElements, merkleTree, startingAmount;
let amounts = [];

function findSortedIndex(i) {
  return leaves.indexOf(hashedElements[i]);
}

function toBN(val) {
  return ethers.BigNumber.from(val.toString());
}

describe('FeeTreasury', function () {
  before(async () => {
    signers = await ethers.getSigners();

    for (let i = 1; i <= 20; i++) {
      amounts.push(toBN(i * 10).mul(UNIT));
    }

    hashedElements = signers.map((signer, index) =>
      solidityKeccak256(['address', 'uint256'], [signer.address, amounts[index]])
    );

    let elements = hashedElements.slice(0, 15);

    merkleTree = new MerkleTree(elements, keccak256, {
      sort: true
    });

    leaves = merkleTree.getHexLeaves();
    proofs = leaves.map(merkleTree.getHexProof, merkleTree);
    root = merkleTree.getHexRoot();

    const InfinityToken = await ethers.getContractFactory('InfinityToken');
    token = await InfinityToken.deploy(
      signers[0].address,
      INFLATION.toString(),
      EPOCH_DURATION.toString(),
      CLIFF_PERIOD.toString(),
      MAX_EPOCHS.toString(),
      TIMELOCK.toString(),
      INITIAL_SUPPLY.toString()
    );
    await token.deployed();

    const MerkleDistributor = await ethers.getContractFactory('MerkleDistributor');

    merkleDistributor = await MerkleDistributor.deploy(token.address);
    await merkleDistributor.deployed();

    await token.transfer(merkleDistributor.address, INITIAL_SUPPLY);

    await merkleDistributor.setMerkleRoot(root);
  });

  describe('Setup', () => {
    it('Should init properly', async function () {
      expect(await merkleDistributor.token()).to.equal(token.address);
      expect(await merkleDistributor.merkleRoot()).to.equal(root);
    });
  });

  describe('Claiming', () => {
    it('Should not allow address not on accesslist to claim', async function () {
      await expect(
        merkleDistributor.claim(signers[15].address, amounts[1], root, proofs[findSortedIndex(1)])
      ).to.be.revertedWith('Merkle distributor: Invalid proof');
    });
    it('Should not allow address on accesslist but wrong amount to claim', async function () {
      await expect(
        merkleDistributor.claim(signers[1].address, amounts[2], root, proofs[findSortedIndex(1)])
      ).to.be.revertedWith('Merkle distributor: Invalid proof');
    });
    it('Should allow addresses on accesslist to claim', async function () {
      expect((await token.balanceOf(signers[1].address)).toString()).to.equal('0');
      await merkleDistributor.claim(signers[1].address, amounts[1], root, proofs[findSortedIndex(1)]);
      expect((await token.balanceOf(signers[1].address)).toString()).to.equal(amounts[1].toString());

      expect((await token.balanceOf(signers[2].address)).toString()).to.equal('0');
      await merkleDistributor.claim(signers[2].address, amounts[2], root, proofs[findSortedIndex(2)]);
      expect((await token.balanceOf(signers[2].address)).toString()).to.equal(amounts[2].toString());
    });
    it('Should not allow address on accesslist to double claim', async function () {
      await expect(
        merkleDistributor.claim(signers[1].address, amounts[1], root, proofs[findSortedIndex(1)])
      ).to.be.revertedWith('Merkle distributor: Nothing to claim');
    });
    it('Should allow address on accesslist to claim more if root is updated', async function () {
      const MORE = toBN(3333333);

      startingAmount = amounts[1].toString();
      amounts[1] = amounts[1].add(MORE);
      hashedElements = signers.map((signer, index) =>
        solidityKeccak256(['address', 'uint256'], [signer.address, amounts[index]])
      );

      let elements = hashedElements.slice(0, 15);

      merkleTree = new MerkleTree(elements, keccak256, {
        sort: true
      });

      leaves = merkleTree.getHexLeaves();
      proofs = leaves.map(merkleTree.getHexProof, merkleTree);
      root = merkleTree.getHexRoot();

      await merkleDistributor.setMerkleRoot(root);

      let startingBalance = (await token.balanceOf(signers[1].address)).toString();
      expect(startingBalance).to.equal(startingAmount);
      await merkleDistributor.claim(signers[1].address, amounts[1], root, proofs[findSortedIndex(1)]);
      expect((await token.balanceOf(signers[1].address)).toString()).to.equal(amounts[1].toString());
      expect((await token.balanceOf(signers[1].address)).toString()).to.equal(
        toBN(startingAmount).add(MORE).toString()
      );
    });
  });
});
