require("dotenv").config();
const { program } = require("commander");
const twilio = require("twilio");

program
  .requiredOption(
    "-n, --number <number>",
    "The Twilio phone number",
    process.env.APP_NUMBER || "",
  )
  .requiredOption(
    "-s, --server <server host>",
    "The server host URL",
    process.env.SERVER || "",
  )
  .option("-p, --port <port>", "The server port", process.env.SERVER_PORT || "")
  .requiredOption(
    "-i, --incoming <path>",
    "API endpoint for incoming calls",
    process.env.SERVER_API_INCOMING || "/incoming",
  )
  .option(
    "-f, --fail <path>",
    "API endpoint for primary handler failures",
    process.env.SERVER_API_FAIL || "",
  )
  .option(
    "-c, --callback <path>",
    "API endpoint for status callbacks",
    process.env.SERVER_API_STATUS || "",
  )
  .option(
    "-u, --urlparams <params>",
    "URL parameters to append to each webhook URL",
    process.env.SERVER_API_PARAMS || "",
  )
  .option("--silent", "Silent mode (no prompts)", false);

program.parse(process.argv);
const options = program.opts();

// Function to construct URLs
function constructUrl(path) {
  if (options.server && path) {
    // remove protocol from options.server
    options.server = options.server.replace(/https?:\/\//, "");
    let baseUrl = `https://${options.server}${options.port ? ":" + options.port : ""}${path}`;
    let urlParams = options.urlparams
      ? (baseUrl.includes("?") ? "&" : "?") + options.urlparams
      : "";
    return baseUrl + urlParams;
  }
  return null;
}

// Function to update Twilio phone number webhook URLs
async function updateWebhookUrls() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const client = twilio(accountSid, authToken);

  const voiceUrl = constructUrl(options.incoming);
  const fallbackUrl = constructUrl(options.fail);
  const statusCallbackUrl = constructUrl(options.callback);

  console.log(`Phone Number: ${options.number}`);
  console.log(`Voice URL: ${voiceUrl || "None"}`);
  console.log(`Fallback URL: ${fallbackUrl || "None"}`);
  console.log(`Status Callback URL: ${statusCallbackUrl || "None"}`);

  if (!options.silent) {
    // Dynamically import inquirer EMS module (cannot require)
    const { default: inquirer } = await import("inquirer");
    const answers = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "Do you want to proceed with updating these URLs?",
        default: false,
      },
    ]);

    if (!answers.confirm) {
      console.log("Update canceled by user.");
      process.exit(0);
    }
  } // silent prompt

  try {
    const updatedPhoneNumber = await client.incomingPhoneNumbers
      .list({ phoneNumber: options.number })
      .then((incomingPhoneNumbers) =>
        incomingPhoneNumbers[0].update({
          voiceUrl: voiceUrl,
          voiceFallbackUrl: fallbackUrl,
          statusCallback: statusCallbackUrl,
        }),
      );
    console.log("Updated Phone Number:", updatedPhoneNumber.sid);
  } catch (error) {
    console.error("Failed to update phone number:", error);
  }
}

updateWebhookUrls();
