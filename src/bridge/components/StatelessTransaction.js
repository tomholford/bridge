import { Nothing, Just } from 'folktale/maybe'
import { Ok } from 'folktale/result'
import React from 'react'

import { Code, H3 } from './Base'
import { Button } from './Base'
import { CheckboxButton, Input, InnerLabel,
  InnerLabelDropdown } from './Base'
import {  Warning } from '../components/Base'

import { addressFromSecp256k1Public } from '../lib/wallet'
import { BRIDGE_ERROR } from '../lib/error'
import { ROUTE_NAMES } from '../lib/router'
import * as tank from '../lib/tank'

import {
  sendSignedTransaction,
  waitForTransactionConfirm,
  fromWei,
  toWei,
  hexify,
  renderSignedTx,
  signTransaction
 } from '../lib/txn'

const SUBMISSION_STATES = {
  PROMPT: 'Send transaction',
  FUNDING: 'Finding transaction funding...',
  SENDING: 'Sending transaction...'
};

class StatelessTransaction extends React.Component {

  constructor(props) {
    super(props)

    this.state = {
      gasPrice: '5',
      gasLimit: '600000',
      showGasDetails: false,
      userApproval: false,
      chainId: '1',
      customChain: false,
      nonce: '0',
      stx: Nothing(),
      txn: Nothing(),
      txStatus: SUBMISSION_STATES.PROMPT,
      txError: Nothing()
    }

    this.createUnsignedTxn = this.createUnsignedTxn.bind(this)
    this.setUserApproval = this.setUserApproval.bind(this)
    this.setTxn = this.setTxn.bind(this)
    this.setStx = this.setStx.bind(this)
    this.sendTxn = this.sendTxn.bind(this)
    this.setNonce = this.setNonce.bind(this)
    this.setChainId = this.setChainId.bind(this)
    this.setGasPrice = this.setGasPrice.bind(this)
    this.setGasLimit = this.setGasLimit.bind(this)
    this.rangeChange = this.rangeChange.bind(this)
    this.toggleGasDetails = this.toggleGasDetails.bind(this)
    this.handleChainUpdate = this.handleChainUpdate.bind(this)
  }

  componentDidMount() {
    const { props } = this

    const addr = props.wallet.matchWith({
      Just: wal => addressFromSecp256k1Public(wal.value.publicKey),
      Nothing: () => {
        throw BRIDGE_ERROR.MISSING_WALLET
      }
    })

    props.web3.matchWith({
      Nothing: () => {},
      Just: (w3) => {
        const validWeb3 = w3.value

        const getTxMetadata = [
          validWeb3.eth.getTransactionCount(addr),
          validWeb3.eth.net.getId(),
          validWeb3.eth.getGasPrice()
        ];

        Promise.all(getTxMetadata).then(r => {
          const txMetadata = {
            nonce: r[0],
            chainId: r[1],
            gasPrice: fromWei(r[2], 'gwei'),
          };

          this.setState({...txMetadata})

        })
      }
    });
  }

  handleChainUpdate(chainId) {
    if (chainId === "custom") {
      this.setState({
        customChain: true
      })
    } else {
      this.setState({
        customChain: false,
        chainId
      })
    }

    this.clearStx()
  }

  setUserApproval(){
    const {state} = this
    this.setState({ userApproval: !state.userApproval })
  }

  toggleGasDetails() {
    this.setState({
      showGasDetails: !this.state.showGasDetails
    })
  }

  setStx(stx){
    this.setState({
      stx,
      userApproval: false,
    })
  }

  setTxn(txn){
    this.setState({ txn })
  }

  createUnsignedTxn() {
    const txn = this.props.createUnsignedTxn()

    this.setState({ txn })
  }

  clearTxn() {
    this.setState({
      userApproval: false,
      txn: Nothing(),
      stx: Nothing(),
    })
  }

  setNonce(nonce){
    this.setState({ nonce })
    this.clearStx()
  }

  setChainId(chainId){
    this.setState({ chainId })
    this.clearStx()
  }

  setGasPrice(gasPrice) {
    this.setState({ gasPrice })
    this.clearStx()
  }

  rangeChange(e) {
    this.setGasPrice(e.target.value);
  }

  setGasLimit(gasLimit){
    this.setState({ gasLimit })
    this.clearStx()
  }

  clearStx() {
    this.setState({
      userApproval: false,
      stx: Nothing(),
    })
  }

  async sendTxn() {
    const { props, state } = this;
    const web3 = props.web3.value;

    this.setState({ txStatus: SUBMISSION_STATES.FUNDING });

    const stx = state.stx.matchWith({
      Just: tx => tx.value,
      Nothing: () => {
        throw BRIDGE_ERROR.MISSING_TXN;
      }
    });
    const rawTx = hexify(stx.serialize());
    const cost = (state.gasLimit * toWei(state.gasPrice, 'gwei'));

    //TODO need a lib function or something for address=, it's everywhere
    const address = props.wallet.matchWith({
      Just: wal => addressFromSecp256k1Public(wal.value.publicKey),
      Nothing: () => {
        throw BRIDGE_ERROR.MISSING_WALLET
      }
    });
    let balance = await web3.eth.getBalance(address);
    let hasBalance = (balance >= cost);

    let usedTank = false;
    // if we need to, try and fund the transaction
    if (!hasBalance) {
      hasBalance = await this.ensureFundsFor(web3, address, cost, [rawTx]);
      usedTank = hasBalance;
    }

    // if we still don't have sufficient balance, fail and tell the user
    if (!hasBalance) {
      this.setState({
        txStatus: SUBMISSION_STATES.PROMPT,
        txError: Just(`Insufficient funds.
          Address ${address} needs at least ${fromWei(cost.toString())} ETH,
          currently has ${fromWei(balance.toString())} ETH.`
        )
      });

    // if we have the balance, proceed with submission
    } else {
      this.setState({ txStatus: SUBMISSION_STATES.SENDING });

      sendSignedTransaction(
        web3,
        state.stx,
        usedTank,
        props.setTxnConfirmations
      )
      .then(txHash => {
        props.setTxnHashCursor(Just(Ok(txHash)));
        props.popRoute();

        let routeData = {};
        if (props.networkSeed) {
          props.setNetworkSeedCache(props.networkSeed);
          routeData.promptKeyfile = true;
        }
        if (props.promptText) {
          routeData.promptText = props.promptText;
        }
        props.pushRoute(ROUTE_NAMES.SENT_TRANSACTION, routeData);
      })
      .catch(err => {
        this.setState({
          txStatus: SUBMISSION_STATES.PROMPT,
          txError: err
        });
      });
    }
  }

  //TODO partially copied from InviteTransactions, try to move into tank lib
  async ensureFundsFor(web3, address, cost, signedTxs) {
    let balance = await web3.eth.getBalance(address);
    if (cost > balance) {
      try {

        const res = await tank.fundTransactions(signedTxs);
        if (!res.success) {
          return false;
        } else {
          await waitForTransactionConfirm(web3, res.txHash);
          return true;
        }

      } catch (e) {
        return false;
      }
    } else {
      return true;
    }
  }

  getChainTitle(chainId) {
    let map = {
      "1": "Mainnet - 1",
      "2": "Morden - 2",
      "3": "Ropsten - 3",
      "4": "Goerli - 4",
      "42": "Kovan - 42",
      "1337": "Geth private chains - 1337",
      "custom": "Custom"
    }

    return map[chainId]
  }

  getChainOptions() {
    return [{
      title: this.getChainTitle("1"),
      value: "1"
    }, {
      title: this.getChainTitle("2"),
      value: "2"
    }, {
      title: this.getChainTitle("3"),
      value: "3"
    }, {
      title: this.getChainTitle("4"),
      value: "4"
    }, {
      title: this.getChainTitle("42"),
      value: "42"
    }, {
      title: this.getChainTitle("1337"),
      value: "1337"
    }, {
      title: this.getChainTitle("custom"),
      value: "custom"
    }]
  }

  render() {
    const { web3, canGenerate } = this.props
    const { gasPrice, gasLimit, nonce, chainId,
      txn, stx, userApproval, showGasDetails,
      customChain, txStatus } = this.state

    const { setNonce, setChainId, setGasLimit, setGasPrice, toggleGasDetails,
      setUserApproval, sendTxn, createUnsignedTxn, handleChainUpdate } = this

    const { state } = this

    const canSign = Just.hasInstance(txn)
    const canApprove = Just.hasInstance(stx)
    const canSend = Just.hasInstance(stx) && userApproval === true

    const chainOptions = this.getChainOptions()

    const generateButtonColor =
        Nothing.hasInstance(txn)
      ? 'blue'
      : 'green'

    const signerButtonColor =
        Nothing.hasInstance(stx)
      ? 'blue'
      : 'green'

    const generateTxnButton =
      <Button
        className={ 'mt-8' }
        disabled={ !canGenerate }
        prop-color={ generateButtonColor }
        prop-size={ 'lg wide' }
        onClick={ createUnsignedTxn }
      >
        { 'Generate Transaction' }
      </Button>

    const unsignedTxnDisplay = txn.matchWith({
      Nothing: _ => '',
      Just: tx =>
        <React.Fragment>
          <H3 className={ 'mt-8' }>
            { 'Unsigned Transaction' }
          </H3>
          <Code>
            { JSON.stringify(tx.value, null, 2) }
          </Code>
        </React.Fragment>
    })

    const gasPriceRangeDialogue = (
      <React.Fragment>
        <div className="mt-12 flex space-between align-baseline">
          <div>
            <span>Gas Price:</span>
            <span className="ml-4 text-700 text-sm">{gasPrice} gwei</span>
          </div>
          <div className="text-sm">
            <span>Max transaction fee: </span>
            <span className="text-700">{(gasPrice * gasLimit) / 1000000000} eth</span>
          </div>
        </div>

        <input
          className="mt-4"
          type="range"
          min="2"
          max="20"
          list="gweiVals"
          value={gasPrice}
          onChange={this.rangeChange}
          />

        <div className="flex space-between text-sm mb-8">
          <div>Cheap</div>
          <div>Fast</div>
        </div>
      </React.Fragment>
    )

    const toggleGasDetailsDialogue = (
      <span className="text-link" onClick={toggleGasDetails}>Gas Details</span>
    )

    const gasPriceDialogue =
      <Input
        className={ 'mono mt-4' }
        prop-size={ 'md' }
        prop-format={ 'innerLabel' }
        value={ gasPrice }
        onChange={ setGasPrice }
      >
        <InnerLabel>
          { 'Gas Price (gwei)' }
        </InnerLabel>
      </Input>

    const gasLimitDialogue =
      <Input
        className={ 'mono mt-4' }
        prop-size={ 'md' }
        prop-format={ 'innerLabel' }
        value={ gasLimit }
        onChange={ setGasLimit }>
        <InnerLabel>
          { 'Gas Limit' }
        </InnerLabel>
      </Input>

    const nonceDialogue =
      <Input
        className={ 'mono mt-4 mb-4' }
        prop-size={ 'md' }
        prop-format={ 'innerLabel' }
        value={ nonce }
        onChange={ setNonce }
      >
        <InnerLabel>
          { 'Nonce' }
        </InnerLabel>
      </Input>

    const chainDialogueTitle = customChain ? "Custom" : this.getChainTitle(chainId)
    const chainDialogue =
      <InnerLabelDropdown
        className={'mt-6'}
        fullWidth={true}
        title={'Chain ID'}
        options={chainOptions}
        handleUpdate={handleChainUpdate}
        currentSelectionTitle={chainDialogueTitle}
      >
      </InnerLabelDropdown>

    const customChainDialogue = !customChain ? null :
        <Input
          className={ 'mono mt-4 mb-8' }
          prop-size={ 'md' }
          prop-format={ 'innerLabel' }
          value={ chainId }
          onChange={ setChainId }
        >
          <InnerLabel>
            { 'Chain ID' }
          </InnerLabel>
        </Input>

    const onlineParamsDialogue = web3.matchWith({
      Just: _ => <div />,
      Nothing: _ =>
        <React.Fragment>
          { nonceDialogue }
          { chainDialogue }
          { customChainDialogue }
        </React.Fragment>
    })

    const signTxnButton =
      <Button
        disabled={ !canSign }
        className={ 'mt-8' }
        prop-size={ 'lg wide' }
        prop-color={ signerButtonColor }
        onClick={ () => signTransaction({...this.props, ...this.state, setStx: this.setStx}) }
      >
        { 'Sign Transaction' }
      </Button>

    const signedTxnDisplay = stx.matchWith({
      Nothing: _ => '',
      Just: tx =>
        <React.Fragment>
          <H3 className={ 'mt-8' }>
            { 'Signed Transaction' }
          </H3>
          <Code>
            { JSON.stringify(renderSignedTx(tx.value), null, 2) }
          </Code>
        </React.Fragment>
    })

    const confirmButton =
      <CheckboxButton
        className={ 'mt-8' }
        disabled={ !canApprove }
        onClick={ setUserApproval }
        state={ userApproval }
      >
        <div onClick={ setUserApproval }>
          { `I approve this transaction and wish to send.` }
        </div>
      </CheckboxButton>

    const sending = (txStatus !== SUBMISSION_STATES.PROMPT);
    const sendTxnSpinner = sending ? '' : 'hide';
    const sendTxnButton =
      <Button
        prop-size={ 'xl wide' }
        className={ 'mt-8' }
        disabled={ !canSend || sending }
        onClick={ sendTxn }
      >
        <span className="relative">
          <span className={`btn-spinner ${sendTxnSpinner}`}></span>
          { txStatus }
        </span>
      </Button>

    const sendDialogue = web3.matchWith({
      Nothing: _ => '',
      Just: _ =>
        <React.Fragment>
          { confirmButton }
          { sendTxnButton }
        </React.Fragment>
    })

    const txnErrorDialogue = Nothing.hasInstance(state.txError)
      ? ''
      : <Warning className={'mt-8'}>
          <H3 style={{marginTop: 0, paddingTop: 0}}>
            {
              'There was an error sending your transaction.'
            }
          </H3>
          { state.txError.value }
      </Warning>

    return (
      <React.Fragment>
        { generateTxnButton }
        { unsignedTxnDisplay }

        { gasPriceRangeDialogue }
        { toggleGasDetailsDialogue }

        { showGasDetails &&
          <div>
            { gasPriceDialogue }
            { gasLimitDialogue }
          </div>
        }
        { onlineParamsDialogue }

        { signTxnButton }

        { signedTxnDisplay }
        { sendDialogue }

        { txnErrorDialogue }
      </React.Fragment>
    )
  }
}

export default StatelessTransaction
