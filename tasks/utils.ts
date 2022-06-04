import { BigNumber, Contract, ContractFactory, Signer, Wallet } from 'ethers';

export async function deployContract(
  name: string,
  factory: ContractFactory,
  signer: Signer,
  args: Array<any> = []
): Promise<Contract> {
  const contract = await factory.connect(signer).deploy(...args);
  console.log('Deploying', name, 'on', await signer.provider?.getNetwork());
  console.log('  to', contract.address);
  console.log('  in', contract.deployTransaction.hash);
  return contract.deployed();
}

export const nowSeconds = (): BigNumber => {
  return BigNumber.from(Math.floor(Date.now() / 1000));
};

export function trimLowerCase(str?: string) {
  return (str || '').trim().toLowerCase();
}

export const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
