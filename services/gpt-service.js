require("colors");
const EventEmitter = require("events");
const OpenAI = require("openai");
const tools = require("../functions/function-manifest");

// Import all functions included in function manifest
// Note: the function name and file name must be the same
const availableFunctions = {};
tools.forEach((tool) => {
  let functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});

class GptService extends EventEmitter {
  constructor() {
    super();
    this.openai = new OpenAI();
    (this.userContext = [
      {
        role: "system",
        content: `
      You are Ivy, a cordial call agent at Nextlead, a lead generation agency.
      Your role is to guide callers in setting up a callback with one of our experts to address
      their lead generation needs.

      Follow this script a step at a time, never asking more than one question at a time:

      1. Introduce yourself and ask the caller about the type of leads they are interested in.
      2a. Inquire about their target regions for lead generation.
      2b. Confirm their lead requirements and prompt for any additional details.
      Gracefully transition to the next step if not successful or after a few failed attempts.
      3. Prompt them to set up a callback with an expert to discuss their campaign in detail.
      3a. If they refuse, ask if they have any questions or need further information.
      4. If they are interested in a callback, request their preferred date and time.
      "Asap" is a valid response.
      5. Confirm their phone number, or ask for it if not yet provided.
      6. Answer questions about our services and pricing only if prompted by the caller.
      7. For unrelated or repeated questions, kindly suggest that these can be more thoroughly addressed during the callback.
      8. Conclude the call by thanking the caller and restating the callback details for confirmation.
      Remind them that they will receive a text confirmation to their phone.

      General guidelines (please follow these throughout the call):
      - You have a cheerful, professional, and patient personality.
      - Keep your responses as brief as possible but make every attempt to keep the caller on the phone without being rude.
      - Don't ask more than 1 question at a time.
      - If possible, use shorthand for geographic places, provinces, etc. Example: BC for British Columbia.
      - Never respond with more than a single question or prompt at a time.
      - Confirm understanding by repeating key details back to the caller.
      - Ask for clarification if a user request is ambiguous.
      - If response is not clear or does not match the context, ask for clarification (e.g., "Sorry I didn't catch that...").
      - Don't make assumptions about what values to plug into functions.

      Refer to this context when responding to service-related questions:
      We run Google Search ads to direct potential clients to a dedicated phone line, enabling immediate engagement.
      Our pricing model is "Pay per Lead" at $10 per callback lead, with a one-time setup fee of $399 covering account
      and phone setup and lifetime management of their Google Ads, without hidden or monthly fees.
      Client has full control over their Ads budget, schedule, and volume.
      `,
      },
      {
        role: "system",
        content: `
        IMPORTANT:
          Add a '•' symbol every 5 to 10 words at natural pauses where your response can be split for text to speech.
      `,
      },
      {
        role: "assistant",
        content:
          "Hello! My name is Ivy. What kind of leads are you looking for?",
      },
    ]),
      (this.partialResponseIndex = 0);
  }

  // Add the callSid to the chat context in case
  // ChatGPT decides to transfer the call.
  setCallSid(callSid) {
    this.userContext.push({ role: "system", content: `callSid: ${callSid}` });
  }

  validateFunctionArgs(args) {
    try {
      return JSON.parse(args);
    } catch (error) {
      console.log(
        "Warning: Double function arguments returned by OpenAI:",
        args,
      );
      // Seeing an error where sometimes we have two sets of args
      if (args.indexOf("{") != args.lastIndexOf("{")) {
        return JSON.parse(
          args.substring(args.indexOf(""), args.indexOf("}") + 1),
        );
      }
    }
  }

  updateUserContext(name, role, text) {
    if (name !== "user") {
      this.userContext.push({ role: role, name: name, content: text });
    } else {
      this.userContext.push({ role: role, content: text });
    }
  }

  async completion(text, interactionCount, role = "user", name = "user") {
    this.updateUserContext(name, role, text);

    // Step 1: Send user transcription to Chat GPT
    const stream = await this.openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      messages: this.userContext,
      tools: tools,
      stream: true,
    });

    let completeResponse = "";
    let partialResponse = "";
    let functionName = "";
    let functionArgs = "";
    let finishReason = "";

    function collectToolInformation(deltas) {
      let name = deltas.tool_calls[0]?.function?.name || "";
      if (name != "") {
        functionName = name;
      }
      let args = deltas.tool_calls[0]?.function?.arguments || "";
      if (args != "") {
        // args are streamed as JSON string so we need to concatenate all chunks
        functionArgs += args;
      }
    }

    for await (const chunk of stream) {
      let content = chunk.choices[0]?.delta?.content || "";
      let deltas = chunk.choices[0].delta;
      finishReason = chunk.choices[0].finish_reason;

      // Step 2: check if GPT wanted to call a function
      if (deltas.tool_calls) {
        // Step 3: Collect the tokens containing function data
        collectToolInformation(deltas);
      }

      // need to call function on behalf of Chat GPT with the arguments it parsed from the conversation
      if (finishReason === "tool_calls") {
        // parse JSON string of args into JSON object

        const functionToCall = availableFunctions[functionName];
        const validatedArgs = this.validateFunctionArgs(functionArgs);

        // Say a pre-configured message from the function manifest
        // before running the function.
        const toolData = tools.find(
          (tool) => tool.function.name === functionName,
        );
        const say = toolData.function.say;

        this.emit(
          "gptreply",
          {
            partialResponseIndex: null,
            partialResponse: say,
          },
          interactionCount,
        );

        let functionResponse = await functionToCall(validatedArgs);

        // Step 4: send the info on the function call and function response to GPT
        this.updateUserContext("function", functionName, functionResponse);

        // call the completion function again but pass in the function response to have OpenAI generate a new assistant response
        await this.completion(
          functionResponse,
          interactionCount,
          "function",
          functionName,
        );
      } else {
        // We use completeResponse for userContext
        completeResponse += content;
        // We use partialResponse to provide a chunk for TTS
        partialResponse += content;
        // Emit last partial response and add complete response to userContext
        if (content.trim().slice(-1) === "•" || finishReason === "stop") {
          const gptReply = {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse,
          };

          this.emit("gptreply", gptReply, interactionCount);
          this.partialResponseIndex++;
          partialResponse = "";
        }
      }
    }
    this.userContext.push({ role: "assistant", content: completeResponse });
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }
}

module.exports = { GptService };
