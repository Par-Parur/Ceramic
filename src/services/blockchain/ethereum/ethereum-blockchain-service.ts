import type { CID } from 'multiformats/cid'
import { base16 } from 'multiformats/bases/base16'
import {
  BigNumberish,
  Contract,
  ethers,
  TransactionResponse,
  TransactionRequest,
  isError,
  Network,
} from 'ethers'
import { Config } from 'node-config-ts'
import * as uint8arrays from 'uint8arrays'

import { logger, logEvent, logMetric } from '../../../logger/index.js'
import { Transaction } from '../../../models/transaction.js'
import { BlockchainService } from '../blockchain-service.js'
import { Utils } from '../../../utils.js'

const BASE_CHAIN_ID = 'eip155'
const TX_SUCCESS = 1
const NUM_BLOCKS_TO_WAIT = 4
export const MAX_RETRIES = 3

const ABI = ['function anchorDagCbor(bytes32)']

class WrongChainIdError extends Error {
  constructor(expected: bigint, actual: bigint) {
    super(
      `Chain ID of connected blockchain changed from ${caipChainId(expected)} to ${caipChainId(
        actual
      )}`
    )
  }
}

/**
 * Adds padding to our fees
 */
function addPadding(number: bigint): bigint {
  return number + number / BigInt(10)
}

/**
 * Do up to +max+ attempts of an +operation+. Expect the +operation+ to return a defined value.
 * If no defined value is returned, iterate at most +max+ times.
 *
 * @param max - Maximum number of attempts.
 * @param operation - Operation to run.
 */
async function attempt<T>(
  max: number,
  operation: (attempt: number) => Promise<T | undefined | void>
): Promise<T> {
  let attempt = 0
  while (attempt < max) {
    const result = await operation(attempt)
    if (result) {
      return result
    }
    attempt++
    logger.warn(`Failed to send transaction; ${max - attempt} retries remain`)
    await Utils.delay(5000)
  }
  // All attempts spent
  throw new Error('Failed to send transaction')
}

/**
 * Throw if a transaction requires more funds than available.
 *
 * @param txData - Transaction to write.
 * @param walletBalance - Available funds.
 */
function handleInsufficientFundsError(txData: TransactionRequest, walletBalance: bigint): void {
  const gasLimit = Utils.checkNotNull(() => txData.gasLimit, 'No gas limit')
  const maxFeePerGas = Utils.checkNotNull(() => txData.maxFeePerGas, 'No max fee per gas')
  const txCost = BigInt(gasLimit) * BigInt(maxFeePerGas)
  if (txCost > walletBalance) {
    logEvent.ethereum({
      type: 'insufficientFunds',
      txCost: txCost,
      balance: ethers.formatUnits(walletBalance, 'gwei'),
    })

    const errMsg = `Transaction cost is greater than our current balance. [txCost: ${txCost.toString(
      16
    )}, balance: ${walletBalance.toString(16)}]`
    logger.err(errMsg)
    throw new Error(errMsg)
  }
}

/**
 * Represent chainId in CAIP format.
 * @param chainId - Numeric chain id.
 */
function caipChainId(chainId: bigint | number) {
  return `${BASE_CHAIN_ID}:${chainId}`
}

/**
 * Throw if +actual+ and +expected+ chain ids are not equal.
 *
 * @param actual - Chain id we received.
 * @param expected - Chain id we expect.
 */
function assertSameChainId(actual: bigint, expected: bigint) {
  if (actual != expected) {
    // TODO: This should be process-fatal
    throw new WrongChainIdError(expected, actual)
  }
}

/**
 * Just log a timeout error.
 */
function handleTimeoutError(transactionTimeoutSecs: number): void {
  logEvent.ethereum({
    type: 'transactionTimeout',
    transactionTimeoutSecs: transactionTimeoutSecs,
  })
  logger.err(`Transaction timed out after ${transactionTimeoutSecs} seconds without being mined`)
}

function make(config: Config): EthereumBlockchainService {
  const ethereum = config.blockchain.connectors.ethereum
  const { host, port, url } = ethereum.rpc
  let options
  let network
  try {
    network = Network.from(ethereum.network)
    options = {
      staticNetwork: network,
    }
  } catch (e) {
    logger.warn(`Network ${ethereum.network} is unknown, cannot use static network`)
  }

  let provider
  if (url) {
    logger.imp(`Connecting ethereum provider to url: ${url}`)
    provider = new ethers.JsonRpcProvider(url, network, options)
  } else if (host && port) {
    logger.imp(`Connecting ethereum provider to host: ${host} and port ${port}`)
    const hostPort = `${host}:${port}`
    provider = new ethers.JsonRpcProvider(hostPort, network, options)
  } else if (network) {
    logger.imp(`Connecting ethereum to etherscan provider for network ${ethereum.network}`)
    const opts = {
      alchemy: '-',
      ankr: '-',
      cloudflare: '-',
      etherscan: ethereum.account.privateKey,
      infura: '-',
      quicknode: '-',
    }
    provider = ethers.getDefaultProvider(network, opts)
  } else {
    throw new Error(
      `Cannot connect to ${ethereum.network}, it is an unknown network. Please provide url or host and port`
    )
  }

  const wallet = new ethers.Wallet(ethereum.account.privateKey, provider)
  return new EthereumBlockchainService(config, wallet)
}
make.inject = ['config'] as const

/**
 * Ethereum blockchain service
 */
export class EthereumBlockchainService implements BlockchainService {
  private _chainId: bigint | undefined
  private readonly network: string
  private readonly transactionTimeoutSecs: number
  private readonly contract: Contract
  private readonly overrideGasConfig: boolean
  private readonly gasLimit: bigint
  private readonly useSmartContractAnchors: boolean
  private readonly contractAddress: string

  constructor(config: Config, private readonly wallet: ethers.Wallet) {
    this.useSmartContractAnchors = config.useSmartContractAnchors
    const ethereumConfig = config.blockchain.connectors.ethereum
    this.network = ethereumConfig.network
    this.transactionTimeoutSecs = ethereumConfig.transactionTimeoutSecs
    this.contract = new ethers.Contract(ethereumConfig.contractAddress, ABI, this.wallet)
    this.overrideGasConfig = ethereumConfig.overrideGasConfig
    this.gasLimit = BigInt(ethereumConfig.gasLimit)
    this.contractAddress = ethereumConfig.contractAddress
  }

  static make = make

  /**
   * Connects to blockchain
   */
  async connect(): Promise<void> {
    logger.imp(`Connecting to ${this.network} blockchain...`)
    await this._loadChainId()
    logger.imp(`Connected to ${this.network} blockchain with chain ID ${this.chainId}`)
  }

  /**
   * Returns a string representing the CAIP-2 ID of the configured blockchain by querying the
   * connected blockchain to ask for it.
   */
  private async _loadChainId(): Promise<void> {
    const provider = Utils.checkNotNull(() => this.wallet.provider, 'No wallet provider')
    const network = await provider.getNetwork()
    this._chainId = network.chainId
  }

  /**
   * Sets the gas price for the transaction request.
   * For pre-1559 transaction we increase vanilla gasPrice by 10% each time. For a 1559 transaction, we increase maxPriorityFeePerGas,
   * again by 10% each time.
   *
   * For 1559 there are two parameters that can be set on a transaction: maxPriorityFeePerGas and maxFeePerGas.
   * maxFeePerGas should equal to `maxPriorityFeePerGas` (our tip to a miner) plus `baseFee` (ETH burned according to current network conditions).
   * To estimate the current parameters, we use `getFeeData` function, which returns two of our parameters.
   * Here we _can_ calculate `baseFee`, but also we can avoid doing that. Remember, we increase just `maxPriorityFeePerGas`.
   * Here we calculate a difference between previously sent `maxPriorityFeePerGas` and the increased one. It is our voluntary
   * increase in gas price we agree to pay to mine our transaction.
   * We just add the difference to a currently estimated `maxFeePerGas` so that we conform to the equality
   * `maxFeePerGas = baseFee + maxPriorityFeePerGas`.
   *
   * NB. EIP1559 now uses two components of gas cost: `baseFee` and `maxPriorityFeePerGas`. `maxPriorityFeePerGas` is a
   * tip to a miner to include a transaction into a block. `baseFee` is a slowly changing amount of gas or ether that is
   * going to be burned. `baseFee` is set by _network_. Since we do not know what `baseFee` will be, EIP1559 introduces
   * `maxFeePerGas` which is an absolute maximum you are willing to pay for a transaction. `maxFeePerGas` must be
   * `>= maxPriorityFeePerGas + baseFee`. The inequality here is to accommodate for changes in `baseFee`. If
   * `maxFeePerGas` appears to be less than the sum, the transaction is underpriced. If it is greater than the sum
   * (`maxFeePerGas = maxPriorityFeePerGas + baseFee + δ`):
   * - if `baseFee` changes up to `δ`, the transaction can be mined still; `δ` is like a safety buffer;
   * - transaction fee that is deducted from your wallet still equals `maxPriorityFeePerGas + baseFee`, no matter what `maxFeePerGas` you have set.
   *
   * To price a 1559 transaction, we use an estimate from `provider.getFeeData`. It returns `maxFeePerGas` and `maxPriorityFeePerGas`. It is worth noting here that `maxFeePerGas` returned from ethers uses a [widely recommended](https://www.blocknative.com/blog/eip-1559-fees) formula: `(baseFee of the latest block)*2 + (constant 2.5Gwei)`. If we only increase `maxPriorityFeePerGas` per attempt, we effectively deduct from our baseFee safety buffer `δ` which reduces transaction's chances. Our intent though is to increase a transaction's "mineability". So, when increasing `maxPriorityFeePerGas` we also increase `maxFeePerGas` by the same amount. Now the safety buffer reflects current network conditions, and we actually increase our transaction's "mineability".
   *
   * @param txData - transaction request data
   * @param attempt - what number attempt this is at submitting the transaction.  We increase
   *   the gas price we set by a 10% multiple with each subsequent attempt
   * @private
   */
  async setGasPrice(txData: TransactionRequest): Promise<void> {
    if (this.overrideGasConfig) {
      txData.gasLimit = this.gasLimit
      logger.debug('Overriding Gas limit: ' + txData.gasLimit.toString())
      return
    }

    const walletProvider = Utils.checkNotNull(() => this.wallet.provider, 'No wallet provider')
    const feeData = await Utils.checkNotNullAsync(() => walletProvider.getFeeData(), 'No fee data')
    // Add extra to gas price for each subsequent attempt
    const maxFeePerGas = feeData.maxFeePerGas
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    // Is EIP-1559
    if (maxPriorityFeePerGas && maxFeePerGas) {
      const baseFee = maxFeePerGas - maxPriorityFeePerGas
      const prevPriorityFee = BigInt(txData.maxPriorityFeePerGas || feeData.maxPriorityFeePerGas)
      const nextPriorityFee = EthereumBlockchainService.increaseGasPricePerAttempt(
        maxPriorityFeePerGas,
        prevPriorityFee
      )
      txData.maxPriorityFeePerGas = nextPriorityFee
      // must be greater than baseFee + maxPriorityFeePerGas
      txData.maxFeePerGas = addPadding(baseFee + nextPriorityFee)
      logger.debug(
        `Estimated maxPriorityFeePerGas: ${txData.maxPriorityFeePerGas.toString()} wei; maxFeePerGas: ${txData.maxFeePerGas.toString()} wei`
      )
    } else {
      const feeDataGasPrice = Utils.checkNotNull(
        () => feeData.gasPrice,
        `Unavailable gas price for pre-EIP-1559 transaction`
      )
      // When attempt 0, use currently estimated gasPrice; otherwise use previous transaction gasPrice
      const prevGasPrice = BigInt(txData.gasPrice || feeDataGasPrice)
      txData.gasPrice = EthereumBlockchainService.increaseGasPricePerAttempt(
        feeDataGasPrice,
        prevGasPrice
      )
      logger.debug(`Estimated gasPrice: ${txData.gasPrice.toString()} wei`)
    }

    txData.gasLimit = await walletProvider.estimateGas(txData)
    logger.debug('Estimated Gas limit: ' + txData.gasLimit.toString())
  }

  /**
   * Take current gas price (or maxPriorityFeePerGas for 1559 transaction), and attempt number,
   * and return new gas price (or maxPriorityFeePerGas for 1559 transaction) with 10% increase per attempt.
   * If this isn't the first attempt, also ensures that the new gas is at least 10% greater than the
   * previous attempt's gas, even if the gas price on chain has gone down since then. This is because
   * retries of the same transaction (using the same nonce) need to have a gas price at least 10% higher
   * than any previous attempts or the transaction will fail.
   *
   * @param estimate - Currently estimated gas price
   * @param attempt - Index of a current attempt, starts with 0.
   * @param previousGas - Either gasPrice for pre-1559 tx or maxPriorityFeePerGas for 1559 tx.
   */
  static increaseGasPricePerAttempt(
    estimate: BigNumberish,
    previousGas: BigNumberish | undefined
  ): bigint {
    if (previousGas == undefined) {
      return addPadding(BigInt(estimate))
    } else {
      return addPadding(BigInt(estimate > previousGas ? estimate : previousGas))
    }
  }

  /**
   * Returns the cached 'chainId' representing the CAIP-2 ID of the configured blockchain.
   * Invalid to call before calling connect()
   */
  get chainId(): string {
    if (!this._chainId) throw new Error(`No chainId available`)
    return caipChainId(this._chainId)
  }

  async _buildTransactionRequest(rootCid: CID): Promise<TransactionRequest> {
    logger.debug('Preparing ethereum transaction')
    const provider = Utils.checkNotNull(() => this.wallet.provider, 'No wallet provider')
    const baseNonce = await provider.getTransactionCount(this.wallet.address)

    if (!this.useSmartContractAnchors) {
      const rootStrHex = rootCid.toString(base16)
      const hexEncoded = '0x' + (rootStrHex.length % 2 == 0 ? rootStrHex : '0' + rootStrHex)
      logger.debug(`Hex encoded root CID ${hexEncoded}`)

      return {
        to: this.wallet.address,
        data: hexEncoded,
        nonce: baseNonce,
        from: this.wallet.address,
      }
    }

    const hexEncoded = '0x' + uint8arrays.toString(rootCid.bytes.slice(4), 'base16')
    // @ts-ignore `anchorDagCbor` is a Solidity function
    const transactionRequest = await this.contract.anchorDagCbor(hexEncoded)
    return {
      to: this.contractAddress,
      data: transactionRequest.data,
      nonce: baseNonce,
      from: this.wallet.address,
    }
  }

  /**
   * One attempt at submitting the prepared TransactionRequest to the ethereum blockchain.
   * @param txData
   */
  async _trySendTransaction(txData: TransactionRequest): Promise<TransactionResponse> {
    logger.imp(
      'Transaction data:' +
        JSON.stringify(txData, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    )

    logEvent.ethereum({
      type: 'txRequest',
      tx: txData,
    })
    logger.imp(`Sending transaction to Ethereum ${this.network} network...`)
    const txResponse = await Utils.checkNotNullAsync(
      () => this.wallet.sendTransaction(txData),
      'No transaction'
    )
    logEvent.ethereum({
      type: 'txResponse',
      hash: txResponse.hash,
      blockNumber: txResponse.blockNumber,
      blockHash: txResponse.blockHash,
      from: txResponse.from,
      raw: txResponse.data,
    })

    if (!this._chainId) throw new Error(`No chainId available`)
    assertSameChainId(txResponse.chainId, this._chainId)
    return txResponse
  }

  /**
   * Queries the blockchain to see if the submitted transaction was successfully mined, and returns
   * the transaction info if so.
   * @param txResponse - response from when the transaction was submitted to the mempool
   */
  async _confirmTransactionSuccess(txResponse: TransactionResponse): Promise<Transaction> {
    logger.imp(`Waiting to confirm transaction with hash ${txResponse.hash}`)
    const walletProvider = await Utils.checkNotNull(
      () => this.wallet.provider,
      'No wallet provider'
    )
    const txReceipt = await Utils.checkNotNullAsync(
      () =>
        walletProvider.waitForTransaction(
          txResponse.hash,
          NUM_BLOCKS_TO_WAIT,
          this.transactionTimeoutSecs * 1000
        ),
      'No transaction receipt'
    )
    logEvent.ethereum({
      type: 'txReceipt',
      tx: txReceipt,
    })
    const block = await Utils.checkNotNullAsync(
      () => walletProvider.getBlock(txReceipt.blockHash),
      'No block found'
    )
    const blockDate = Utils.checkNotNull(() => block.date, 'Block has no date')

    const statusMessage = txReceipt.status == TX_SUCCESS ? 'success' : 'failure'
    logger.imp(
      `Transaction completed on Ethereum ${this.network} network. Transaction hash: ${txReceipt.blockHash}. Status: ${statusMessage}.`
    )
    if (txReceipt.status != TX_SUCCESS) {
      throw new Error('Transaction completed with a failure status')
    }

    return new Transaction(this.chainId, txReceipt.hash, txReceipt.blockNumber, blockDate)
  }

  /**
   * Queries the blockchain to see if any of the previously submitted transactions that had timed
   * out went on to be successfully mined, and returns the transaction info if so.
   * @param txResponses - responses from previous transaction submissions.
   */
  async _checkForPreviousTransactionSuccess(
    txResponses: Array<TransactionResponse>
  ): Promise<Transaction> {
    for (let i = txResponses.length - 1; i >= 0; i--) {
      const txResponse = txResponses[i]
      if (!txResponse) continue
      try {
        return await this._confirmTransactionSuccess(txResponse)
      } catch (err: any) {
        logger.err(err)
      }
    }
    throw new Error('Failed to confirm any previous transaction attempts')
  }

  /**
   * Sends transaction with root CID as data
   */
  async sendTransaction(rootCid: CID): Promise<Transaction> {
    const txData = await this._buildTransactionRequest(rootCid)
    const txResponses: Array<TransactionResponse> = []

    return this.withWalletBalance((walletBalance) => {
      return attempt(MAX_RETRIES, async (attemptNum) => {
        try {
          await this.setGasPrice(txData)
          const txResponse = await this._trySendTransaction(txData)
          txResponses.push(txResponse)
          return await this._confirmTransactionSuccess(txResponse)
        } catch (err: any) {
          logger.err(err)
          if (isError(err, 'INSUFFICIENT_FUNDS')) {
            return handleInsufficientFundsError(txData, walletBalance)
          } else if (isError(err, 'TIMEOUT')) {
            return handleTimeoutError(this.transactionTimeoutSecs)
          } else if (isError(err, 'NONCE_EXPIRED') || isNonceError(err)) {
            // If this happens it most likely means that one of our previous attempts timed out, but
            // then actually wound up being successfully mined
            logEvent.ethereum({
              type: 'nonceExpired',
              nonce: txData.nonce,
            })
            if (attemptNum == 0 || txResponses.length == 0) {
              throw err
            }
            return this._checkForPreviousTransactionSuccess(txResponses)
          } else {
            throw new Error(`Unhandled error in attempt: ${err}`)
          }
        }
      })
    })
  }

  /**
   * Report wallet balance before and after +operation+.
   * @param operation
   */
  private async withWalletBalance<T>(operation: (balance: bigint) => Promise<T>): Promise<T> {
    const provider = Utils.checkNotNull(() => this.wallet.provider, 'No wallet provider')
    const startingWalletBalance = await Utils.checkNotNullAsync(
      () => provider.getBalance(this.wallet.address),
      `No wallet balance for ${this.wallet.address}`
    )
    logMetric.ethereum({
      type: 'walletBalance',
      balance: ethers.formatUnits(startingWalletBalance, 'gwei'),
    })
    logger.debug(`Current wallet balance is ` + startingWalletBalance)

    const result = await operation(startingWalletBalance)

    const endingWalletBalance = await Utils.checkNotNullAsync(
      () => provider.getBalance(this.wallet.address),
      `No wallet balance for ${this.wallet.address}`
    )
    logMetric.ethereum({
      type: 'walletBalance',
      balance: ethers.formatUnits(endingWalletBalance, 'gwei'),
    })
    return result
  }
}

function isNonceError(err: any): boolean {
  return isError(err, 'UNKNOWN_ERROR') && err.message.includes('correct nonce')
}
