import { Bot } from "grammy";
import dotenv from "dotenv";
import Server, { Keypair, Asset, Networks, TransactionBuilder, Operation, Claimant, BASE_FEE } from "stellar-sdk";

dotenv.config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// Stellar setup
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";
const server = new Server(HORIZON_URL);
const SENDER_SECRET = process.env.STELLAR_SENDER_SECRET!;
const SENDER_KEYPAIR = Keypair.fromSecret(SENDER_SECRET);
const SENDER_PUBLIC = SENDER_KEYPAIR.publicKey();

// Example asset list (replace with your actual assets)
type AssetToSend = { code: string; issuer: string | null; amount: string };
const ASSETS_TO_SEND: AssetToSend[] = [
    // { code: "XLM", issuer: null, amount: "1" },
    // { code: "USDC", issuer: "G...ISSUER1", amount: "2" },
    // ... up to 100 per transaction
];

function isValidStellarAddress(address: string): boolean {
    return /^G[A-Z2-7]{55}$/.test(address);
}

bot.command("start", async (ctx) => {
    await ctx.reply(
        "👋 Welcome! Send me your Stellar wallet address to receive a claimable balance."
    );
});

bot.on("message:text", async (ctx) => {
    const address = ctx.message.text.trim();
    if (!isValidStellarAddress(address)) {
        await ctx.reply("❌ That doesn't look like a valid Stellar address. Please send a valid address starting with 'G'.");
        return;
    }
    if (!ASSETS_TO_SEND.length) {
        await ctx.reply("⚠️ No assets configured to send. Please update ASSETS_TO_SEND array in the code.");
        return;
    }
    await ctx.reply("⏳ Creating your claimable balances. Please wait...");
    try {
        const account = await server.loadAccount(SENDER_PUBLIC);
        const claimant = new Claimant(address);
        // Split assets into chunks of 100 (Stellar's max operations per tx)
        const chunkSize = 100;
        const assetChunks = [];
        for (let i = 0; i < ASSETS_TO_SEND.length; i += chunkSize) {
            assetChunks.push(ASSETS_TO_SEND.slice(i, i + chunkSize));
        }
        let txHashes: string[] = [];
        for (const chunk of assetChunks) {
            let txBuilder = new TransactionBuilder(account, {
                fee: BASE_FEE,
                networkPassphrase: Networks.PUBLIC,
            });
            for (const assetInfo of chunk) {
                const asset = assetInfo.code === "XLM"
                    ? Asset.native()
                    : new Asset(assetInfo.code, assetInfo.issuer ?? undefined);
                txBuilder = txBuilder.addOperation(Operation.createClaimableBalance({
                    asset,
                    amount: assetInfo.amount,
                    claimants: [claimant],
                }));
            }
            const tx = txBuilder.setTimeout(180).build();
            tx.sign(SENDER_KEYPAIR);
            const result = await server.submitTransaction(tx);
            txHashes.push(result.hash);
        }
        await ctx.reply(
            `✅ Claimable balances sent!\n\nTransactions:\n${txHashes.map(h => `https://stellar.expert/explorer/public/tx/${h}`).join("\n")}`
        );
    } catch (error: any) {
        console.error("Stellar error:", error);
        await ctx.reply(
            `❌ Failed to send claimable balances. Reason: ${error?.response?.data?.extras?.result_codes?.operations || error.message}`
        );
    }
});

bot.catch((err) => {
    console.error("Error in bot:", err);
});

bot.start();
