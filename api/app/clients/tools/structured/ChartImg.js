const axios = require("axios");
const { Tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { logger } = require("~/config");

// OpenAI v4+ Client
const OpenAI = require("openai");

class ChartImgAPI extends Tool {
  constructor(fields = {}) {
    super();
    if (!ChartImgAPI.instance) {
      this.config = {
        apiKey: fields.CHART_IMG_API_KEY || process.env.CHART_IMG_API_KEY || null,
        openaiApiKey: fields.OPENAI_API_KEY || process.env.OPENAI_API_KEY || null,
        openaiModel: fields.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-2024-08-06",
      };

      if (!this.config.apiKey) {
        logger.error("❌ Missing CHART_IMG_API_KEY. Some features may not work.");
      }

      this.openai = this.config.openaiApiKey ? new OpenAI({ apiKey: this.config.openaiApiKey }) : null;

      this.name = "chartimg";
      this.description = "Fetches a chart and analyzes it with OpenAI.";

      this.schema = z.object({
        type: z.enum(["advanced_and_analyze"]).describe("Generate and analyze an advanced chart."),
        symbol: z.string().min(1).describe("Trading symbol (e.g., 'BTCUSDT')."),
        interval: z.string().optional().default("1D").describe("Chart interval (e.g., '1D', '1H')."),
        theme: z.enum(["light", "dark"]).optional().default("dark").describe("Chart theme."),
        studies: z.array(z.string()).optional().describe("List of indicators (e.g., ['RSI', 'MACD'])."),
        promptMode: z.enum(["brief", "detailed", "trading_strategy"]).optional().default("brief").describe("Prompt style."),
        drawings: z.array(z.record(z.any())).optional().describe(
          "Optional array of drawing objects for Chart-IMG, e.g. Horizontal Line or Trend Line definitions."),
      });

      logger.info("✅ ChartImgAPI initialized.");
      ChartImgAPI.instance = this;
    }
    return ChartImgAPI.instance;
  }

  fixSymbol(symbol) {
    if (!symbol.includes(":")) {
      return `BINANCE:${symbol.toUpperCase()}`;
    }
    const parts = symbol.split(":");
    if (parts.length < 2 || !parts[1]) {
      return `BINANCE:${symbol.toUpperCase()}`; // Defaulting if missing
    }
    return `${parts[0].toUpperCase()}:${parts[1].toUpperCase()}`;
  }
  

  normalizeInterval(interval) {
    // Define a mapping of various input aliases to the supported intervals.
    const allowedIntervals = {
      '1m': '1m',   // 1 minute
      '3m': '3m',   // 3 minutes
      '5m': '5m',   // 5 minutes
      '15m': '15m', // 15 minutes
      '30m': '30m', // 30 minutes
      '45m': '45m', // 45 minutes
      '1h': '1h',   // 1 hour
      '2h': '2h',   // 2 hours
      '3h': '3h',   // 3 hours
      '4h': '4h',   // 4 hours
      '6h': '6h',   // 6 hours
      '12h': '12h', // 12 hours
      '1d': '1D',   // 1 day (user might input "d" or "day")
      'd': '1D',
      'day': '1D',
      '1w': '1W',   // 1 week (or "w", "week")
      'w': '1W',
      'week': '1W',
      '1mon': '1M', // 1 month (note: "1m" is already used for 1 minute)
      '1month': '1M',
      '1mth': '1M',
      '3mon': '3M', // 3 months
      '3month': '3M',
      '3mth': '3M',
      '6mon': '6M', // 6 months
      '6month': '6M',
      '6mth': '6M',
      '1y': '1Y',   // 1 year (or "year")
      'year': '1Y'
    };
  
    const lower = interval.toLowerCase();
    if (allowedIntervals[lower]) {
      return allowedIntervals[lower];
    } else {
      logger.warn(`Interval "${interval}" is not recognized. Defaulting to "1D".`);
      return "1D";
    }
  }
  

  async imageUrlToBase64(url, retries = 3) {
    try {
      const response = await axios.get(url, { responseType: "arraybuffer" });
      return Buffer.from(response.data, "binary").toString("base64");
    } catch (error) {
      if (retries > 0) {
        logger.warn(`🔄 Retrying image conversion (${3 - retries}/3)`);
        return this.imageUrlToBase64(url, retries - 1);
      }
      logger.error(`❌ Failed to convert image: ${error.message}`);
      throw new Error(`Chart-IMG API Request failed: ${error.message}`);
    }
  }

  async fetchChartImage(payload) {
    const url = "https://api.chart-img.com/v2/tradingview/advanced-chart/storage";
    try {
      console.log("📡 Sending API request with:", JSON.stringify(payload, null, 2));
      const response = await axios.post(url, payload, { headers: { "x-api-key": this.config.apiKey } });
      if (!response.data?.url) throw new Error("No chart URL received.");
      return response.data.url;
    } catch (error) {
      logger.error(`❌ Chart-IMG API Error: ${error.message}`);
      throw new Error(`Chart-IMG API Request failed: ${error.message}`);
    }
  }

  // ✅ Define Available Studies Dynamically
  getAvailableStudies() {
    const studies = {
      Volume: { "name": "Volume", "forceOverlay": true },
      Awesome: { "name": "Awesome Oscillator" },
      ATR: { "name": "Average True Range", "input": { "in_0": 14 } },
      Aroon: { "name": "Aroon", "input": { "in_0": 14 } },
      ChoppinessIndex: { "name": "Choppiness Index", "input": { "in_0": 14 } },
      RSI: { "name": "Relative Strength Index" },
      OBV: { "name": "On Balance Volume", "input": { "smoothingLine": "SMA", "smoothingLength": 9 } },
      HULL: { "name": "Hull Moving Average", "input": { "in_0": 55 }, "override": { "Plot.linewidth": 3, "Plot.color": "rgb(255,255,0)" } },
      BB: { "name": "Bollinger Bands", "input": { "in_0": 20, "in_1": 2 } },
      ADX: { "name": "Average Directional Index", "input": { "in_0": 14, "in_1": 14 } },
      BBB: { "name": "Bollinger Bands %B", "forceOverlay": false, "input": { "in_0": 20, "in_1": 2 } },
      CMF: { "name": "Chaikin Money Flow", "forceOverlay": false, "input": { "in_0": 20 } },
      Donchian: { "name": "Donchian Channels", "input": { "in_0": 20 } },
      WilliamsR: { "name": "Williams %R", "forceOverlay": false, "input": { "in_0": 14 } },
      SUPERTREND: { "name": "Super Trend", "input": { "in_0": 10, "in_1": 3 } },
      Ichimoku: {
        "name": "Ichimoku Cloud",
        "input": { "in_0": 9, "in_1": 26, "in_2": 52, "in_3": 26 },
        "override": { "ConversionLine.visible": false, "BaseLine.visible": false, "LaggingSpan.visible": false }
      },
      PSAR: { "name": "Parabolic SAR", "input": { "in_0": 0.02, "in_1": 0.02, "in_2": 0.2 } },
      MACD: { "name": "MACD", "forceOverlay": false, "input": { "in_0": 12, "in_1": 26, "in_2": 9, "in_3": "close" } },
      Stochastic: { "name": "Stochastic", "input": { "in_0": 14, "in_1": 1, "in_2": 3 } },
      StochRSI: { "name": "Stochastic RSI", "input": { "in_0": 14, "in_1": 14, "in_2": 3, "in_3": 3 } },
      VPVR: {
        "name": "Volume Profile Visible Range",
        "input": {
            "updown": true,      // Show Up/Down volume colors
            "style": "histogram", // Histogram style
            "rows": 24,         // Number of rows for volume distribution
            "width": 70         // Width of the volume profile on the chart
        },
        "override": {
          "graphics.hhists.histBars2.direction": "left_to_right",
          "graphics.hhists.histBarsVA.direction": "left_to_right",
          "Developing VA Low.display": true,
          "Developing VA High.display": true
        }
    },      
      VWAP: { "name": "VWAP", "input": { "length": 14, "source": "hlc3" } },
    };

    [9, 21, 50, 200].forEach((length) => {
      studies[`EMA${length}`] = {
        name: "Moving Average Exponential",
        input: { length, source: "close" },
      };
    });

    return studies;
  }

  buildStudyConfig(selectedStudies = []) {
    const availableStudies = this.getAvailableStudies();
    return selectedStudies.map((study) => availableStudies[study]).filter(Boolean);
  }

  getAvailableDrawings() {
    return {
      "horizontal line": {
        name: "Horizontal Line",
        input: {
          // We'll fill in "price" and "text" later
        },
        override: {
          // Default styling can go here
          fontSize: 14,
          lineWidth: 2,
          lineColor: "rgb(255,0,0)",
          textColor: "rgb(255,0,0)",
          horzLabelAlign: "center"
        }
      },
      "trend line": {
        name: "Trend Line",
        input: {
          // We'll fill in "startDatetime", "startPrice", etc. at runtime
        },
        override: {
          showLabel: true,
          lineWidth: 2
        }
      },
      // ... add other drawing templates as needed
    };
  }
  
  buildDrawingsConfig(drawingRequests = []) {
    const availableDrawings = this.getAvailableDrawings();
  
    // For each requested drawing, build a config that Chart-IMG understands
    return drawingRequests.map((req) => {
      const baseTemplate = availableDrawings[req.type.toLowerCase()];
      if (!baseTemplate) {
        logger.warn(`Unknown drawing type: ${req.type}`);
        return null; // Skip unknown types
      }
  
      // Deep-clone the base template so we can modify it
      const drawing = JSON.parse(JSON.stringify(baseTemplate));
  
      // Fill in dynamic input fields from the user's request
      if (req.price !== undefined) {
        drawing.input.price = req.price;
      }
      if (req.text !== undefined) {
        drawing.input.text = req.text;
      }
      if (req.startDatetime !== undefined) {
        drawing.input.startDatetime = req.startDatetime;
      }
      if (req.startPrice !== undefined) {
        drawing.input.startPrice = req.startPrice;
      }
      if (req.endDatetime !== undefined) {
        drawing.input.endDatetime = req.endDatetime;
      }
      if (req.endPrice !== undefined) {
        drawing.input.endPrice = req.endPrice;
      }
      // ... fill in other fields as needed (e.g., "targetPrice", "stopPrice", etc.)
  
      // Merge any override properties
      if (req.lineColor) {
        drawing.override.lineColor = req.lineColor;
      }
      if (req.textColor) {
        drawing.override.textColor = req.textColor;
      }
      if (req.lineWidth !== undefined) {
        drawing.override.lineWidth = req.lineWidth;
      }
      // ... add additional override merges as needed
  
      return drawing;
    }).filter(Boolean);
  }
  
  getAnalysisPrompt(mode, symbol, interval) {
    const prompts = {
      brief: `Provide a short analysis for ${symbol} on the ${interval} timeframe. Please always use the full symbol and do not shorten it.`,
      detailed: `Provide a comprehensive breakdown of technical analysis for ${symbol} on ${interval}, including trend, volume, and indicators.Please always use the full symbol and do not shorten it.`,
      trading_strategy: `Analyze ${symbol} on ${interval} and suggest a possible trading strategy including entry, exit, and risk management.Please always use the full symbol and do not shorten it.`,
    };
    return prompts[mode] ?? prompts["brief"];
  }

  // Instead of "function parseDrawingsFromText(text) {...}", do this:
  parseDrawingsFromText(text) {
    const drawings = [];
    const horizontalLineRegex = /horizontal line at\s+([0-9]*\.?[0-9]+)/i;
    const horizontalMatch = text.match(horizontalLineRegex);
    if (horizontalMatch) {
      const price = parseFloat(horizontalMatch[1]);
      drawings.push({
        type: "horizontal line",
        price,
        text: "Horizontal Line",
        lineColor: "rgb(0,255,0)",
        lineWidth: 2
      });
    }
    return drawings;
  }


  async analyzeWithOpenAI(base64Chart, symbol, interval, mode = "brief") {
    if (!this.openai) return "OpenAI analysis unavailable (missing API key).";
  
    try {
      const fixedSymbol = this.fixSymbol(symbol); // Ensure symbol is properly formatted
      const prompt = this.getAnalysisPrompt(mode, fixedSymbol, interval);
  
      const response = await this.openai.chat.completions.create({
        model: this.config.openaiModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/png;base64,${base64Chart}` } },
            ],
          },
        ],
        temperature: 0.1,
      });
  
      return response.choices[0]?.message?.content || `No analysis available for ${fixedSymbol}.`;
    } catch (error) {
      logger.error(`❌ OpenAI Error: ${error.message}`);
      return `Error analyzing chart for ${symbol}: ${error.message}`;
    }
  }
  

  async getAdvancedChartAndAnalyze({ symbol, interval = "1D", theme = "dark", studies = [], drawings = [], promptMode = "brief", promptText }) {
    try {
      const fixedSymbol = this.fixSymbol(symbol);
      const normalizedInterval = this.normalizeInterval(interval);
      const studyConfigs = this.buildStudyConfig(studies);
    
      // If no drawings are provided explicitly, try parsing from natural language promptText.
      let drawingConfigs = [];
      if (drawings.length === 0 && promptText) {
        drawingConfigs = this.buildDrawingsConfig(parseDrawingsFromText(promptText));
      } else {
        drawingConfigs = this.buildDrawingsConfig(drawings);
      }    

      console.log("📡 Preparing API request with:", {
        symbol: fixedSymbol,
        interval: normalizedInterval,
        theme,
        studies: studyConfigs,
      });

      const payload = {
        symbol: fixedSymbol,
        interval: normalizedInterval,
        theme,
        width: 800,
        height: 600,
        style: "candle",
        format: "png",
        scale: "regular",
        timezone: "Etc/UTC",
        studies: studyConfigs,
        drawings: drawingConfigs // Pass the final array
      };

      const chartUrl = await this.fetchChartImage(payload);
      if (!chartUrl) return "❌ Failed to retrieve chart.";

      const base64Chart = await this.imageUrlToBase64(chartUrl);
      const analysis = await this.analyzeWithOpenAI(base64Chart, fixedSymbol, normalizedInterval, promptMode);

      return `### Chart for \`${fixedSymbol}\` 
        ![Chart for \`${fixedSymbol}\`](${chartUrl})
        **Analysis for \`${fixedSymbol}\`**: 
        ${analysis}`


    } catch (error) {
      logger.error(`❌ Chart generation failed: ${error.message}`);
      return `Error generating or analyzing chart: ${error.message}`;
    }
  }

  async _call(data) {
    console.log("🟢 Received request:", JSON.stringify(data, null, 2));

    try {
      if (data.type === "advanced_and_analyze") {
        return await this.getAdvancedChartAndAnalyze(data);
      }
      throw new Error(`Unknown request type: ${data.type}`);
    } catch (error) {
      logger.error(`❌ Error in _call: ${error.message}`);
      return `❌ An error occurred: ${error.message}`;
    }
  }
}

module.exports = ChartImgAPI;
