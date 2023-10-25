import type {
  ExtendedTransactionInfo,
  FullStatusData,
  LiFiStep,
} from '@lifi/types'
import type { WalletAdapter } from '@solana/wallet-adapter-base'
import {
  VersionedTransaction,
  type TransactionConfirmationStrategy,
  type TransactionSignature,
} from '@solana/web3.js'
import { config } from '../../config.js'
import { getStepTransaction } from '../../services/api.js'
import {
  LiFiErrorCode,
  TransactionError,
  getTransactionFailedMessage,
  parseError,
} from '../../utils/index.js'
import { BaseStepExecutor } from '../BaseStepExecutor.js'
import { checkBalance } from '../checkBalance.js'
import { stepComparison } from '../stepComparison.js'
import type { StepExecutorOptions, TransactionParameters } from '../types.js'
import { getSubstatusMessage } from '../utils.js'
import { waitForReceivingTransaction } from '../waitForReceivingTransaction.js'
import { getSolanaConnection } from './connection.js'

export interface SolanaStepExecutorOptions extends StepExecutorOptions {
  walletAdapter: WalletAdapter
}

export class SolanaStepExecutor extends BaseStepExecutor {
  private walletAdapter: WalletAdapter

  constructor(options: SolanaStepExecutorOptions) {
    super(options)
    this.walletAdapter = options.walletAdapter
  }

  executeStep = async (step: LiFiStep): Promise<LiFiStep> => {
    step.execution = this.statusManager.initExecutionObject(step)

    const fromChain = await config.getChainById(step.action.fromChainId)
    const toChain = await config.getChainById(step.action.toChainId)

    const isBridgeExecution = fromChain.id !== toChain.id
    const currentProcessType = isBridgeExecution ? 'CROSS_CHAIN' : 'SWAP'

    // STEP 2: Get transaction
    let process = this.statusManager.findOrCreateProcess(
      step,
      currentProcessType
    )

    if (process.status !== 'DONE') {
      try {
        const connection = await getSolanaConnection()
        let txHash: TransactionSignature
        if (process.txHash) {
          txHash = process.txHash as TransactionSignature
        } else {
          process = this.statusManager.updateProcess(
            step,
            process.type,
            'STARTED'
          )

          // Check balance
          await checkBalance(this.walletAdapter.publicKey!.toString(), step)

          // Create new transaction
          if (!step.transactionRequest) {
            const updatedStep = await getStepTransaction(step)
            const comparedStep = await stepComparison(
              this.statusManager,
              step,
              updatedStep,
              this.allowUserInteraction,
              this.executionOptions
            )
            step = {
              ...comparedStep,
              execution: step.execution,
            }
          }

          if (!step.transactionRequest?.data) {
            throw new TransactionError(
              LiFiErrorCode.TransactionUnprepared,
              'Unable to prepare transaction.'
            )
          }

          process = this.statusManager.updateProcess(
            step,
            process.type,
            'ACTION_REQUIRED'
          )

          if (!this.allowUserInteraction) {
            return step
          }

          let transactionRequest: TransactionParameters = {
            data: step.transactionRequest.data,
          }

          if (this.executionOptions?.updateTransactionRequestHook) {
            const customizedTransactionRequest: TransactionParameters =
              await this.executionOptions.updateTransactionRequestHook({
                requestType: 'transaction',
                ...transactionRequest,
              })

            transactionRequest = {
              ...transactionRequest,
              ...customizedTransactionRequest,
            }
          }

          if (!transactionRequest.data) {
            throw new TransactionError(
              LiFiErrorCode.TransactionUnprepared,
              'Unable to prepare transaction.'
            )
          }

          const versionedTransaction = VersionedTransaction.deserialize(
            Uint8Array.from(atob(transactionRequest.data), (c) =>
              c.charCodeAt(0)
            )
          )
          txHash = await this.walletAdapter.sendTransaction(
            versionedTransaction,
            connection,
            {
              maxRetries: 5,
              skipPreflight: true,
            }
          )

          process = this.statusManager.updateProcess(
            step,
            process.type,
            'PENDING',
            {
              txHash: txHash,
              txLink: `${fromChain.metamask.blockExplorerUrls[0]}tx/${txHash}`,
            }
          )
        }

        const signatureResult = await connection.confirmTransaction(
          {
            signature: txHash,
          } as TransactionConfirmationStrategy,
          'confirmed'
        )

        if (signatureResult.value.err) {
          throw new TransactionError(
            LiFiErrorCode.TransactionFailed,
            `Transaction failed: ${signatureResult.value.err}`
          )
        }

        if (isBridgeExecution) {
          process = this.statusManager.updateProcess(step, process.type, 'DONE')
        }
      } catch (e: any) {
        const error = await parseError(e, step, process)
        process = this.statusManager.updateProcess(
          step,
          process.type,
          'FAILED',
          {
            error: {
              message: error.message,
              htmlMessage: error.htmlMessage,
              code: error.code,
            },
          }
        )
        this.statusManager.updateExecution(step, 'FAILED')
        throw error
      }
    }

    // STEP 5: Wait for the receiving chain
    const processTxHash = process.txHash
    if (isBridgeExecution) {
      process = this.statusManager.findOrCreateProcess(
        step,
        'RECEIVING_CHAIN',
        'PENDING'
      )
    }
    let statusResponse: FullStatusData
    try {
      if (!processTxHash) {
        throw new Error('Transaction hash is undefined.')
      }
      statusResponse = (await waitForReceivingTransaction(
        processTxHash,
        this.statusManager,
        process.type,
        step
      )) as FullStatusData

      const statusReceiving =
        statusResponse.receiving as ExtendedTransactionInfo

      process = this.statusManager.updateProcess(step, process.type, 'DONE', {
        substatus: statusResponse.substatus,
        substatusMessage:
          statusResponse.substatusMessage ||
          getSubstatusMessage(statusResponse.status, statusResponse.substatus),
        txHash: statusReceiving?.txHash,
        txLink: `${toChain.metamask.blockExplorerUrls[0]}tx/${statusReceiving?.txHash}`,
      })

      this.statusManager.updateExecution(step, 'DONE', {
        fromAmount: statusResponse.sending.amount,
        toAmount: statusReceiving?.amount,
        toToken: statusReceiving?.token,
        gasAmount: statusResponse.sending.gasAmount,
        gasAmountUSD: statusResponse.sending.gasAmountUSD,
        gasPrice: statusResponse.sending.gasPrice,
        gasToken: statusResponse.sending.gasToken,
        gasUsed: statusResponse.sending.gasUsed,
      })
    } catch (e: unknown) {
      const htmlMessage = await getTransactionFailedMessage(
        step,
        process.txLink
      )

      process = this.statusManager.updateProcess(step, process.type, 'FAILED', {
        error: {
          code: LiFiErrorCode.TransactionFailed,
          message: 'Failed while waiting for receiving chain.',
          htmlMessage,
        },
      })
      this.statusManager.updateExecution(step, 'FAILED')
      console.warn(e)
      throw e
    }

    // DONE
    return step
  }
}
