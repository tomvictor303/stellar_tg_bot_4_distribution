import { Bot } from "grammy";
import dotenv from "dotenv";
import { Horizon, Keypair, Asset, Networks, TransactionBuilder, Operation, Claimant, BASE_FEE } from "stellar-sdk";
import xlsx from "xlsx";
import path from "path";
import util from "util";
const sleep = util.promisify(setTimeout);

dotenv.config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// Stellar setup
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";
const SENDER_SECRET = process.env.STELLAR_SENDER_SECRET!;
const server = new Horizon.Server(HORIZON_URL);
const SENDER_KEYPAIR = Keypair.fromSecret(SENDER_SECRET);
const SENDER_PUBLIC = SENDER_KEYPAIR.publicKey();

type AssetToSend = { code: string; issuer: string | null; amount: string };

function loadAssetsFromExcel(filePath: string): AssetToSend[] {
    try {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows: any[] = xlsx.utils.sheet_to_json(sheet, { defval: "" });
        return rows.map(row => {
            const code = String(row.code ?? "").replace(/\s+/g, "");
            const issuerRaw = row.issuer != null ? String(row.issuer) : "";
            const issuerStripped = issuerRaw.replace(/\s+/g, "");
            const issuer = issuerStripped ? issuerStripped : null;
            const amount = String(row.amount ?? "0.1").trim();
            return { code, issuer, amount };
        }).filter(asset => {
			// Now, we need to check if the asset is valid
            if (!asset.code || !asset.amount) return false;
            if (asset.issuer && !isValidStellarAddress(asset.issuer)) return false;
            return true;
        });
    } catch (err) {
        console.error("❌ Failed to load assets from Excel:", err);
        return [];
    }
}

const ASSETS_TO_SEND: AssetToSend[] = loadAssetsFromExcel(path.join(__dirname, "../database.xlsx"));

if (!ASSETS_TO_SEND?.length) {
    console.error("❌ No valid assets found in database.xlsx. Please check the file and try again.");
    process.exit(1);
}

function isValidStellarAddress(address: string): boolean {
    return /^G[A-Z2-7]{55}$/.test(address);
}

// Check once at startup that the distributor account has trustlines for all non-native assets
async function checkAssetsTrustline(): Promise<void> {
    const account = await server.loadAccount(SENDER_PUBLIC);
    const balances = account.balances || [];
    // Build a set of unique asset identifiers to check (code:issuer)
    const toCheck = new Map<string, { code: string; issuer: string }>();
    for (const a of ASSETS_TO_SEND) {
        if (a.code === "XLM") continue; // native asset does not require trustline
        if (!a.issuer) continue; // skip if issuer missing (invalid input would have been filtered earlier)
        const key = `${a.code}:${a.issuer}`;
        if (!toCheck.has(key)) toCheck.set(key, { code: a.code, issuer: a.issuer });
    }
    const missing: { code: string; issuer: string }[] = [];
    for (const { code, issuer } of toCheck.values()) {
        const found = balances.some((b: any) => b.asset_code === code && b.asset_issuer === issuer);
        if (!found) missing.push({ code, issuer });
    }
    if (missing.length > 0) {
        console.error("❌ Distributor account is missing trustlines for the following assets:");
        for (const m of missing) {
            console.error(` - ${m.code}:${m.issuer}`);
        }
        console.error("Please add these trustlines to the distributor account and restart.");
        console.error("If you already have the trustlines, please check if the balances are correct in the distributor account.");
        process.exit(1);
    } else {
        console.log("✅ Distributor account has trustlines for all required assets.");
    }
}

function safeText(e: any): string {
    const secret = process.env.STELLAR_SENDER_SECRET;
    let text = typeof e === 'string' ? e : (e?.message || JSON.stringify(e));
    if (secret) {
        text = text.split(secret).join('[SECRET]');
    }
    return text;
}

async function logMessage(ctx: any, message: string) {
  console.log(message);
  // Optionally, you can also reply to the user here:
  if (ctx?.reply) {
	await ctx.reply(message);
  }
}

// Cooldown map: userId -> { lastTime: number, lastAddress: string }
const userCooldowns: Record<number, { lastTime: number, lastAddress: string }> = {};
const COOLDOWN_MS = 60 * 1000; // 1 minute cooldown

bot.command("start", async (ctx) => {
    await ctx.reply("👋 Welcome! Send me your Stellar wallet address to receive claimable balances for multiple assets.");
});

async function sendTransactions(operations: any[], ctx: any, target_address: string, retryCount = 0, maxRetries = 5): Promise<string[]> {
    if (operations.length === 0) return [];
    if (retryCount >= maxRetries) {
        await ctx.reply("❌ Max retries reached. Aborting transaction.");
        return [];
    }
    try {
        const account = await server.loadAccount(SENDER_PUBLIC);
        let txBuilder = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: Networks.PUBLIC,
        });
        for (const op of operations) {
            txBuilder = txBuilder.addOperation(op);
        }
        const tx = txBuilder.setTimeout(180).build();
        tx.sign(SENDER_KEYPAIR);
        const result = await server.submitTransaction(tx);
        return [result.hash];
    } catch (e: any) {
        // Network error: 504 Gateway Timeout
        if (e.status === 504) {
            await ctx.reply("504 Gateway Timeout. Retrying...");
            await sleep(5000);
            return sendTransactions(operations, ctx, target_address, retryCount + 1, maxRetries);
        }
        // Transaction result codes
        const extras = e?.response?.data?.extras;
        const resultCodes = extras?.result_codes;
        if (resultCodes) {
            // Bad sequence number
            if (resultCodes.transaction === "tx_bad_seq") {
                await ctx.reply("Bad sequence number. Retrying...");
                await sleep(1000);
                return sendTransactions(operations, ctx, target_address, retryCount + 1, maxRetries);
            }
            // Transaction too late
            if (resultCodes.transaction === "tx_too_late") {
                await ctx.reply("Transaction timeout. Retrying...");
                await sleep(1000);
                return sendTransactions(operations, ctx, target_address, retryCount + 1, maxRetries);
            }
            // Insufficient fee
            if (resultCodes.transaction === "tx_insufficient_fee") {
                await ctx.reply("Gas fee is too high now. Retrying after 5 seconds...");
                await sleep(5000);
                return sendTransactions(operations, ctx, target_address, retryCount + 1, maxRetries);
            }
            // Transaction failed with operation errors
            if (resultCodes.transaction === "tx_failed" && Array.isArray(resultCodes.operations) && resultCodes.operations.length > 0) {
                const ops = resultCodes.operations;
                // Remove all op_no_trust operations and retry the rest
                if (ops.includes("op_no_trust")) {
                    const indexes = ops.map((v: string, i: number) => v === "op_no_trust" ? i : -1).filter((i: number) => i !== -1);
                    for (const index of indexes.sort((a: number, b: number) => b - a)) {
                        operations.splice(index, 1);
                    }
                    if (operations.length > 0) {
                        await ctx.reply("Your wallet has not set a trustline. Retrying remaining operations...");
                        return sendTransactions(operations, ctx, target_address, retryCount + 1, maxRetries);
                    } else {
                        await ctx.reply("Transaction failed: Your wallet did not set trustline with asset.");
                        return [];
                    }
                } else if (ops.includes("op_underfunded")) {
                    await logMessage(ctx, "Transaction failed: Asset amount is insufficient in distribution account.");
                    return [];
                } else {
                    await logMessage(ctx, `Transaction failed. Target address: ${target_address}. Reason: ${safeText(e)}`);
                    return [];
                }
            }
        }
        await logMessage(ctx, `Transaction failed. Target address: ${target_address}. Reason: ${safeText(e)}`);
        return [];
    }
}

bot.on("message:text", async (ctx) => {
    const address = ctx.message.text.trim();
    const userId = ctx.from?.id;
    const now = Date.now();
    if (!isValidStellarAddress(address)) {
        await ctx.reply("❌ That doesn't look like a valid Stellar address. Please send a valid address starting with 'G'.");
        return;
    }
    // BEGIN: check_user_same_wallet_cooldown
    if (userId) {
        const cooldown = userCooldowns[userId];
        if (
            cooldown &&
            cooldown.lastAddress === address &&
            now - cooldown.lastTime < COOLDOWN_MS
        ) {
            await ctx.reply("⏳ Please wait 1 minute before requesting again with the same address.");
            return;
        }
    }
    // END: check_user_same_wallet_cooldown
    if (!ASSETS_TO_SEND.length) {
        await ctx.reply("⚠️ No assets configured to send. Please tell the admin to check 'database.xlsx'.");
        return;
    }
    // BEGIN: send_claimable_balances
    await ctx.reply("⏳ Creating your claimable balances. Please wait...");
    try {
        const claimant = new Claimant(address);
        // Split assets into chunks of 100 (Stellar's max operations per tx)
        const chunkSize = 100;
        const assetChunks = [];
        for (let i = 0; i < ASSETS_TO_SEND.length; i += chunkSize) {
            assetChunks.push(ASSETS_TO_SEND.slice(i, i + chunkSize));
        }
        let txHashes: string[] = [];
        for (const chunk of assetChunks) {
            const operations = chunk.map(assetInfo => {
                const asset = assetInfo.code === "XLM"
                    ? Asset.native()
                    : new Asset(assetInfo.code, assetInfo.issuer ?? undefined);
                return Operation.createClaimableBalance({
                    asset,
                    amount: assetInfo.amount,
                    claimants: [claimant],
                });
            });
            const hashes = await sendTransactions(operations, ctx, address);
            txHashes = txHashes.concat(hashes);
        }
        if (txHashes.length > 0) {
            if (userId) {
                userCooldowns[userId] = { lastTime: Date.now(), lastAddress: address };
            }
            await logMessage(ctx, `✅ Claimable balances sent!\n\nTransactions:\n${txHashes.map(h => `https://stellar.expert/explorer/public/tx/${h}`).join("\n")}`);
        }
    } catch (error: any) {
        console.error("Stellar error:", error);
        await logMessage(ctx, `❌ Failed to send claimable balances. Target address: ${address}. Reason: ${safeText(error?.message)}`);
    }
    // END: send_claimable_balances
});

bot.catch((err) => {
    console.error("Error in bot:", err);
});

(async function bootstrap() {
    try {
        console.log("⏳ Please wait while we check if the distributor account has trustlines for all assets in database.xlsx...");
        await checkAssetsTrustline(); // one-time startup check
        bot.start();
    } catch (err) {
        console.error("Startup error:", err);
        process.exit(1);
    }
})();
