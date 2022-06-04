#! /bin/sh

# helps in reading stdout better
printSeparator() {
    echo '======================================= Test Complete ========================================='
    echo '+++++++++++++++++++++++++++++++++++++ Running next test +++++++++++++++++++++++++++++++++++++++'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
    echo '***********************************************************************************************'
}

echo 'Running all tests...'
npx hardhat test --grep Exchange_Cancel
printSeparator

npx hardhat test --grep Exchange_Creator
printSeparator

npx hardhat test --grep Exchange_ETH_Creator_Fee_Maker_Sell_Taker_Buy
printSeparator

npx hardhat test --grep Exchange_Invalid
printSeparator

npx hardhat test --grep Exchange_Maker_Buy
printSeparator

npx hardhat test --grep Exchange_Maker_Sell
printSeparator

npx hardhat test --grep Exchange_ETH_Maker_Sell_Taker_Buy
printSeparator

npx hardhat test --grep Exchange_Match
printSeparator

npx hardhat test --grep Exchange_Staker_Discount
printSeparator

npx hardhat test --grep Exchange_Rewards
printSeparator

npx hardhat test --grep Exchange_Varying
printSeparator

npx hardhat test --grep Staker_Tests
printSeparator

npx hardhat test --grep Infinity_Token
echo 'All tests complete!'