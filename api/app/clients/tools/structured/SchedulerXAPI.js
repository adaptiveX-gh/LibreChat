const axios = require("axios");
const { Tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { logger } = require("~/config");

class SchedulerXAPI extends Tool {
  constructor(fields = {}) {
    super();
    this.override = fields.override ?? false;

    this.name = "schedulerx";
    this.apiKey = fields.SCHEDULERX_API_KEY || this.getApiKey();
    this.apiUrl = fields.SCHEDULERX_API_URL || "https://schedulerx-restapi-7iqfyjnrm-adaptivex-ghs-projects.vercel.app"; // Replace with actual REST API URL

    this.description = `
      Manage SchedulerX prompts via the SchedulerX API.
      Available actions:
      - getPrompts: Fetch all prompts linked to a user's email.
      - getPromptById: Fetch a single prompt by its ID.
      getUserIdByEmail: Fetch User Id by a user's email.
      - addPrompt: Add a new prompt linked to a user's email.
      - updatePrompt: Update an existing prompt.
      - deletePrompt: Delete a prompt by ID.
    `;

    this.schema = z.object({
      action: z.enum(["getPrompts", "getPromptById", "addPrompt", "updatePrompt", "deletePrompt"]).describe(
        "The action to perform on SchedulerX prompts."
      ),
      userEmail: z.string().optional().describe("The user's email address (required for getPrompts, addPrompt)."),
      promptId: z.string().optional().describe("The prompt ID (required for getPromptById, updatePrompt, deletePrompt)."),
      promptText: z.string().optional().describe("The new prompt text (required for addPrompt, updatePrompt)."),
      schedule: z.enum(["Hourly", "Daily"]).optional().describe("The schedule type (required for addPrompt, updatePrompt)."),
      isActive: z.boolean().optional().describe("Set prompt active status (only for updatePrompt).")
    });

    if (!this.apiKey) {
      throw new Error("❌ Missing SCHEDULERX_API_KEY. Ensure it is set in environment variables.");
    }

    logger.info("✅ SchedulerX tool successfully initialized.");
  }

  getApiKey() {
    const apiKey = process.env.SCHEDULERX_API_KEY || "";
    if (!apiKey && !this.override) {
      throw new Error("❌ Missing SCHEDULERX_API_KEY environment variable.");
    }
    return apiKey;
  }

  async _call(data) {
    try {
      const { action, userEmail, promptId, promptText, schedule, isActive } = data;
      logger.info(`🟢 Executing '${action}' action for SchedulerX API...`);

      switch (action) {
        case "getPrompts":
          return await this.getPrompts(userEmail);
        case "getPromptById":
          return await this.getPromptById(promptId);
        case "addPrompt":
          return await this.addPrompt(userEmail, promptText, schedule);
        case "updatePrompt":
          return await this.updatePrompt(promptId, promptText, schedule, isActive);
        case "deletePrompt":
          return await this.deletePrompt(promptId);
        default:
          return `❌ Unknown action: ${action}`;
      }
    } catch (error) {
      logger.error("🔴 SchedulerX API error:", error);
      return `❌ Error executing action '${data.action}': ${error.message}`;
    }
  }

  // ✅ Fetch all prompts linked to a user's email
  async getPrompts(userEmail) {
        const url = `${this.apiUrl}/prompts?userEmail=${userEmail}`;
        const headers = { Authorization: `Bearer ${this.apiKey}` };

        try {
            const response = await axios.get(url, { headers });

            if (!response.data || response.data.length === 0) {
                return {
                    success: true,
                    prompts: [],
                    message: "⚠️ No prompts found for this user.",
                };
            }

            // ✅ Ensure correct message format
            return {
                success: true,
                prompts: response.data.map(prompt => ({
                    promptId: prompt.id,  // ✅ Include the ID field for deletion
                    type: "text",   // ✅ Adding "type" field
                    value: `Prompt: ${prompt.prompt_text}\nSchedule: ${prompt.schedule}\nActive: ${prompt.is_active}`
                }))
            };

        } catch (error) {
            return {
                success: false,
                type: "text",
                value: `❌ Error retrieving prompts: ${error.response?.data || error.message}`
            };
        }
    }



// ✅ Add a new prompt linked to a user email (Single API Call)
async addPrompt(userEmail, promptText, schedule) {
  const url = `${this.apiUrl}/users?email=${encodeURIComponent(userEmail)}`;
  const headers = { Authorization: `Bearer ${this.apiKey}` };

  try {
      console.log(`🔍 Fetching User ID and Adding Prompt in one call for Email: ${userEmail}`);

      // ✅ Fetch User ID & Add Prompt in One Request
      const userResponse = await axios.get(url, { headers });

      if (!userResponse.data || !userResponse.data.userId) {
          return { success: false, error: "⚠️ User not found." };
      }

      const userId = userResponse.data.userId;
      console.log(`✅ User Found: ${userId}`);

      // ✅ Directly add the prompt using the retrieved User ID
      const promptUrl = `${this.apiUrl}/prompts`;
      const requestBody = {
          user_id: userId,
          prompt_text: promptText,
          schedule,
          is_active: true
      };

      console.log("📤 DEBUG: Sending Request to API:");
      console.log("🔗 URL:", promptUrl);
      console.log("📝 Headers:", headers);
      console.log("📥 Body:", JSON.stringify(requestBody, null, 2));

      const response = await axios.post(promptUrl, requestBody, { headers });

      return response.data; // ✅ Return API response

  } catch (error) {
      console.error("❌ API Request Failed:", error.response?.data || error.message);
      return { success: false, error: `❌ Error adding prompt: ${JSON.stringify(error.response?.data || error.message)}` };
  }
}




  // ✅ Update an existing prompt
  async updatePrompt(promptId, promptText, schedule, isActive) {
    if (!promptId || !promptText || !schedule || isActive === undefined) {
      return "❌ Error: Missing required parameters (promptId, promptText, schedule, isActive).";
    }

    const url = `${this.apiUrl}/prompts/${promptId}`;
    const headers = { Authorization: `Bearer ${this.apiKey}` };

    try {
      const response = await axios.put(url, { prompt_text: promptText, schedule, is_active: isActive }, { headers });
      return response.data;
    } catch (error) {
      return `❌ Error updating prompt: ${error.response?.data || error.message}`;
    }
  }

  // ✅ Delete a prompt by ID

  async deletePrompt(promptId) {
    if (!promptId) {
        console.error("❌ Error: Missing promptId parameter.");
        return { success: false, error: "Missing promptId parameter." };
    }

    const url = `${this.apiUrl}/prompts/${promptId}`;
    const headers = { Authorization: `Bearer ${this.apiKey}` };

    try {
        console.log(`🗑 Attempting to delete prompt: ${promptId}`);
        console.log(`🔗 API URL: ${url}`);
        console.log(`📝 Headers:`, headers);

        const response = await axios.delete(url, { headers });

        console.log("✅ API Response:", response.data);
        return response.data;
    } catch (error) {
        console.error("❌ Error deleting prompt:", error.response?.data || error.message);
        return { success: false, error: `❌ Error deleting prompt: ${JSON.stringify(error.response?.data || error.message)}` };
    }
  }
}
module.exports = SchedulerXAPI;
