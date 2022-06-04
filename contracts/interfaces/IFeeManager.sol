// SPDX-License-Identifier: MIT
pragma solidity 0.8.14;

enum FeeParty {
  CREATORS,
  COLLECTORS,
  CURATORS
}

interface IFeeManager {
  function calcFeesAndGetRecipients(
    address complication,
    address collection,
    uint256 tokenId,
    uint256 amount
  )
    external
    view
    returns (
      FeeParty partyName,
      address[] memory,
      uint256[] memory
    );
}
