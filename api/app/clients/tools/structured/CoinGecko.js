const axios = require('axios');
const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');
const { logger } = require('~/config');

class CoinGeckoAPI extends Tool {
  constructor(fields = {}) {
    super();
    this.override = fields.override ?? false;

    this.name = 'coingecko';
    this.apiKey = fields.COINGECKO_API_KEY || this.getApiKey();
    this.description = `
      Fetch real-time cryptocurrency prices, trending coins, and top gainers/losers using the CoinGecko API. 
      Available actions:
      - getPrice: Get the price of a specific cryptocurrency.
      - getTrending: Get the top trending cryptocurrencies.
      - getTopGainersLosers: Get the top gainers and losers in the market.
    `;

    this.schema = z.object({
      action: z.enum(['getPrice', 'getTrending', 'getTopGainersLosers']).describe("The action to perform."),
      coinId: z.string().min(1).optional().describe("The CoinGecko coin ID (e.g., 'bitcoin', 'ethereum'). Required for 'getPrice'.")
    });

    if (!this.apiKey) {
      throw new Error('❌ Missing COINGECKO_API_KEY. Ensure it is set in environment variables.');
    }

    logger.info('✅ CoinGecko tool successfully initialized.');
  }

  getApiKey() {
    const apiKey = process.env.COINGECKO_API_KEY || '';
    if (!apiKey && !this.override) {
      throw new Error('❌ Missing COINGECKO_API_KEY environment variable.');
    }
    return apiKey;
  }

  async _call(data) {
    try {
      const { action, coinId } = data;
      logger.info(`🟢 Executing '${action}' action for CoinGecko API...`);

      switch (action) {
        case 'getPrice':
          return await this.getPrice(coinId);
        case 'getTrending':
          return await this.getTrending();
        case 'getTopGainersLosers':
          return await this.getTopGainersLosers();
        default:
          return `❌ Unknown action: ${action}`;
      }
    } catch (error) {
      logger.error('🔴 CoinGecko API error:', error);
      return `❌ Error fetching data: ${error.message}`;
    }
  }

  // ✅ Get current price of a coin
  async getPrice(coinId) {
    if (!coinId) {
      return '❌ Missing coinId. Please provide a valid CoinGecko coin ID.';
    }

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
    const response = await axios.get(url);

    if (response.data && response.data[coinId]) {
      return `✅ The price of ${coinId} is $${response.data[coinId].usd}.`;
    } else {
      return `❌ Coin '${coinId}' not found in CoinGecko.`;
    }
  }

  // ✅ Get trending cryptocurrencies
  async getTrending() {
    const url = `https://api.coingecko.com/api/v3/search/trending`;
    const response = await axios.get(url);

    if (response.data && response.data.coins) {
      const trendingList = response.data.coins
        .map(coin => `${coin.item.name} (${coin.item.symbol}) - Rank: ${coin.item.market_cap_rank}`)
        .join('\n');
      return `🔥 Trending Coins:\n${trendingList}`;
    } else {
      return '❌ Failed to retrieve trending cryptocurrencies.';
    }
  }

  // ✅ Get top gainers & losers
  async getTopGainersLosers() {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false`;
    const response = await axios.get(url);

    if (!response.data || response.data.length === 0) {
      return '❌ Failed to retrieve market data.';
    }

    const sortedCoins = response.data.sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h);

    const topGainers = sortedCoins.slice(0, 5).map(coin => `${coin.name} (${coin.symbol}): 🚀 +${coin.price_change_percentage_24h.toFixed(2)}%`).join('\n');
    const topLosers = sortedCoins.slice(-5).map(coin => `${coin.name} (${coin.symbol}): 📉 ${coin.price_change_percentage_24h.toFixed(2)}%`).join('\n');

    return `📊 **Top Gainers**:\n${topGainers}\n\n🔻 **Top Losers**:\n${topLosers}`;
  }
}

module.exports = CoinGeckoAPI;
