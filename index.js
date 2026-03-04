const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');

// IDs pulled from Render's Environment Variables for GitHub safety
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

// --- THE ULTIMATE TITLE SCRAPER ---
async function getWebsiteTitle(url) {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    ];

    for (const agent of userAgents) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': agent },
                signal: AbortSignal.timeout(6000) // 6 second wait
            });
            const html = await response.text();
            
            // Look for the "og:title" which usually has the clean song name
            const ogMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                            html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
            
            let finalTitle = "";

            if (ogMatch && ogMatch[1]) {
                finalTitle = ogMatch[1];
            } else {
                const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
                if (titleMatch) finalTitle = titleMatch[1];
            }

            if (finalTitle) {
                // CLEANER: Strips out YouTube and other common junk text
                return finalTitle
                    .replace(/&amp;/g, '&')
                    .replace(/&quot;/g, '"')
                    .replace(/\s*-\s*YouTube/gi, '')
                    .replace(/YouTube/gi, '')
                    .replace(/\|\s*Spotify/gi, '')
                    .trim();
            }
        } catch (e) { continue; } // Try the next User-Agent if one fails
    }
    return "Click to Listen"; 
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

        // Process all titles in parallel for speed
        const results = await Promise.all(top10.map(async (song, i) => {
            const title = await getWebsiteTitle(song.url);
            const rank = (i === 0) ? `💎 #1` : (i === 1) ? `🥇 #2` : (i === 2) ? `🥉 #3` : `▫️ #${i + 1}`;
            return { name: `${rank} - ${song.likes} Likes`, value: `[${title}](${song.url})\nPosted by: <@${song.userId}>` };
        }));

        leaderboardEmbed.addFields(results);
        await message.channel.send({ embeds: [leaderboardEmbed] });
        await loadingMessage.delete();
    }
});

client.once('ready', () => console.log(`Bot is online as ${client.user.tag}`));
client.login(BOT_TOKEN);
http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);
