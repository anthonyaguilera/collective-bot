const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');

// 👇 Passwords are now hidden! The code pulls them from Render's secure vault 👇
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
    if (TOP_10_ROLE_ID === 'YOUR_TOP_10_ROLE_ID_HERE') return; 

    try {
        const role = await guild.roles.fetch(TOP_10_ROLE_ID);
        if (!role) return;

        const top10UserIds = new Set(top10Songs.map(song => song.userId));

        role.members.forEach(async (member) => {
            if (!top10UserIds.has(member.id)) {
                await member.roles.remove(role).catch(console.error);
            }
        });

        for (const userId of top10UserIds) {
            if (!userId) continue;
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && !member.roles.cache.has(TOP_10_ROLE_ID)) {
                await member.roles.add(role).catch(console.error);
            }
        }
    } catch (error) {
        console.error("Error updating roles:", error);
    }
}

async function getWebsiteTitle(url) {
    try {
        const response = await fetch(url);
        const html = await response.text();
        
        const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
        if (ogMatch) return ogMatch[1].replace(/&amp;/g, '&');

        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) return titleMatch[1].replace(/&amp;/g, '&');

        return url; 
    } catch (error) {
        return url; 
    }
}

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.message.channel.name !== 'promote-music') return;
    if (!['🔥', '✅'].includes(reaction.emoji.name)) return;
    if (reaction.partial) await reaction.fetch();

    const messageContent = reaction.message.content;
    const linkMatch = messageContent.match(/(https?:\/\/[^\s]+)/);

    if (linkMatch) {
        const songUrl = linkMatch[0];
        const originalPosterId = reaction.message.author.id; 

        const updatedSong = await Song.findOneAndUpdate(
            { url: songUrl },
            { $inc: { likes: 1 }, $setOnInsert: { userId: originalPosterId } },
            { upsert: true, new: true }
        );

        console.log(`Counted a like for ${songUrl}. Total: ${updatedSong.likes}`);

        const top10 = await Song.find().sort({ likes: -1 }).limit(10);
        await updateTop10Roles(reaction.message.guild, top10);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.toLowerCase() === '!leaderboard') {
        const top10 = await Song.find().sort({ likes: -1 }).limit(10);

        if (top10.length === 0) {
            return message.channel.send("No songs have been voted on yet!");
        }

        const loadingMessage = await message.channel.send("⏳ Fetching the Collective Leaderboard from the cloud...");

        const leaderboardEmbed = new EmbedBuilder()
            .setTitle('🏆 Collective Leaderboard')
            .setDescription('The top 10 most liked songs in the Collective right now:')
            .setColor('#FF0000') 
            .setTimestamp();

        for (let i = 0; i < top10.length; i++) {
            const song = top10[i];
            const title = await getWebsiteTitle(song.url);
            
            let rankDisplay = `#${i + 1}`;
            if (i === 0) rankDisplay = `💎 #1`;        
            else if (i === 1) rankDisplay = `🥇 #2`;  
            else if (i === 2) rankDisplay = `🥉 #3`;  
            else rankDisplay = `▫️ #${i + 1}`;        
            
            leaderboardEmbed.addFields({ 
                name: `${rankDisplay} - ${song.likes} Likes`, 
                value: `[${title}](${song.url})\nPosted by: <@${song.userId}>`, 
                inline: false 
            });
        }

        await message.channel.send({ embeds: [leaderboardEmbed] });
        await loadingMessage.delete();
    }
});

client.once('ready', () => {
    console.log(`Bot is online and ready! Logged in as ${client.user.tag}`);
});

client.login(BOT_TOKEN);

http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);