/**
 * CPUNKS Auto-Minter v1.2
 * - Multi-wallet PARALLEL hunting
 * - Auto rate-limit handling
 * - Telegram notifications
 * - Auto gas bump
 */

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const CONFIG = {
  CONTRACT:     "0x9E464d954E07abeD84081F399feE729FF99f8f93",
  RPC_URL:      process.env.RPC_URL || "https://eth.llamarpc.com",
  API:          "https://unixpunks.xyz/api",
  MAX_MINTS:    10,
  GAS_LIMIT:    300000,
  MAX_GWEI:     50,
  GAS_BUMP_PCT: 120,
  GAS_BUMP_MS:  30000,
  LOG_FILE:     "cpunks.log",
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || "",
  TG_CHAT_ID:   process.env.TG_CHAT_ID   || "",
  PRIVATE_KEYS: (process.env.PRIVATE_KEYS || process.env.PRIVATE_KEY || "")
    .split(",").map(k => k.trim()).filter(Boolean),
};

const ABI = ["function mint(bytes32 mintCode, bytes signature) payable"];

function log(msg) {
  const ts = new Date().toLocaleTimeString("id-ID");
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(CONFIG.LOG_FILE, line + "\n");
}

async function notify(msg) {
  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: msg }),
    });
  } catch (_) {}
}

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
      return await r.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function getSchedule() {
  return fetchWithRetry(`${CONFIG.API}/schedule`);
}

async function mintNFT(signer, provider, mintCode, signature, priceWei, retries = 0) {
  if (retries >= 5) { log("❌ Max retries reached"); return false; }

  const feeData = await provider.getFeeData();
  const gwei = Number(ethers.formatUnits(feeData.gasPrice, "gwei"));

  if (gwei > CONFIG.MAX_GWEI) {
    log(`⛽ Gas ${gwei.toFixed(1)} gwei terlalu tinggi, tunggu 15s...`);
    await new Promise(r => setTimeout(r, 15000));
    return mintNFT(signer, provider, mintCode, signature, priceWei, retries + 1);
  }

  try {
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABI, signer);
    log(`📡 [${signer.address.slice(0,8)}] Minting — gas: ${gwei.toFixed(1)} gwei | price: ${ethers.formatEther(BigInt(priceWei))} ETH`);

    const tx = await contract.mint(mintCode, signature, {
      value: BigInt(priceWei),
      gasLimit: CONFIG.GAS_LIMIT,
      gasPrice: feeData.gasPrice,
    });

    log(`📨 TX: ${tx.hash}`);
    log(`🔗 https://etherscan.io/tx/${tx.hash}`);

    const receipt = await Promise.race([
      tx.wait(),
      new Promise(async (_, reject) => {
        await new Promise(r => setTimeout(r, CONFIG.GAS_BUMP_MS));
        reject(new Error("TX_SLOW"));
      }),
    ]).catch(async (e) => {
      if (e.message === "TX_SLOW") {
        log(`⏱️  TX lambat, bump gas...`);
        const bumpedGas = feeData.gasPrice * BigInt(CONFIG.GAS_BUMP_PCT) / 100n;
        const newTx = await contract.mint(mintCode, signature, {
          value: BigInt(priceWei),
          gasLimit: CONFIG.GAS_LIMIT,
          gasPrice: bumpedGas,
          nonce: tx.nonce,
        });
        log(`📨 Bumped TX: ${newTx.hash}`);
        return await newTx.wait();
      }
      throw e;
    });

    if (receipt && receipt.status === 1) {
      return { success: true, block: receipt.blockNumber, txHash: tx.hash };
    } else {
      log("❌ TX reverted");
      return false;
    }
  } catch (e) {
    const msg = e.shortMessage || e.message || "";
    if (msg.includes("MaxPerWalletReached")) return "max_reached";
    if (msg.includes("insufficient funds")) return "insufficient_funds";
    if (msg.includes("MintCodeAlreadyUsed") || msg.includes("InvalidSignature")) {
      log("⚠️  Code unusable (race lost)"); return false;
    }
    log(`⚠️  Error (attempt ${retries + 1}): ${msg.slice(0, 100)}`);
    await new Promise(r => setTimeout(r, 3000));
    return mintNFT(signer, provider, mintCode, signature, priceWei, retries + 1);
  }
}

// Hunt + mint loop for a single wallet
async function runWallet(wallet, provider, walletIndex) {
  const addr = wallet.address;
  const tag  = `[W${walletIndex + 1}:${addr.slice(0, 8)}]`;
  const tried = new Set();
  let mintCount = 0;
  const stats = { minted: 0, failed: 0 };

  log(`${tag} 🚀 Started`);

  while (mintCount < CONFIG.MAX_MINTS) {
    // Wait for active batch
    let activeBatch = null, rangeStart, rangeEnd;
    while (!activeBatch) {
      try {
        const sched = await getSchedule();
        activeBatch = sched.activeBatch;
        if (activeBatch) {
          const win = sched.windows.find(w => w.batch === activeBatch);
          if (win.soldOut) {
            log(`${tag} Batch ${activeBatch} sold out — waiting...`);
            activeBatch = null;
            await new Promise(r => setTimeout(r, 10000));
            continue;
          }
          rangeStart = win.tsRangeStart;
          rangeEnd   = win.tsRangeEnd;
          log(`${tag} ✅ Batch ${activeBatch} | Range: ${rangeStart}–${rangeEnd}`);
        } else {
          await new Promise(r => setTimeout(r, 8000));
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    const rangeSize = rangeEnd - rangeStart + 1;
    let found = false;
    let attempts = 0;

    while (!found) {
      attempts++;

      if (attempts % 20 === 0) {
        try {
          const sched = await getSchedule();
          if (sched.activeBatch !== activeBatch) {
            log(`${tag} Batch closed — next`);
            tried.clear();
            break;
          }
        } catch (_) {}
      }

      let ts, tries = 0;
      do { ts = Math.floor(Math.random() * rangeSize) + rangeStart; tries++; }
      while (tried.has(ts) && tries < 100);
      tried.add(ts);
      process.stdout.write(`\r${tag} scanning ts=${ts} | tried: ${tried.size} | minted: ${mintCount}/${CONFIG.MAX_MINTS}   `);

      try {
        const resp = await fetchWithRetry(`${CONFIG.API}/find-mint-code`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ timestamp: ts, wallet: addr.toLowerCase() }),
        });

        if (resp.ok && resp.mintCode) {
          console.log("");
          log(`${tag} 🎯 HIT! ts=${ts}`);

          const signed = await fetchWithRetry(`${CONFIG.API}/sign-mint-code`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mintCode: resp.mintCode, wallet: addr.toLowerCase() }),
          });

          if (!signed.ok) { log(`${tag} ❌ Sign failed`); continue; }

          const result = await mintNFT(wallet, provider, resp.mintCode, signed.signature, signed.priceWei);

          if (result === "max_reached") { mintCount = CONFIG.MAX_MINTS; found = true; break; }
          if (result === "insufficient_funds") { log(`${tag} 💸 Insufficient ETH!`); return; }
          if (result && result.success) {
            mintCount++;
            stats.minted++;
            found = true;
            log(`${tag} ✅ MINTED #${mintCount}/${CONFIG.MAX_MINTS} | Block: ${result.block}`);
            await notify(`🎉 CPUNKS Minted!\n${addr}\n#${mintCount}/${CONFIG.MAX_MINTS}\nhttps://etherscan.io/tx/${result.txHash}`);
          } else {
            stats.failed++;
          }
        } else {
          const err = resp.error || "";
          if (err === "rate_limit" || err === "rate_limit_wallet") {
            const wait = (resp.retryInMs || 11000) + 1000;
            await new Promise(r => setTimeout(r, wait));
          } else if (err === "no_active_batch") {
            log(`${tag} Batch ended`); break;
          } else {
            await new Promise(r => setTimeout(r, 300));
          }
        }
      } catch (_) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  log(`${tag} 🏁 Done — minted: ${stats.minted}`);
  return stats;
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║        CPUNKS Auto-Minter v1.2               ║");
  console.log(`║        Wallets: ${String(CONFIG.PRIVATE_KEYS.length).padEnd(2)} | PARALLEL mode          ║`);
  console.log("╚══════════════════════════════════════════════╝\n");

  if (CONFIG.PRIVATE_KEYS.length === 0) {
    console.error("❌ Isi PRIVATE_KEY atau PRIVATE_KEYS di file .env!");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);

  try {
    const block = await provider.getBlockNumber();
    log(`✅ Connected — block #${block}`);
  } catch (e) {
    log(`❌ RPC error: ${e.message}`); process.exit(1);
  }

  const wallets = CONFIG.PRIVATE_KEYS.map(pk => new ethers.Wallet(pk, provider));

  for (let i = 0; i < wallets.length; i++) {
    const bal = await provider.getBalance(wallets[i].address);
    log(`👛 W${i+1}: ${wallets[i].address} | ${ethers.formatEther(bal)} ETH`);
  }

  console.log("");
  log(`🚀 Running ${wallets.length} wallets in parallel...\n`);

  // Run all wallets in parallel
  const results = await Promise.all(
    wallets.map((w, i) => runWallet(w, provider, i))
  );

  const total = results.reduce((sum, r) => sum + (r?.minted || 0), 0);
  log(`\n🏁 All done! Total minted: ${total}`);
  await notify(`🏁 CPUNKS All Done!\nTotal minted: ${total}`);
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});
