// SPDX-License-Identifier: MIT

pragma solidity 0.8.14;

interface IMerkleDistributor {
  // This event is triggered whenever a call to #setMerkleRoot succeeds.
  event MerkelRootUpdated(address currency, bytes32 oldMerkleRoot, bytes32 newMerkleRoot);

  // Sets the merkle root of the merkle tree containing cumulative account balances available to claim.
  function setMerkleRoot(address currency, bytes32 merkleRoot) external;

  function verify(
    bytes32[] calldata proof,
    bytes32 root,
    bytes32 leaf
  ) external returns (bool);
}
