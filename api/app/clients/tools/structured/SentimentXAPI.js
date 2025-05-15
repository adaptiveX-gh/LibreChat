const axios = require("axios");
const { Tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { logger } = require("~/config");

require('events').EventEmitter.defaultMaxListeners = 50; // Increase limit

class SentimentXAPI extends Tool {
  constructor(fields = {}) {
    super({ name: "sentimentx" }); // ✅ Explicitly define function name
    this.override = fields.override ?? false;

    this.name = "sentimentx";
    this.apiKey = fields.SENTIMENTX_API_KEY || this.getApiKey();
    this.apiUrl = fields.SENTIMENTX_API_URL || "https://sentimentx-restapi-ehsdemv7o-adaptivex-ghs-projects.vercel.app"

    this.description = `
      Fetch categorized Twitter insights (sentiment, whales, news, top traders) using the SentimentX API.
      Available actions:
      - getYaps: Fetch tweets categorized as 'yaps'
      - getCryptoXAI: Fetch tweets categorized as 'cryptoxai'
      - getTraders: Fetch tweets categorized as 'traders'
      - getNews: Fetch tweets categorized as 'news'
    `;

    this.schema = z.object({
      action: z.enum(["getYaps", "getCryptoXAI", "getNews", "getTraders"]).describe(
        "The category of tweets to retrieve."
      ),
    });

    if (!this.apiKey) {
      throw new Error("❌ Missing SENTIMENTX_API_KEY. Ensure it is set in environment variables.");
    }

    logger.info("✅ SentimentX tool successfully initialized.");
  }

  getApiKey() {
    const apiKey = process.env.SENTIMENTX_API_KEY || "";
    if (!apiKey && !this.override) {
      throw new Error("❌ Missing SENTIMENTX_API_KEY environment variable.");
    }
    return apiKey;
  }

  async _call(data) {
    try {
      const { action } = data;
      logger.info(`🟢 Executing '${action}' action for SentimentX API...`);

      switch (action) {
        case "getYaps":
          return await this.getTweets("yaps");            
        case "getCryptoXAI":
            return await this.getTweets("cryptoxai");      
        case "getTraders":
          return await this.getTweets("traders");      
        case "getNews":
          return await this.getTweets("news");
        default:
          logger.warn(`❓ Unknown action requested: ${action}`);
          return `❌ Unknown action: ${action}`;
      }
    } catch (error) {
      logger.error("🔴 SentimentX API error:", error);
      return `❌ Error fetching data: ${error.message}`;
    }
  }

  // ✅ Fetch tweets for a specific category with batch processing
  async getTweets(category) {
    const url = `${this.apiUrl}/tweets/${category}`;
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    const batchSize = 200;
    const maxTweets = 1000;
    let allTweets = [];
    let offset = 0;
    let hasMore = true;
  
    logger.info(`📡 Fetching tweets for category: ${category} from ${url}`);
  
    try {
      while (hasMore && allTweets.length < maxTweets) {
        logger.debug(`🔄 Fetching tweets: Offset ${offset}, Limit ${batchSize}`);
  
        const response = await axios.get(`${url}?offset=${offset}&limit=${batchSize}`, { headers });
  
        // 🛠 Debugging: Log the raw API response
        logger.debug(`📡 Raw API Response: ${JSON.stringify(response.data, null, 2)}`);
  
        // ✅ Ensure API response is a valid object
        if (!response.data || typeof response.data !== "object") {
          logger.error("❌ API response is not a valid object. Full response:", response.data);
          return { success: false, error: `API returned invalid data for '${category}'.` };
        }
  
        // ✅ Validate expected fields
        const hasTweets = Array.isArray(response.data.tweets);
        const hasWhaleData = Array.isArray(response.data.whale_data);
  
        if (!hasTweets && !hasWhaleData) {
          logger.error(`❌ API response missing expected fields. Full response: ${JSON.stringify(response.data, null, 2)}`);
          return { success: false, error: `Invalid API response for '${category}'.` };
        }
  
        // ✅ Handle Whale Data (`whale` category)
        if (category === "whale" && hasWhaleData) {
          return {
            success: true,
            category,
            count: response.data.count || 0,
            whale_data: response.data.whale_data.map(entry => ({
              buys: entry.buys.map(buy => ({
                token: buy.token,
                amount: buy.amount,
                whales: buy.whales
              })),
              sells: entry.sells.map(sell => ({
                token: sell.token,
                amount: sell.amount,
                whales: sell.whales
              }))
            }))
          };
        }
  
        // ✅ Handle Sentiment & News & Yaps Categories (Returns raw tweet text)
        if ((category === "sentiment" || category === "news" || category === "yaps" || category === "cryptoxai" || category === "traders") && hasTweets) {
          return {
            success: true,
            category,
            count: response.data.count || allTweets.length,
            tweets: response.data.tweets.map(tweet => ({
              id: tweet.id,
              username: tweet.username,
              user_id: tweet.user_id,
              created_at: tweet.created_at,
              tweet_text: tweet.tweet_text,
              views: tweet.views,
              likes: tweet.likes,
              retweets: tweet.retweets,
              replies: tweet.replies,
              tweet_url: tweet.tweet_url,              
            }))
          };
        }
   
        // ✅ Handle Normal Tweet Fetching (sentiment, news, traders)
        if (hasTweets) {
          if (response.data.tweets.length === 0) {
            logger.warn(`⚠️ No more tweets found for category: ${category}`);
            hasMore = false;
          } else {
            allTweets = [...allTweets, ...response.data.tweets];
            offset += batchSize;
          }
        }
      }
  
      if (allTweets.length === 0) {
        logger.warn(`⚠️ No tweets found for category '${category}'`);
        return { success: true, category, count: 0, tweets: [] };
      }
  
      logger.info(`✅ Successfully fetched ${allTweets.length} tweets for category '${category}'`);
  
      // ✅ Return parsed tweet data
      return {
        success: true,
        category,
        count: allTweets.length,
        tweets: allTweets,
      };
  
    } catch (error) {
      logger.error(`❌ Error retrieving tweets for '${category}': ${error.message}`);
      if (error.response) {
        logger.error(`📡 API Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      return {
        success: false,
        error: `❌ Error retrieving tweets for '${category}': ${error.message}`,
      };
    }
  }
  
}

module.exports = SentimentXAPI;
