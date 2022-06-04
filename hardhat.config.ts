import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import 'hardhat-gas-reporter';

import { HardhatUserConfig } from 'hardhat/config';

require('dotenv').config();
require('hardhat-contract-sizer');

export default {
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
      gas: 10000000
    }
  },
  solidity: {
    compilers: [
      {
        version: '0.8.14',
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 99999999
          }
        }
      }
    ]
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false
  }
} as HardhatUserConfig;
