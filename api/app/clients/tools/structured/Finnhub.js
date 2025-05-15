const axios = require("axios");
const { Tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { logger } = require("~/config");

class FinnhubAPI extends Tool {
  constructor(fields = {}) {
    super();
    if (!FinnhubAPI.instance) {
      this.config = {
        apiKey: fields.FINNHUB_API_KEY || process.env.FINNHUB_API_KEY || null,
      };

      if (!this.config.apiKey) {
        logger.error("❌ Missing FINNHUB_API_KEY. Some features may not work.");
      }

      this.name = "finnhub";
      this.description = "Fetches market data from Finnhub for technical analysis.";
      
      // ✅ Define Schema
      this.schema = z.object({
        type: z.enum(["latest_close", "support_resistance", "technical_indicator", "pattern_recognition", "aggregate_indicator","trending_signal","multi_trending_signal"])
          .describe("Type of Finnhub analysis."),
        symbol: z.string().min(1).describe("Trading symbol (e.g., 'BTCUSDT')."),
        resolution: z.enum(["1", "5", "15", "30", "60", "240", "D", "W", "M"]).default("D")
          .describe("Timeframe (1m, 5m, 15m, 1H, daily, weekly, monthly)."),
        indicators: z.array(z.string()).optional().describe("Technical indicators to fetch (e.g., ['MACD', 'RSI'])."),
      });

      logger.info("✅ FinnhubAPI initialized.");
      FinnhubAPI.instance = this;
    }
    return FinnhubAPI.instance;
  }

   /**
   * Helper: Calls Latest Close Price for FinnHub
   */
   async getLatestClose(symbol = "BTCUSDT") {
        try {
            const now = Math.floor(Date.now() / 1000);
            const from = now - 60 * 5; // 5 minutes ago
            const resolution = "1";

            // ✅ Ensure "BINANCE:" prefix is added if missing
            if (!symbol.includes(":")) {
                symbol = `BINANCE:${symbol.toUpperCase()}`;
            }

            // ✅ Ensure API Key is present
            if (!this.config.apiKey) {
                throw new Error("❌ Finnhub API Key is missing!");
            }

            const url = `https://finnhub.io/api/v1/crypto/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${now}&token=${this.config.apiKey}`;

            console.log("📡 Fetching latest price from:", url);
            console.log("🔑 Using API Key:", this.config.apiKey);

            const response = await axios.get(url);
            const data = response.data;

            // ✅ Debugging log to check what Finnhub is returning
            console.log("🟢 Finnhub API Response:", JSON.stringify(data, null, 2));

            if (!data || data.s !== "ok") {
                throw new Error(`❌ API Response Error: ${data.s || "Unknown error"}`);
            }

            return {
                symbol,
                latestClose: data.c ? data.c[data.c.length - 1] : null,
                high: data.h ? data.h[data.h.length - 1] : null,
                low: data.l ? data.l[data.l.length - 1] : null,
                volume: data.v ? data.v[data.v.length - 1] : null,
                timestamp: now,
            };
        } catch (err) {
            console.error("🔴 getLatestClose error:", err.response?.data || err.message);
            return { error: err.response?.data || err.message };
        }
    }

    async getTrendingAndDominantSignal(symbol, resolution = "D") {
        try {
            // Ensure "BINANCE:" prefix is added if missing
            if (!symbol.includes(":")) {
                symbol = `BINANCE:${symbol.toUpperCase()}`;
            }

            const url = `https://finnhub.io/api/v1/scan/technical-indicator?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&token=${this.config.apiKey}`;
            console.log("📡 Fetching trending status & dominant signal from:", url);

            const response = await axios.get(url);
            const data = response.data;

            if (!data) {
                throw new Error(`No data returned for ${symbol} at resolution ${resolution}`);
            }

            // ✅ Extract trending status (true/false)
            const trending = data.trend?.trending || false;

            // ✅ Extract dominant signal (buy/sell/neutral)
            const counts = data.technicalAnalysis?.count || {};
            const dominantSignal = this.getDominantSignal(counts);

            console.log(`🟢 Trending: ${trending}, Dominant Signal: ${dominantSignal}`);

            return { symbol, resolution, trending, dominantSignal };
        } catch (error) {
            console.error("❌ Finnhub Trending/Dominant Signal Error:", error.response?.data || error.message);
            return { error: error.response?.data || error.message };
        }
    }

    getDominantSignal(counts) {
        // Default to "neutral" if counts are missing
        if (!counts) return "neutral";
        const { buy = 0, neutral = 0, sell = 0 } = counts;
        let dominant = "neutral";
        let maxCount = neutral;
        if (buy > maxCount) {
            dominant = "buy";
            maxCount = buy;
        }
        if (sell > maxCount) {
            dominant = "sell";
        }
        return dominant;
    }
    
    async getMultiTrendingSignal(symbol, resolutions) {
        // Make sure "resolutions" is always an array
        if (!Array.isArray(resolutions)) {
          resolutions = [resolutions];
        }
      
        // Force "BINANCE:" prefix if missing
        if (!symbol.includes(":")) {
          symbol = `BINANCE:${symbol.toUpperCase()}`;
        }
      
        const results = [];
        for (const r of resolutions) {
          try {
            const data = await this.getTrendingAndDominantSignal(symbol, r);
            results.push({ resolution: r, ...data });
            // Optional: small delay to avoid rate limits
            await new Promise(res => setTimeout(res, 200));
          } catch (error) {
            results.push({ resolution: r, error: error.message });
          }
        }
      
        return { symbol, multiTimeframeTrending: results };
      }
      

  async getSupportResistance(symbol, resolution = "D") {
    const url = `https://finnhub.io/api/v1/scan/support-resistance?symbol=${symbol}&resolution=${resolution}&token=${this.config.apiKey}`;
  
    console.log("📡 Fetching Finnhub Support/Resistance:", url);
  
    try {
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error("❌ Finnhub Support/Resistance Error:", error.response?.data || error.message);
      return `Error fetching support/resistance: ${error.response?.data?.error || error.message}`;
    }
  }

  async getTechnicalIndicator(symbol, resolution = "D", indicators = ["macd", "rsi"]) {
    try {
      const indicatorQuery = indicators.map(ind => `indicator=${ind}`).join("&");
      const url = `https://finnhub.io/api/v1/indicator?symbol=${symbol}&resolution=${resolution}&${indicatorQuery}&token=${this.config.apiKey}`;
      const response = await axios.get(url);
      console.log("🟢 Finnhub Technical Indicators:", JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      logger.error(`❌ Finnhub Technical Indicator Error: ${error.message}`);
      return null;
    }
  }

  async getAggregateIndicator(symbol, resolution = "D") {
    try {
      const url = `https://finnhub.io/api/v1/scan/technical-indicator?symbol=${symbol}&resolution=${resolution}&token=${this.config.apiKey}`;
      const response = await axios.get(url);
      console.log("🟢 Finnhub Aggregate Indicator:", JSON.stringify(response.data, null, 2));
      return response.data.technicalAnalysis.signal;
    } catch (error) {
      logger.error(`❌ Finnhub Aggregate Indicator Error: ${error.message}`);
      return null;
    }
  }

  async getPatternRecognition(symbol, resolutions = ["15", "60", "D"]) {
    try {
        if (!Array.isArray(resolutions)) {
            resolutions = [resolutions]; // ✅ Ensure resolutions is always an array
        }

        // ✅ Ensure "BINANCE:" prefix is added if missing
        if (!symbol.includes(":")) {
            symbol = `BINANCE:${symbol.toUpperCase()}`;
        }

        console.log(`📡 Fetching Pattern Recognition for ${symbol} across: ${resolutions.join(", ")}`);

        const patternResults = {};

        // ✅ Loop through each timeframe and request pattern data with a delay
        for (const resolution of resolutions) {
            const url = `https://finnhub.io/api/v1/scan/pattern?symbol=${symbol}&resolution=${resolution}&token=${this.config.apiKey}`;
            try {
                const response = await axios.get(url);
                patternResults[resolution] = response.data.points || [];
            } catch (error) {
                console.error(`❌ Error fetching patterns for ${symbol} at ${resolution}:`, error.message);
                patternResults[resolution] = [];
            }

            // ✅ Add a delay to avoid hitting rate limits
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
        }

        return { symbol, patternResults };
    } catch (error) {
        console.error(`❌ Finnhub Multi-Timeframe Pattern Recognition Error: ${error.message}`);
        return { error: error.message };
    }
}


  async _call(data) {
    console.log("🟢 Received Finnhub request:", JSON.stringify(data, null, 2));

    try {
        let { type, symbol, resolution, indicators } = data;

        // ✅ Ensure symbol has the BINANCE prefix
        if (!symbol.includes(":")) {
            symbol = `BINANCE:${symbol.toUpperCase()}`;
        }

        console.log("📡 Using symbol for API request:", symbol);

        let finnhubData;
        switch (type) {
            case "latest_close":
                finnhubData = await this.getLatestClose(symbol);
                break;
            case "support_resistance":
                finnhubData = await this.getSupportResistance(symbol, resolution);
                break;
            case "technical_indicator":
                finnhubData = await this.getTechnicalIndicator(symbol, resolution, indicators);
                break;
            case "aggregate_indicator":
                finnhubData = await this.getAggregateIndicator(symbol, resolution);
                break;
            case "pattern_recognition":
                finnhubData = await this.getPatternRecognition(symbol, Array.isArray(resolution) ? resolution : [resolution]);
                break;
            case "trending_signal":  // ✅ New case for fetching trending status & dominant signal
                finnhubData = await this.getTrendingAndDominantSignal(symbol, resolution);
                break;
            default:
                throw new Error(`Unknown request type: ${type}`);
        }

        if (!finnhubData) {
            throw new Error(`No data returned for ${type}`);
        }

        // ✅ Ensure OpenAI receives properly formatted messages
        return {
            role: "user",
            content: [
                { type: "text", text: `Analyze the ${type.replace("_", " ")} results for ${symbol} on the ${resolution} timeframe.` },
                { type: "text", text: `\n\nData:\n${JSON.stringify(finnhubData, null, 2)}` }
            ]
        };

        return finnhubData;
    } catch (error) {
        logger.error(`❌ Finnhub Plugin Error: ${error.message}`);
        return `❌ An error occurred: ${error.message}`;
    }
}


}

module.exports = FinnhubAPI;
