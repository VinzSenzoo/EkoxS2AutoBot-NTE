import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const HOODI_RPC_URL = "https://ethereum-hoodi-rpc.publicnode.com/";
const HOODI_CHAIN_ID = 560048;
const STAKE_CONTRACT_ADDRESS = "0x9E2DDb3386D5dCe991A2595E8bc44756F864C6E3";
const UNSTAKE_CLAIM_CONTRACT_ADDRESS = "0x1D150609EE9EdcC6143506Ba55A4FAaeDd562Cd9";
const EXETH_ADDRESS = "0x4d38Bd670764c49Cce1E59EeaEBD05974760aCbD";
const CONFIG_FILE = "config.json";
const isDebug = false;

const directions = [
  { chain: "hoodi", rpc: HOODI_RPC_URL, chainId: HOODI_CHAIN_ID }
];

const STAKE_ABI = [
  "function depositETH(uint256 nodeOperatorId) payable"
];

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const UNSTAKE_ABI = [
  "function withdraw(uint256 _amount, address _assetOut)"
];

const CLAIM_ABI = [
  "function getOutstandingWithdrawRequests(address user) view returns (uint256)",
  "function withdrawRequests(address user, uint256 index) view returns (uint256 exETHLocked, uint256 amountToRedeem, uint256 withdrawRequestID, uint256 createdAt, address collateralToken)",
  "function coolDownPeriod() view returns (uint256)",
  "function claim(uint256 withdrawRequestIndex, address user)"
];

let walletInfo = {
  address: "N/A",
  balanceETH: "0.0000",
  balanceEXETH: "0.0000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let accounts = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  stakeRepetitions: 1,
  unstakeRepetitions: 1,
  claimRepetitions: 1,
  ethStakeRange: { min: 0.01, max: 0.02 },
  exethUnstakeRange: { min: 0.01, max: 0.02 },
  loopHours: 24
};

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
];

const Headers = {
  'accept': 'application/json, text/plain, */*',
  'content-type': 'application/json',
  'origin': 'https://ekox.com',
  'referer': 'https://ekox.com/'
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.stakeRepetitions = Number(config.stakeRepetitions) || 1;
      dailyActivityConfig.unstakeRepetitions = Number(config.unstakeRepetitions) || 1;
      dailyActivityConfig.claimRepetitions = Number(config.claimRepetitions) || 1;
      dailyActivityConfig.ethStakeRange.min = Number(config.ethStakeRange?.min) || 0.01;
      dailyActivityConfig.ethStakeRange.max = Number(config.ethStakeRange?.max) || 0.02;
      dailyActivityConfig.exethUnstakeRange.min = Number(config.exethUnstakeRange?.min) || 0.01;
      dailyActivityConfig.exethUnstakeRange.max = Number(config.exethUnstakeRange?.max) || 0.02;
      dailyActivityConfig.loopHours = Number(config.loopHours) || 24;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeApiCall(url, method, data, proxyUrl) {
  try {
    const headers = { ...Headers, 'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)] };
    const agent = createAgent(proxyUrl);
    if (isDebug) {
      addLog(`Debug: Sending API request to ${url} with payload: ${JSON.stringify(data, null, 2)}`, "debug");
    }
    const response = await axios({ method, url, data, headers, httpsAgent: agent });
    if (isDebug) {
      addLog(`Debug: API response from ${url}: ${JSON.stringify(response.data, null, 2)}`, "debug");
    }
    return response.data;
  } catch (error) {
    addLog(`API call failed (${url}): ${error.message}`, "error");
    if (error.response) {
      addLog(`Debug: Error response: ${JSON.stringify(error.response.data, null, 2)}`, "debug");
    }
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "warn":
      coloredMessage = chalk.magentaBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    case "debug":
      coloredMessage = chalk.blueBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadAccounts() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    accounts = data.split("\n").map(line => line.trim()).filter(line => line).map(privateKey => ({ privateKey }));
    if (accounts.length === 0) {
      throw new Error("No private keys found in pk.txt");
    }
    addLog(`Loaded ${accounts.length} accounts from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function getProvider(rpcUrl, chainId, proxyUrl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const agent = createAgent(proxyUrl);
      const fetchOptions = agent ? { agent } : {};
      const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId, name: "Hoodi" }, { fetchOptions });
      return provider;
    } catch (error) {
      addLog(`Attempt ${attempt}/${maxRetries} failed to initialize provider: ${error.message}`, "error");
      if (attempt < maxRetries) sleep(1000);
    }
  }
  throw new Error(`Failed to initialize provider for chain ${chainId}`);
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = accounts.map(async (account, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const hoodiProvider = getProvider(HOODI_RPC_URL, HOODI_CHAIN_ID, proxyUrl);
      const wallet = new ethers.Wallet(account.privateKey, hoodiProvider);

      const ethBalance = await hoodiProvider.getBalance(wallet.address);
      const formattedETH = Number(ethers.formatEther(ethBalance)).toFixed(6);

      const exethContract = new ethers.Contract(EXETH_ADDRESS, ["function balanceOf(address) view returns (uint256)"], wallet);
      const exethBalance = await exethContract.balanceOf(wallet.address);
      const formattedEXETH = Number(ethers.formatEther(exethBalance)).toFixed(6);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(wallet.address))}        ${chalk.bold.cyanBright(formattedETH.padEnd(12))} ${chalk.bold.yellowBright(formattedEXETH.padEnd(12))}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = wallet.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceETH = formattedETH;
        walletInfo.balanceEXETH = formattedEXETH;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.000000 0.000000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

async function getNextNonce(provider, walletAddress, chainId) {
  if (shouldStop) {
    addLog("Nonce fetch stopped due to stop request.", "info");
    throw new Error("Process stopped");
  }
  if (!ethers.isAddress(walletAddress)) {
    addLog(`Invalid wallet address: ${walletAddress}`, "error");
    throw new Error("Invalid wallet address");
  }
  const nonceKey = `${chainId}_${walletAddress}`;
  try {
    const pendingNonce = BigInt(await provider.getTransactionCount(walletAddress, "pending"));
    const lastUsedNonce = nonceTracker[nonceKey] || (pendingNonce - 1n);
    const nextNonce = pendingNonce > lastUsedNonce + 1n ? pendingNonce : lastUsedNonce + 1n;
    nonceTracker[nonceKey] = nextNonce;
    addLog(`Debug: Fetched nonce ${nextNonce} for ${getShortAddress(walletAddress)} on chain ${chainId}`, "debug");
    return nextNonce;
  } catch (error) {
    addLog(`Failed to fetch nonce for ${getShortAddress(walletAddress)} on chain ${chainId}: ${error.message}`, "error");
    throw error;
  }
}

async function getFeeParams(provider) {
  try {
    const feeData = await provider.getFeeData();
    let params = {};
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      params = {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        type: 2
      };
    } else {
      params = {
        gasPrice: feeData.gasPrice || ethers.parseUnits("1", "gwei"),
        type: 0
      };
    }
    return params;
  } catch (error) {
    addLog(`Failed to get fee data: ${error.message}. Using default.`, "debug");
    return {
      gasPrice: ethers.parseUnits("1", "gwei"),
      type: 0
    };
  }
}

async function approveToken(wallet, tokenAddress, spender, amountWei, provider) {
  const erc20Interface = new ethers.Interface([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)'
  ]);

  const allowanceData = erc20Interface.encodeFunctionData('allowance', [wallet.address, spender]);
  const allowanceCall = { to: tokenAddress, data: allowanceData };
  const allowance = BigInt(await provider.call(allowanceCall));

  if (allowance >= amountWei) {
    addLog(`Token ${getShortAddress(tokenAddress)} already approved for ${ethers.formatEther(amountWei)}`, "info");
    return;
  }

  const approveData = erc20Interface.encodeFunctionData('approve', [spender, amountWei]);
  const feeParams = await getFeeParams(provider);
  const txParams = {
    to: tokenAddress,
    data: approveData,
    value: 0n,
    ...feeParams
  };

  const gasLimit = 100000n;
  addLog(`Using fixed gas limit for approve: ${gasLimit}`, "debug");

  const nonce = await getNextNonce(provider, wallet.address, HOODI_CHAIN_ID);
  const tx = await wallet.sendTransaction({
    ...txParams,
    gasLimit,
    nonce
  });
  addLog(`Approve Transaction sent: ${getShortHash(tx.hash)}`, "warn");

  const receipt = await tx.wait();
  if (receipt.status === 0) {
    throw new Error("Approve transaction reverted");
  }
  addLog(`Token approved successfully, Hash: ${getShortHash(tx.hash)}`, "success");
}

async function performStake(wallet, direction, amount, proxyUrl) {
  const { rpc, chainId } = direction;
  const provider = getProvider(rpc, chainId, proxyUrl);
  wallet = wallet.connect(provider);

  const amountWei = ethers.parseEther(amount.toString());
  const address = wallet.address.toLowerCase();

  const stakeContract = new ethers.Contract(STAKE_CONTRACT_ADDRESS, STAKE_ABI, wallet);
  const txData = stakeContract.interface.encodeFunctionData('depositETH', [0]);

  const ethBalance = await provider.getBalance(address);
  if (ethBalance < amountWei) {
    throw new Error(`Insufficient ETH balance: ${ethers.formatEther(ethBalance)} < ${amount}`);
  }

  const feeParams = await getFeeParams(provider);
  const txParams = {
    to: STAKE_CONTRACT_ADDRESS,
    data: txData,
    value: amountWei,
    ...feeParams
  };

  const gasLimit = 650000n;
  addLog(`Using fixed gas limit: ${gasLimit} for stake on Hoodi`, "debug");

  const gasFee = feeParams.gasPrice || feeParams.maxFeePerGas;
  const estimatedGasCost = gasFee * gasLimit;
  if (ethBalance < amountWei + estimatedGasCost) {
    throw new Error(`Insufficient ETH for amount + gas: ${ethers.formatEther(ethBalance)} < ${ethers.formatEther(amountWei + estimatedGasCost)}`);
  }

  let tx;
  try {
    const nonce = await getNextNonce(provider, address, chainId);
    tx = await wallet.sendTransaction({
      ...txParams,
      gasLimit,
      nonce
    });
    addLog(`Stake Transaction sent: ${getShortHash(tx.hash)}`, "warn");
  } catch (error) {
    addLog(`Transaction failed: ${error.message}`, "error");
    if (error.message.includes("nonce")) {
      const nonceKey = `${chainId}_${address}`;
      delete nonceTracker[nonceKey];
      addLog(`Nonce error detected, resetting nonce for next attempt.`, "warn");
    }
    throw error;
  }

  let receipt;
  const timeoutMs = 300000;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Transaction confirmation timed out")), timeoutMs);
    });
    receipt = await Promise.race([tx.wait(), timeoutPromise]);
    if (receipt.status === 0) {
      throw new Error("Transaction reverted");
    }
    addLog(`Stake ${amount} ETH for eXETH Successfully, Hash: ${getShortHash(tx.hash)}`, "success");
  } catch (error) {
    addLog(`Transaction failed: ${error.message}`, "error");
    throw error;
  } finally {

  }
}

async function performUnstake(wallet, direction, amount, proxyUrl) {
  const { rpc, chainId } = direction;
  const provider = getProvider(rpc, chainId, proxyUrl);
  wallet = wallet.connect(provider);

  const amountWei = ethers.parseEther(amount.toString());
  const address = wallet.address.toLowerCase();

  const tokenContract = new ethers.Contract(EXETH_ADDRESS, TOKEN_ABI, wallet);
  const balance = await tokenContract.balanceOf(address);
  if (balance < amountWei) {
    throw new Error(`Insufficient eXETH balance: ${ethers.formatEther(balance)} < ${amount}`);
  }

  await approveToken(wallet, EXETH_ADDRESS, UNSTAKE_CLAIM_CONTRACT_ADDRESS, amountWei, provider);

  const unstakeInterface = new ethers.Interface(UNSTAKE_ABI);
  const txData = unstakeInterface.encodeFunctionData('withdraw', [amountWei, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE']);

  const feeParams = await getFeeParams(provider);
  const txParams = {
    to: UNSTAKE_CLAIM_CONTRACT_ADDRESS,
    data: txData,
    value: 0n,
    ...feeParams
  };

  const gasLimit = 650000n;
  addLog(`Using fixed gas limit: ${gasLimit} for unstake on Hoodi`, "debug");

  const gasFee = feeParams.gasPrice || feeParams.maxFeePerGas;
  const estimatedGasCost = gasFee * gasLimit;
  const ethBalance = await provider.getBalance(address);
  if (ethBalance < estimatedGasCost) {
    throw new Error(`Insufficient ETH for gas: ${ethers.formatEther(ethBalance)} < ${ethers.formatEther(estimatedGasCost)}`);
  }

  let tx;
  try {
    const nonce = await getNextNonce(provider, address, chainId);
    tx = await wallet.sendTransaction({
      ...txParams,
      gasLimit,
      nonce
    });
    addLog(`Unstake Transaction sent: ${getShortHash(tx.hash)}`, "warn");
  } catch (error) {
    addLog(`Transaction failed: ${error.message}`, "error");
    if (error.message.includes("nonce")) {
      const nonceKey = `${chainId}_${address}`;
      delete nonceTracker[nonceKey];
      addLog(`Nonce error detected, resetting nonce for next attempt.`, "warn");
    }
    throw error;
  }

  let receipt;
  const timeoutMs = 300000;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Transaction confirmation timed out")), timeoutMs);
    });
    receipt = await Promise.race([tx.wait(), timeoutPromise]);
    if (receipt.status === 0) {
      throw new Error("Transaction reverted");
    }
    addLog(`Unstake ${amount} eXETH for ETH Successfully, Hash: ${getShortHash(tx.hash)}`, "success");
  } catch (error) {
    addLog(`Transaction failed: ${error.message}`, "error");
    throw error;
  } finally {

  }
}

async function debugCheckClaimable(provider, contract, user, index) {
  const req = await contract.withdrawRequests(user, BigInt(index));
  const cool = await contract.coolDownPeriod();
  const latest = await provider.getBlock('latest');
  const now = BigInt(latest.timestamp);
  const isReady = (req[3] + cool) <= now;
  const withdrawRequestID = req[2];
  return { isReady, withdrawRequestID, amountToRedeem: req[1] };
}


async function performClaim(wallet, direction, proxyUrl) {
  const { rpc, chainId } = direction;
  const provider = getProvider(rpc, chainId, proxyUrl);
  wallet = wallet.connect(provider);

  const address = wallet.address.toLowerCase();
  const contract = new ethers.Contract(UNSTAKE_CLAIM_CONTRACT_ADDRESS, CLAIM_ABI, wallet);

  const count = await contract.getOutstandingWithdrawRequests(address);
  if (count == 0n) throw new Error("No  Withdraw Request Available To Claim");

  const readyRequests = [];
  const coolDown = await contract.coolDownPeriod();

  const latestBlock = await provider.getBlock('latest');
  const now = BigInt(latestBlock.timestamp);

  for (let i = 0n; i < count; i++) {
    const request = await contract.withdrawRequests(address, i);
    const exETHLocked = request[0];
    const amountToRedeem = request[1];
    const withdrawRequestID = request[2];
    const createdAt = request[3];
    const collateralToken = request[4];

    const isReady = (createdAt + coolDown) <= now;

    if (isReady) {
      readyRequests.push({ withdrawRequestIndex: i, withdrawRequestID, amountToRedeem, exETHLocked, collateralToken });
    }
  }

  addLog(`Found ${readyRequests.length} Withdrawl Ready To Claims.`, "info");
  if (readyRequests.length === 0) throw new Error("No ready claims");

  const randomRequest = readyRequests[Math.floor(Math.random() * readyRequests.length)];

  const txData = contract.interface.encodeFunctionData('claim', [randomRequest.withdrawRequestIndex, address]);

  const feeParams = await getFeeParams(provider);
  const gasLimit = 650000n;
  const txParams = {
    to: UNSTAKE_CLAIM_CONTRACT_ADDRESS,
    data: txData,
    value: 0n,
    ...feeParams
  };

  const ethBalance = await provider.getBalance(address);
  const gasFee = feeParams.gasPrice || feeParams.maxFeePerGas || ethers.parseUnits("1", "gwei");
  const estimatedGasCost = gasFee * gasLimit;
  if (ethBalance < estimatedGasCost) {
    throw new Error(`Insufficient ETH for gas: ${ethers.formatEther(ethBalance)} < ${ethers.formatEther(estimatedGasCost)}`);
  }

  let tx;
  try {
    const nonce = await getNextNonce(provider, address, chainId);
    tx = await wallet.sendTransaction({ ...txParams, gasLimit, nonce });
    addLog(`Claim Transaction sent: ${getShortHash(tx.hash)}`, "warn");
  } catch (error) {
    addLog(`Transaction failed (send): ${error.message}`, "error");
    if (error.message && error.message.includes("nonce")) {
      const nonceKey = `${chainId}_${address}`;
      delete nonceTracker[nonceKey];
      addLog(`Nonce error detected, resetting nonce for next attempt.`, "warn");
    }
    throw error;
  }
  const timeoutMs = 300000;
  try {
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction confirmation timed out")), timeoutMs));
    const receipt = await Promise.race([tx.wait(), timeoutPromise]);
    if (receipt.status === 0) throw new Error("Transaction reverted");
    addLog(`Claim Successfully, Hash: ${getShortHash(tx.hash)}`, "success");
  } catch (err) {
    addLog(`Transaction failed (confirm): ${err.message}`, "error");
    throw err;
  }
}


async function runDailyActivity() {
  if (accounts.length === 0) {
    addLog("No valid accounts found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Stake: ${dailyActivityConfig.stakeRepetitions}x, Auto Unstake: ${dailyActivityConfig.unstakeRepetitions}x, Auto Claim: ${dailyActivityConfig.claimRepetitions}x`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < accounts.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      const wallet = new ethers.Wallet(accounts[accountIndex].privateKey);
      if (!ethers.isAddress(wallet.address)) {
        addLog(`Invalid wallet address for account ${accountIndex + 1}: ${wallet.address}`, "error");
        continue;
      }
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(wallet.address)}`, "wait");

      const direction = directions[0];
      for (let stakeCount = 0; stakeCount < dailyActivityConfig.stakeRepetitions && !shouldStop; stakeCount++) {
        let amount = (Math.random() * (dailyActivityConfig.ethStakeRange.max - dailyActivityConfig.ethStakeRange.min) + dailyActivityConfig.ethStakeRange.min).toFixed(4);
        addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: ${amount} ETH for eXETH`, "warn");
        try {
          await performStake(wallet, direction, amount, proxyUrl);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Failed: ${error.message}. Skipping to next.`, "error");
        } finally {
          await updateWallets();
        }
        if (stakeCount < dailyActivityConfig.stakeRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next stake...`, "delay");
          await sleep(randomDelay);
        }
      }

      if (dailyActivityConfig.stakeRepetitions > 0 && dailyActivityConfig.unstakeRepetitions > 0 && !shouldStop) {
        const randomDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
        addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before starting unstake...`, "delay");
        await sleep(randomDelay);
      }

      for (let unstakeCount = 0; unstakeCount < dailyActivityConfig.unstakeRepetitions && !shouldStop; unstakeCount++) {
        let amount = (Math.random() * (dailyActivityConfig.exethUnstakeRange.max - dailyActivityConfig.exethUnstakeRange.min) + dailyActivityConfig.exethUnstakeRange.min).toFixed(4);
        addLog(`Account ${accountIndex + 1} - Unstake ${unstakeCount + 1}: ${amount} eXETH for ETH`, "warn");
        try {
          await performUnstake(wallet, direction, amount, proxyUrl);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Unstake ${unstakeCount + 1}: Failed: ${error.message}. Skipping to next.`, "error");
        } finally {
          await updateWallets();
        }
        if (unstakeCount < dailyActivityConfig.unstakeRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next unstake...`, "delay");
          await sleep(randomDelay);
        }
      }

      if (dailyActivityConfig.unstakeRepetitions > 0 && dailyActivityConfig.claimRepetitions > 0 && !shouldStop) {
        const randomDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
        addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before starting claim...`, "delay");
        await sleep(randomDelay);
      }

      for (let claimCount = 0; claimCount < dailyActivityConfig.claimRepetitions && !shouldStop; claimCount++) {
        addLog(`Account ${accountIndex + 1} - Claim ${claimCount + 1}`, "warn");
        try {
          await performClaim(wallet, direction, proxyUrl);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Claim ${claimCount + 1}: Failed: ${error.message}. Skipping to next.`, "error");
        } finally {
          await updateWallets();
        }
        if (claimCount < dailyActivityConfig.claimRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next claim...`, "delay");
          await sleep(randomDelay);
        }
      }

      if (accountIndex < accounts.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog(`All accounts processed. Waiting ${dailyActivityConfig.loopHours} hours for next cycle.`, "success");
      dailyActivityInterval = setTimeout(runDailyActivity, dailyActivityConfig.loopHours * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      if (activeProcesses <= 0) {
        if (dailyActivityInterval) {
          clearTimeout(dailyActivityInterval);
          dailyActivityInterval = null;
          addLog("Cleared daily activity interval.", "info");
        }
        activityRunning = false;
        isCycleRunning = false;
        shouldStop = false;
        hasLoggedSleepInterrupt = false;
        activeProcesses = 0;
        addLog("Daily activity stopped successfully.", "success");
        updateMenu();
        updateStatus();
        safeRender();
      } else {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            if (dailyActivityInterval) {
              clearTimeout(dailyActivityInterval);
              dailyActivityInterval = null;
              addLog("Cleared daily activity interval.", "info");
            }
            activityRunning = false;
            isCycleRunning = false;
            shouldStop = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Daily activity stopped successfully.", "success");
            updateMenu();
            updateStatus();
            safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
            safeRender();
          }
        }, 1000);
      }
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
    nonceTracker = {};
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "EKOX S2 TESTNET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "59%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: isCycleRunning
    ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: [
    "Set Stake Repetitions",
    "Set Unstake Repetitions",
    "Set Claim Repetitions",
    "Set ETH Stake Range",
    "Set eXETH Unstake Range",
    "Set Loop Daily",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max Value:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  statusBox.width = screenWidth - 2;
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = screenWidth - walletBox.width - 2;
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
  }

  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
    const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${accounts.length} | Auto Stake: ${dailyActivityConfig.stakeRepetitions}x | Auto Unstake: ${dailyActivityConfig.unstakeRepetitions}x | Auto Claim: ${dailyActivityConfig.claimRepetitions}x | Loop: ${dailyActivityConfig.loopHours}h | EKOX TESTNET AUTO BOT`;
    statusBox.setContent(statusText);
    if (isProcessing) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header = `${chalk.bold.cyan("  Address").padEnd(20)}               ${chalk.bold.cyan("ETH".padEnd(12))} ${chalk.bold.yellow("eXETH".padEnd(12))}`;
    const separator = chalk.gray("-".repeat(80));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    logBox.scrollTo(transactionLogs.length);
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping daily activity. Please wait for ongoing process to complete.", "info");
      safeRender();
      if (activeProcesses <= 0) {
        activityRunning = false;
        isCycleRunning = false;
        shouldStop = false;
        hasLoggedSleepInterrupt = false;
        addLog("Daily activity stopped successfully.", "success");
        updateMenu();
        updateStatus();
        safeRender();
      } else {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            activityRunning = false;
            isCycleRunning = false;
            shouldStop = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Daily activity stopped successfully.", "success");
            updateMenu();
            updateStatus();
            safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
            safeRender();
          }
        }, 1000);
      }
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Stake Repetitions":
      configForm.configType = "stakeRepetitions";
      configForm.setLabel(" Enter Stake Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.stakeRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set Unstake Repetitions":
      configForm.configType = "unstakeRepetitions";
      configForm.setLabel(" Enter Unstake Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.unstakeRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set Claim Repetitions":
      configForm.configType = "claimRepetitions";
      configForm.setLabel(" Enter Claim Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.claimRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set ETH Stake Range":
      configForm.configType = "ethStakeRange";
      configForm.setLabel(" Enter ETH Stake Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.ethStakeRange.min.toString());
      configInputMax.setValue(dailyActivityConfig.ethStakeRange.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set eXETH Unstake Range":
      configForm.configType = "exethUnstakeRange";
      configForm.setLabel(" Enter eXETH Unstake Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.exethUnstakeRange.min.toString());
      configInputMax.setValue(dailyActivityConfig.exethUnstakeRange.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set Loop Daily":
      configForm.configType = "loopHours";
      configForm.setLabel(" Enter Loop Hours (Min 1 Hours) ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.loopHours.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

let isSubmitting = false;
configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;

  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    if (configForm.configType === "loopHours" || configForm.configType === "stakeRepetitions" || configForm.configType === "unstakeRepetitions" || configForm.configType === "claimRepetitions") {
      value = parseInt(inputValue);
    } else {
      value = parseFloat(inputValue);
    }
    if (["ethStakeRange", "exethUnstakeRange"].includes(configForm.configType)) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max value. Please enter a positive number.", "error");
        configInputMax.clearValue();
        screen.focusPush(configInputMax);
        safeRender();
        isSubmitting = false;
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    if (configForm.configType === "loopHours" && value < 1) {
      addLog("Invalid input. Minimum is 1 hour.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.clearValue();
    screen.focusPush(configInput);
    safeRender();
    isSubmitting = false;
    return;
  }

  if (configForm.configType === "stakeRepetitions") {
    dailyActivityConfig.stakeRepetitions = Math.floor(value);
    addLog(`Stake Repetitions set to ${dailyActivityConfig.stakeRepetitions}`, "success");
  } else if (configForm.configType === "unstakeRepetitions") {
    dailyActivityConfig.unstakeRepetitions = Math.floor(value);
    addLog(`Unstake Repetitions set to ${dailyActivityConfig.unstakeRepetitions}`, "success");
  } else if (configForm.configType === "claimRepetitions") {
    dailyActivityConfig.claimRepetitions = Math.floor(value);
    addLog(`Claim Repetitions set to ${dailyActivityConfig.claimRepetitions}`, "success");
  } else if (configForm.configType === "ethStakeRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.ethStakeRange.min = value;
    dailyActivityConfig.ethStakeRange.max = maxValue;
    addLog(`ETH Stake Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "exethUnstakeRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.exethUnstakeRange.min = value;
    dailyActivityConfig.exethUnstakeRange.max = maxValue;
    addLog(`eXETH Unstake Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "loopHours") {
    dailyActivityConfig.loopHours = value;
    addLog(`Loop Daily set to ${value} hours`, "success");
  }
  saveConfig();
  updateStatus();

  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
    isSubmitting = false;
  }, 100);
});

configInput.key(["enter"], () => {
  if (["ethStakeRange", "exethUnstakeRange"].includes(configForm.configType)) {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
  }
});

configInputMax.key(["enter"], () => {
  configForm.submit();
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  screen.focusPush(configSubmitButton);
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadAccounts();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);


initialize();
