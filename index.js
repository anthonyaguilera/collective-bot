const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');

// 👇 Hidden IDs - Handled via Render Environment Variables
const TOP_10_ROLE_ID = '1478602391631696116'; 
const MONGO_URI = process.env.MONGO_URI;
const BOT_TOKEN = process.env.BOT_TOKEN;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers, 
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Cloud Database!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const songSchema = new mongoose.Schema({
    url: { type: String, required: true, unique: true },
    likes: { type: Number, default: 0 },
    userId: { type: String, required: true }
});
const Song = mongoose.model('Song', songSchema);

async function updateTop10Roles(guild, top10Songs) {
    if (!TOP_10_ROLE_ID || TOP_10_ROLE_ID === 'YOUR_TOP_10_ROLE_ID_HERE') return; 
    try {
        const role = await guild.roles.fetch(TOP_10_ROLE_ID);
        if (!role) return;
        const top10UserIds = new Set(top10Songs.map(song => song.userId));
        role.members.forEach(async (member) => {
            if (!top10UserIds.has(member.id)) await member.roles.remove(role).catch(console.error);
        });
        for (const userId of top10UserIds) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && !member.roles.cache.has(TOP_10_ROLE_ID)) await member.roles.add(role).catch(console.error);
        }
    } catch (error) { console.error("Error updating roles:", error); }
}

// --- THE RE-FIXED TITLE SCRAPER ---
async function getWebsiteTitle(url) {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(5000) // Give it 5 seconds to respond
        });
        const html = await response.text();
        
        // Priority 1: Open Graph (Best for Spotify/YouTube)
        const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
        if (ogMatch) {
            return ogMatch[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
        }

        // Priority 2: Standard Title tag
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
            let title = titleMatch[1]
                .replace(/ - YouTube/gi, '')
                .replace(/YouTube/gi, '')
                .replace(/&amp;/g, '&')
                .trim();
            return title || "Click to Listen";
        }

        return "Click to Listen";
    } catch (error) {
        return "Click to Listen"; 
    }
}

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.message.channel.name !== 'promote-music') return;
    if (!['🔥', '✅'].includes(reaction.emoji.name)) return;
    if (reaction.partial) await reaction.fetch();

    const linkMatch = reaction.message.content.match(/(https?:\/\/[^\s]+)/);
    if (linkMatch) {
        const songUrl = linkMatch[0];
        await Song.findOneAndUpdate(
            { url: songUrl },
            { $inc: { likes: 1 }, $setOnInsert: { userId: reaction.message.author.id } },
            { upsert: true, new: true }
        );
        const top10 = await Song.find().sort({ likes: -1 }).limit(10);
        await updateTop10Roles(reaction.message.guild, top10);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.toLowerCase() === '!leaderboard') {
        const top10 = await Song.find().sort({ likes: -1 }).limit(10);
        if (top10.length === 0) return message.channel.send("No songs have been voted on yet!");

        const loadingMessage = await message.channel.send("⏳ Fetching the Collective Leaderboard...");
        const leaderboardEmbed = new EmbedBuilder()
            .setTitle('🏆 Collective Leaderboard')
            .setColor('#FF0000') 
            .setTimestamp();

        // Use Promise.all so we fetch all titles at once instead of one-by-one
        const leaderboardData = await Promise.all(top10.map(async (song, i) => {
            const title = await getWebsiteTitle(song.url);
            let rankDisplay = (i === 0) ? `💎 #1` : (i === 1) ? `🥇 #2` : (i === 2) ? `🥉 #3` : `▫️ #${i + 1}`;
            return { rankDisplay, likes: song.likes, title, url: song.url, userId: song.userId };
        }));

        leaderboardData.forEach(data => {
            leaderboardEmbed.addFields({ 
                name: `${data.rankDisplay} - ${data.likes} Likes`, 
                value: `[${data.title}](${data.url})\nPosted by: <@${data.userId}>`, 
                inline: false 
            });
        });

        await message.channel.send({ embeds: [leaderboardEmbed] });
        await loadingMessage.delete();
    }
});

client.once('ready', () => console.log(`Bot is online as ${client.user.tag}`));
client.login(BOT_TOKEN);
http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);
