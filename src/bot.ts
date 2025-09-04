import { Bot, InlineKeyboard } from "grammy";
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

// Main asset configuration from environment
const MAIN_ASSET_CODE = process.env.MAIN_ASSET_CODE ? String(process.env.MAIN_ASSET_CODE).replace(/\s+/g, "") : undefined;
const MAIN_ASSET_ISSUER_RAW = process.env.MAIN_ASSET_ISSUER ? String(process.env.MAIN_ASSET_ISSUER) : undefined;
const MAIN_ASSET_ISSUER = MAIN_ASSET_ISSUER_RAW ? MAIN_ASSET_ISSUER_RAW.replace(/\s+/g, "") : undefined;
const MAIN_ASSET_AMOUNT = process.env.MAIN_ASSET_AMOUNT ? String(process.env.MAIN_ASSET_AMOUNT).trim() : undefined;

function getMainAsset(): AssetToSend | null {
    if (!MAIN_ASSET_CODE || !MAIN_ASSET_AMOUNT) return null;
    const issuer = MAIN_ASSET_ISSUER ?? null;
    const isNative = MAIN_ASSET_CODE.toUpperCase() === "XLM" && (issuer?.toLowerCase() === "native");
    if (!isNative) {
        if (!issuer || !isValidStellarAddress(issuer)) return null;
    }
    return { code: MAIN_ASSET_CODE, issuer, amount: MAIN_ASSET_AMOUNT };
}

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
            const isNative = asset.code.toUpperCase() === "XLM" && (asset.issuer?.toLowerCase() === "native");
            if (isNative) return true; // native asset is valid
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

const ALT_ASSETS: AssetToSend[] = loadAssetsFromExcel(path.join(__dirname, "../database.xlsx"));

if (!ALT_ASSETS?.length) {
    console.error("❌ No valid assets found in database.xlsx. Please check the file and try again.");
    process.exit(1);
}

function isValidStellarAddress(address: string): boolean {
    return /^G[A-Z2-7]{55}$/.test(address);
}

// Check once at startup that the distributor account has trustlines for all non-native assets
async function checkAssetsTrustline(): Promise<void> {
    const mainAsset = getMainAsset();
    const allAssets = mainAsset ? [mainAsset, ...ALT_ASSETS] : ALT_ASSETS;
    
    const account = await server.loadAccount(SENDER_PUBLIC);
    const balances = account.balances || [];
    // Build a set of unique asset identifiers to check (code:issuer)
    const toCheck = new Map<string, { code: string; issuer: string }>();
    for (const a of allAssets) {
        const isNative = a.code.toUpperCase() === "XLM" && (a.issuer?.toLowerCase() === "native");
        if (isNative) continue; // native asset does not require trustline
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
        console.log("")
        for (const m of missing) {
            console.error(` - ${m.code}:${m.issuer}`);
        }
        console.log("")
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

// Simple in-memory state to remember a user's last provided address
const userLastAddress: Record<number, string> = {};

bot.command("start", async (ctx) => {
    await ctx.reply("👋 Welcome! Send me your Stellar wallet address to continue.");
});

bot.on("callback_query:data", async (ctx) => {
    const action = ctx.callbackQuery.data;
    const userId = ctx.from?.id;
    const address = userId ? userLastAddress[userId] : undefined;
    const mainAsset = getMainAsset();
    const now = Date.now();
    if (userId && address) {
        const cooldown = userCooldowns[userId];
        if (cooldown && cooldown.lastAddress === address && now - cooldown.lastTime < COOLDOWN_MS) {
            await ctx.answerCallbackQuery();
            await ctx.reply("⏳ Please wait 1 minute before requesting again with the same address.");
            return;
        }
    }
    if (!address) {
        await ctx.answerCallbackQuery();
        await ctx.reply("Please send your Stellar address first.");
        return;
    }
    if (action === "send_main") {
        if (!mainAsset) {
            await ctx.answerCallbackQuery();
            await ctx.reply("Main asset is not configured. Please contact the admin.");
            return;
        }
        await ctx.answerCallbackQuery();
        const hashes = await sendAssetsToAddress(address, [mainAsset], ctx);
        if (hashes.length) {
            if (userId) {
                userCooldowns[userId] = { lastTime: Date.now(), lastAddress: address };
            }
            await ctx.reply(`✅ Main asset claimable balance sent!\n\nTransactions:\n${hashes.map(h => `https://stellar.expert/explorer/public/tx/${h}`).join("\n")}`);
            // Offer to send all others
            const others = ALT_ASSETS.filter(a => !(a.code === mainAsset.code && a.issuer === mainAsset.issuer));
            if (others.length) {
                const kb = new InlineKeyboard().text("Send all other assets", "send_others");
                await ctx.reply("Would you like to receive all other assets as well?", { reply_markup: kb });
            }
        }
        return;
    }
    if (action === "send_others") {
        await ctx.answerCallbackQuery();
        if (!mainAsset) {
            // If main asset isn't configured, just send all assets
            const hashes = await sendAssetsToAddress(address, ALT_ASSETS, ctx);
            if (hashes.length) {
                if (userId) {
                    userCooldowns[userId] = { lastTime: Date.now(), lastAddress: address };
                }
                await ctx.reply(`✅ Claimable balances sent!\n\nTransactions:\n${hashes.map(h => `https://stellar.expert/explorer/public/tx/${h}`).join("\n")}`);
            }
            return;
        }
        const others = ALT_ASSETS.filter(a => !(a.code === mainAsset.code && a.issuer === mainAsset.issuer));
        const hashes = await sendAssetsToAddress(address, others, ctx);
        if (hashes.length) {
            if (userId) {
                userCooldowns[userId] = { lastTime: Date.now(), lastAddress: address };
            }
            await ctx.reply(`✅ Other assets claimable balances sent!\n\nTransactions:\n${hashes.map(h => `https://stellar.expert/explorer/public/tx/${h}`).join("\n")}`);
        }
        return;
    }
    if (action === "send_all") {
        await ctx.answerCallbackQuery();
        const hashes = await sendAssetsToAddress(address, ALT_ASSETS, ctx);
        if (hashes.length) {
            if (userId) {
                userCooldowns[userId] = { lastTime: Date.now(), lastAddress: address };
            }
            await ctx.reply(`✅ Claimable balances sent!\n\nTransactions:\n${hashes.map(h => `https://stellar.expert/explorer/public/tx/${h}`).join("\n")}`);
        }
        return;
    }
    await ctx.answerCallbackQuery();
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

function buildOperationsForAssets(assets: AssetToSend[], claimant: Claimant) {
    return assets.map(assetInfo => {
        const isNative = assetInfo.code.toUpperCase() === "XLM" && (assetInfo.issuer?.toLowerCase() === "native");
        const asset = isNative
            ? Asset.native()
            : new Asset(assetInfo.code, assetInfo.issuer ?? undefined);
        return Operation.createClaimableBalance({
            asset,
            amount: assetInfo.amount,
            claimants: [claimant],
        });
    });
}

async function sendAssetsToAddress(address: string, assets: AssetToSend[], ctx: any): Promise<string[]> {
    if (!assets.length) return [];
    await ctx.reply("⏳ Creating your claimable balances. Please wait...");
    const claimant = new Claimant(address);
    const chunkSize = 100;
    const assetChunks: AssetToSend[][] = [];
    for (let i = 0; i < assets.length; i += chunkSize) {
        assetChunks.push(assets.slice(i, i + chunkSize));
    }
    let txHashes: string[] = [];
    for (const chunk of assetChunks) {
        const operations = buildOperationsForAssets(chunk, claimant);
        const hashes = await sendTransactions(operations, ctx, address);
        txHashes = txHashes.concat(hashes);
    }
    return txHashes;
}

bot.on("message:text", async (ctx) => {
    const address = ctx.message.text.trim();
    const userId = ctx.from?.id;
    const now = Date.now();
    if (!isValidStellarAddress(address)) {
        await ctx.reply("❌ That doesn't look like a valid Stellar address. Please send a valid address starting with 'G'.");
        return;
    }
    if (userId) {
        userLastAddress[userId] = address;
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
    if (!ALT_ASSETS.length) {
        await ctx.reply("⚠️ No assets configured to send. Please tell the admin to check 'database.xlsx'.");
        return;
    }
    // Ask what to send now that we have a valid address
    const mainAsset = getMainAsset();
    const keyboard = new InlineKeyboard();
    if (mainAsset) {
        keyboard.text(`Send only ${mainAsset.code}`, "send_main").row();
    }
    keyboard.text("Send all assets", "send_all");
    await ctx.reply("✅ Address received. What would you like to claim?", { reply_markup: keyboard });
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
