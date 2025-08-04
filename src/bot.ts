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
        return rows.map(row => ({
            code: String(row.code).trim(),
            issuer: row.issuer ? String(row.issuer).trim() : null,
            amount: String(row.amount).trim(),
        })).filter(asset => asset.code && asset.amount);
    } catch (err) {
        console.error("Failed to load assets from Excel:", err);
        return [];
    }
}

const ASSETS_TO_SEND: AssetToSend[] = loadAssetsFromExcel(path.join(__dirname, "../database.xlsx"));

function isValidStellarAddress(address: string): boolean {
    return /^G[A-Z2-7]{55}$/.test(address);
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
                    await logMessage(ctx, `Transaction failed: ${safeText(e)}`);
                    return [];
                }
            }
        }
        await logMessage(ctx, `Transaction failed: ${safeText(e)}`);
        return [];
    }
}

bot.on("message:text", async (ctx) => {
    const address = ctx.message.text.trim();
    if (!isValidStellarAddress(address)) {
        await ctx.reply("❌ That doesn't look like a valid Stellar address. Please send a valid address starting with 'G'.");
        return;
    }
    if (!ASSETS_TO_SEND.length) {
        await ctx.reply("⚠️ No assets configured to send. Please check 'database.xlsx'.");
        return;
    }
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
            await logMessage(ctx, `✅ Claimable balances sent!\n\nTransactions:\n${txHashes.map(h => `https://stellar.expert/explorer/public/tx/${h}`).join("\n")}`);
        }
    } catch (error: any) {
        console.error("Stellar error:", error);
        await logMessage(ctx, `❌ Failed to send claimable balances. Reason: ${safeText(error?.message)}`);
    }
});

bot.catch((err) => {
    console.error("Error in bot:", err);
});

bot.start();
