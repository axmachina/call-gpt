require("dotenv").config();
require("colors");

const fs = require("fs");
const express = require("express");
const ExpressWs = require("express-ws");
const prettier = require("prettier");

const { GptService } = require("./services/gpt-service");
const { StreamService } = require("./services/stream-service");
const { TranscriptionService } = require("./services/transcription-service");
const { TextToSpeechService } = require("./services/tts-service");

const PORT = process.env.PORT || 3000;

const app = express();
ExpressWs(app);

// Middleware to parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));

// Middleware to parse JSON bodies (as sent by API clients)
app.use(express.json());

app.post(process.env.SERVER_API_INCOMING, (req, res) => {
  console.log(`\n>>> Twilio -> Incoming`.underline.green);
  logTwilioRequest(req);

  let server = process.env.SERVER;
  if (process.env.NGROK_SERVER_FILE) {
    // Assumes NGROK_SERVER_FILE is a path to a text file containing the server URL
    let ngrokServerFile = process.env.NGROK_SERVER_FILE;
    try {
      // Use fs.readFileSync to read the file contents
      server = fs.readFileSync(ngrokServerFile, "utf8").trim(); // trim to remove any extraneous whitespace or new lines
      server = server.replace(/https?:\/\//, "");

      console.log(`\n>>> Ngrok server read from file: ${server}`.yellow);
    } catch (error) {
      console.error(`Failed to read ngrok server URL from file: ${error}`);
    }
  }

  const streamUrl = `wss://${server}${process.env.SERVER_API_CONNECTION}`;

  console.log(`\n>>> Twilio -> Stream URL: ${streamUrl}`.yellow);

  res.status(200);
  res.type("text/xml");
  res.end(`
  <Response>
    <Connect>
      <Stream url="${streamUrl}" />
    </Connect>
  </Response>
  `);
});

app.post(process.env.SERVER_API_STATUS, (req, res) => {
  console.log(`\n>>> Twilio -> Status`.underline.yellow);
  logTwilioRequest(req);

  res.status(200);
  res.type("text/xml");
  res.end(`
  <Response>
   ok
  </Response>
  `);
});

app.post(process.env.SERVER_API_FAIL, (req, res) => {
  console.log(`\n>>> Twilio -> Fail`.underline.red);
  // log request headers and body
  logTwilioRequest(req);

  res.status(200);
  res.type("text/xml");
  res.end(`
  <Response>
   ok
  </Response>
  `);
});

app.ws(process.env.SERVER_API_CONNECTION, (ws) => {
  ws.on("open", function open() {
    console.log(`\n>>> Twilio -> Connection`.underline.green);
  });

  ws.on("error", console.error);

  // Filled in from start message
  let streamSid;
  let callSid;

  const gptService = new GptService();
  const streamService = new StreamService(ws);
  const transcriptionService = new TranscriptionService();
  const ttsService = new TextToSpeechService({});

  let marks = [];
  let interactionCount = 0;

  // Incoming from MediaStream
  ws.on("message", function message(data) {
    const msg = JSON.parse(data);
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      streamService.setStreamSid(streamSid);
      gptService.setCallSid(callSid);
      console.log(
        `Twilio -> Starting Media Stream for ${streamSid}`.underline.red,
      );
      ttsService.generate(
        {
          partialResponseIndex: null,
          partialResponse:
            "Hello! I understand you're looking for a pair of AirPods, is that correct?",
        },
        1,
      );
    } else if (msg.event === "media") {
      transcriptionService.send(msg.media.payload);
    } else if (msg.event === "mark") {
      const label = msg.mark.name;
      console.log(
        `Twilio -> Audio completed mark (${msg.sequenceNumber}): ${label}`.red,
      );
      marks = marks.filter((m) => m !== msg.mark.name);
    } else if (msg.event === "stop") {
      console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
    }
  });

  transcriptionService.on("utterance", async (text) => {
    // This is a bit of a hack to filter out empty utterances
    if (marks.length > 0 && text?.length > 5) {
      console.log("Twilio -> Interruption, Clearing stream".red);
      ws.send(
        JSON.stringify({
          streamSid,
          event: "clear",
        }),
      );
    }
  });

  transcriptionService.on("transcription", async (text) => {
    if (!text) {
      return;
    }
    console.log(`Interaction ${interactionCount} – STT -> GPT: ${text}`.yellow);
    gptService.completion(text, interactionCount);
    interactionCount += 1;
  });

  gptService.on("gptreply", async (gptReply, icount) => {
    console.log(
      `Interaction ${icount}: GPT -> TTS: ${gptReply.partialResponse}`.green,
    );
    ttsService.generate(gptReply, icount);
  });

  ttsService.on("speech", (responseIndex, audio, label, icount) => {
    console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`.blue);

    streamService.buffer(responseIndex, audio);
  });

  streamService.on("audiosent", (markLabel) => {
    marks.push(markLabel);
  });
});

app.listen(PORT);
console.log(`Server running on port ${PORT}`);

async function logTwilioRequest(request) {
  // write response headers to console
  console.log("Twilio headers:");
  Object.entries(request.headers).forEach(([key, value]) => {
    // if has Set-Cookie header, print each entry on its own line
    if (key === "Set-Cookie") {
      // print value array
      value.forEach((cookie) => {
        console.log(`${key}: ${cookie}`);
      });
      return;
    }
    console.log(`${key}: ${value}`);
  });

  // calculate total size of all headers in bytes
  const headerSize = getHeaderSize(request.headers);
  console.log(`Header size: ${headerSize} bytes`);

  // print response body
  const prettyBody = await prettier.format(JSON.stringify(request.body), {
    parser: "json",
  });
  console.log(`Body:\n${prettyBody}`);
}

function getStringByteSize(str = "") {
  return Buffer.from(str).length;
}

function getHeaderSize(headers) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    const keySize = getStringByteSize(key); // Size of the header key
    let valueSize = 0; // Initialize value size

    if (Array.isArray(value)) {
      // If the value is an array, sum the byte sizes of all items in the array
      valueSize = value.reduce((sum, item) => sum + getStringByteSize(item), 0);
    } else {
      // If the value is a string, directly calculate its byte size
      valueSize = getStringByteSize(value);
    }

    return acc + keySize + valueSize; // Accumulate total size
  }, 0);
}
