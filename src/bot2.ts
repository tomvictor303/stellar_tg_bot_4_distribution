import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";

dotenv.config();

// Replace with your bot token from BotFather
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

const mainMessage = `
👋 Welcome to the TON Attack Card Game! 🎮

Get ready to play, collect, and battle in this thrilling card game powered by the TON blockchain! 💎

🃏 Here’s how to get started:

🎴 Collect powerful attack cards.
🥇 Battle other players.
💰 Win exciting rewards!
👉 Tap Start Game to begin your adventure. Earn rewards and prove your skills as the ultimate TON Attack Card Game champion!
`;

const openWebAppInlineKeyboard = new InlineKeyboard()
	.webApp("Start App", "https://mini-app-ui.vercel.app/")
	.row()
	.url("Join Community", "https://t.me/OfficialTonAttack");

// Handle the "/start" command
bot.command('start', async (ctx) => {
	const user = ctx.from;
	if (!user) return ctx.reply("Failed to get user data.");

	try {
		await ctx.api.sendChatAction(ctx.chat.id, "typing");
	} catch (error) {
		console.error("Error send chat action :", error);
	}

	// try {
	// // const ref_id = ctx.match?.split("ref_")[1] || null;
	// await initPlayer(user);
	// } catch (error) {
	// console.error("Error initializing player:", error);
	// }


	await ctx.replyWithPhoto("https://www.imghost.net/ib/susqZlHG4c3v6H2_1727291502.jpg", {
		caption: mainMessage,
		reply_markup: openWebAppInlineKeyboard,
		parse_mode: "HTML",
	});
});

bot.catch((err) => {
	console.error("Error in bot:", err);
});

// Start the bot
bot.start();
