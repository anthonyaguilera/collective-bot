const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');

// IDs pulled from Render's Environment Variables
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

// --- OFFICIAL API SCRAPER ---
async function getWebsiteTitle(url) {
    try {
        // 1. YouTube Official API 
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
            if (res.ok) {
                const data = await res.json();
                return data.title;
            }
        }

        // 2. Spotify Official API 
        if (url.includes('spotify.com')) {
            const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
            if (res.ok) {
                const data = await res.json();
                return data.title;
            }
        }

        // 3. SoundCloud Official API 
        if (url.includes('soundcloud.com')) {
            const res = await fetch(`https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`);
            if (res.ok) {
                const data = await res.json();
                return data.title;
            }
        }

        // 4. Standard Fallback 
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36' }
        });
        const html = await response.text();

        const ogMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
        if (ogMatch && ogMatch[1]) return ogMatch[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();

        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) return titleMatch[1].replace(/\s*-\s*YouTube/gi, '').replace(/YouTube/gi, '').trim();

        return "Click to Listen"; 
    } catch (e) {
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

    // --- LEADERBOARD COMMAND ---
    if (message.content.toLowerCase() === '!leaderboard') {
        const top10 = await Song.find().sort({ likes: -1 }).limit(10);
        if (top10.length === 0) return message.channel.send("No songs have been voted on yet!");

        const loadingMessage = await message.channel.send("⏳ Fetching the Collective Leaderboard...");
        const leaderboardEmbed = new EmbedBuilder()
            .setTitle('🏆 Collective Leaderboard')
            .setColor('#FF0000') 
            .setTimestamp();

        const results = await Promise.all(top10.map(async (song, i) => {
            const title = await getWebsiteTitle(song.url);
            const rank = (i === 0) ? `🥇 #1` : (i === 1) ? `🥈 #2` : (i === 2) ? `🥉 #3` : `▫️ #${i + 1}`;
            return { name: `${rank} - ${song.likes} Likes`, value: `[${title}](${song.url})\nPosted by: <@${song.userId}>` };
        }));

        leaderboardEmbed.addFields(results);
        await message.channel.send({ embeds: [leaderboardEmbed] });
        await loadingMessage.delete();
    }

    // --- NEW: CLEAR COMMAND ---
    if (message.content.toLowerCase().startsWith('!clear')) {
        // 1. Check if the user is an Admin
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply("❌ You do not have permission to use this command.");
        }

        // 2. Extract the number from the message
        const args = message.content.split(' ');
        const amount = parseInt(args[1]);

        // 3. Validate the number
        if (isNaN(amount) || amount < 1 || amount > 100) {
            return message.reply("Please provide a number between 1 and 100. (Example: `!clear 10`)");
        }

        try {
            // 4. Delete the messages (+1 includes the !clear command itself, 'true' ignores 14-day old messages)
            const deletedMessages = await message.channel.bulkDelete(amount + 1, true);
            
            // 5. Send a temporary confirmation message
            const confirmation = await message.channel.send(`🧹 Successfully deleted ${deletedMessages.size - 1} messages.`);
            
            // Delete the confirmation message after 3 seconds so the channel stays completely clean
            setTimeout(() => confirmation.delete().catch(() => {}), 3000);
            
        } catch (error) {
            console.error("Clear command error:", error);
            message.reply("There was an error trying to clear messages in this channel!");
        }
    }
});

client.once('ready', () => console.log(`Bot is online as ${client.user.tag}`));
client.login(BOT_TOKEN);
http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);

