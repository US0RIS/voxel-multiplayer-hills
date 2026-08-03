const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.NODE_ENV === 'production' 
  ? 'https://your-render-url.onrender.com/auth/discord/callback'
  : 'http://localhost:3000/auth/discord/callback';

// Redirect to Discord login
router.get('/discord', (req, res) => {
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20email`;
  res.redirect(discordAuthUrl);
});

// Handle Discord callback
router.get('/discord/callback', async (req, res) => {
  const code = req.query.code;
  const gameUrl = process.env.NODE_ENV === 'production'
    ? 'https://your-render-url.onrender.com'
    : 'http://localhost:8080';

  if (!code) {
    return res.redirect(`${gameUrl}?error=no_code`);
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', {
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    });

    const accessToken = tokenResponse.data.access_token;

    // Get Discord user info
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const discordUser = userResponse.data;
    const userId = `discord_${discordUser.id}`;

    // Save user to Supabase
    const { data, error } = await supabase
      .from('users')
      .upsert({
        id: userId,
        discord_id: discordUser.id,
        discord_username: discordUser.username,
        avatar_url: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      }, { onConflict: 'discord_id' })
      .select();

    if (error) throw error;

    // Create session token (simple base64 for MVP)
    const sessionToken = Buffer.from(userId).toString('base64');

    // Redirect back to game with auth
    res.redirect(`${gameUrl}?token=${sessionToken}&username=${discordUser.username}`);

  } catch (error) {
    console.error('Auth error:', error);
    res.redirect(`${gameUrl}?error=auth_failed`);
  }
});

module.exports = router;
