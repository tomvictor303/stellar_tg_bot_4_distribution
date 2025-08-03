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

// Asset setup (use XLM by default)
const ASSET_CODE = process.env.STELLAR_ASSET_CODE || "XLM";
const ASSET_ISSUER = process.env.STELLAR_ASSET_ISSUER || null;
const AMOUNT = process.env.STELLAR_SEND_AMOUNT || "1"; // Default 1 XLM or 1 unit of asset

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
    await ctx.reply("⏳ Creating your claimable balance. Please wait...");
    try {
        // Load sender account
        const account = await server.loadAccount(SENDER_PUBLIC);
        // Asset
        const asset = (ASSET_CODE === "XLM")
            ? Asset.native()
            : new Asset(ASSET_CODE, ASSET_ISSUER!);
        // Claimant
        const claimant = new Claimant(address);
        // Build transaction
        const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: Networks.PUBLIC,
        })
            .addOperation(Operation.createClaimableBalance({
                asset,
                amount: AMOUNT,
                claimants: [claimant],
            }))
            .setTimeout(180)
            .build();
        // Sign and submit
        tx.sign(SENDER_KEYPAIR);
        const result = await server.submitTransaction(tx);
        await ctx.reply(
            `✅ Claimable balance sent!\n\nTransaction: https://stellar.expert/explorer/public/tx/${result.hash}`
        );
    } catch (error: any) {
        console.error("Stellar error:", error);
        await ctx.reply(
            `❌ Failed to send claimable balance. Reason: ${error?.response?.data?.extras?.result_codes?.operations || error.message}`
        );
    }
});

bot.catch((err) => {
    console.error("Error in bot:", err);
});

bot.start();
