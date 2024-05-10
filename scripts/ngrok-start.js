require("dotenv").config();
require("colors");

const fs = require("fs");
const { spawn, exec } = require("child_process");
const { program } = require("commander");

program
  .requiredOption(
    "-h, --host <host>",
    "The ngrok host",
    process.env.NGROK_HOST || "localhost",
  )
  .requiredOption(
    "-p, --port <port>",
    "The ngrok port",
    process.env.NGROK_PORT || "3000",
  )
  // NGROK_SERVER_FILE option
  .option("-f, --file <path>", "The ngrok server file that contains the ngrok server URL", process.env.NGROK_SERVER_FILE || "")
  .option(
    "-b, --bin <path>",
    "The ngrok bin path",
    process.env.NGROK_BIN || "/usr/local/bin/ngrok",
  )
  .option("-s, --silent", "Silent mode (no prompts)", false);

program.parse(process.argv);
const options = program.opts();

// will update this file with the ngrok server URL
const serverFile = options.file;

const ngrokExecutable = fs.realpathSync(options.bin);
async function findAndKillNgrok(ngrokPath = "ngrok") {
  return new Promise((resolve, reject) => {
    exec("pgrep -afl ngrok", (error, stdout, stderr) => {  // Use 'pgrep -afl' to get the full command line
      if (error) {
        console.log("No ngrok processes running.");
        return resolve();
      }
      if (stderr) {
        console.error(`Error finding ngrok processes: ${stderr}`);
        return reject(stderr);
      }
      const processes = stdout
        .trim()
        .split("\n")
        .map((line) => {
          const parts = line.split(" ");
          return { pid: parts[0], cmd: parts.slice(1).join(" ") };
        });

      // Filter to remove any process that is an npm or node process or does not match the specified path
      const targetProcesses = processes.filter(process =>
        process.cmd.includes(ngrokPath) && !process.cmd.includes("npm") && !process.cmd.includes("node")
      );

      targetProcesses.forEach((process) => {
        console.log(`Targeting ngrok process: PID=${process.pid}, CMD=${process.cmd}`);
      });

      if (targetProcesses.length > 0) {
        const pids = targetProcesses.map(p => p.pid).join(" ");
        exec(`kill ${pids}`, (error) => {
          if (error) {
            console.error(`Error killing ngrok processes: ${error}`);
            return reject(error);
          }
          console.log("Successfully killed targeted ngrok processes.");
          resolve();
        });
      } else {
        console.log("No target ngrok processes found.");
        resolve();
      }
    });
  });
}

async function startNgrok() {
  const ngrokArgs = ["http", `${options.port}`];

  if (!options.silent) {
    console.log(
      `Starting ngrok tunnel to http://${options.host}:${options.port}`,
    );
    console.log(
      `Running ngrok command: ${ngrokExecutable} ${ngrokArgs.join(" ")}`,
    );
  }

  const ngrokProcess = spawn(
    ngrokExecutable,
    [...ngrokArgs, "--log", "stdout"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  ngrokProcess.stdout.on("data", (data) => {
    const message = data.toString();
    console.log(message);

    const urlMatch = message.match(/url=(https:\/\/[^\s]+)/);
    if (urlMatch && urlMatch[1]) {
      console.log(`Ngrok tunnel established at `.yellow + `${urlMatch[1]}`.underline.yellow);

      // if serverFile is set update it with the ngrok URL so that file can be required in server.js
      if (serverFile) {
        fs.writeFileSync(serverFile, urlMatch[1]);
        console.log(`Updated server file with ngrok URL: `.green + `${serverFile}`.underline.green);
      }

      // print test curl:
      // curl -X POST https://f17d-111-184-190-62.ngrok-free.app/incoming?config=nextlead
      console.log(`\nCurl test:\n`.green + `curl -X POST ${urlMatch[1]}/incoming?config=nextlead`.underline.green);
      console.log(`\nTwilio update ...`.underline.yellow);
      updateTwilio(urlMatch[1]);
    }
  });

  ngrokProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data.toString()}`.red);
  });

  ngrokProcess.on("error", (error) => {
    console.error(`Failed to start ngrok: ${error}`.red);
  });

  ngrokProcess.on("exit", (code, signal) => {
    console.log(`Ngrok process exited with code ${code}, signal ${signal}`.red);
    findAndKillNgrok(ngrokExecutable);
  });
}

async function main() {
  await findAndKillNgrok(ngrokExecutable);
  startNgrok();
}

function updateTwilio(ngrokUrl) {
  console.log(`Updating Twilio with ngrok URL: ${ngrokUrl}`);

  // Prepare arguments for the twilio-update script
  const args = [
    // "-n", options.number,             // The Twilio phone number
    "-s",
    ngrokUrl, // The ngrok URL retrieved
    // "-p", options.port,               // The server port
    // "-i", "/incoming",                // API endpoint for incoming calls
    // "-f", "/fail",                    // API endpoint for primary handler failures
    // "-c", "/status",                  // API endpoint for status callbacks
    // "-u", "config=nextlead",          // URL parameters to append
    "--silent", // Silent mode
  ];

  // Spawn the twilio-update script
  const updateProcess = spawn("node", ["./scripts/twilio-update.js", ...args], {
    stdio: "inherit",
  });

  updateProcess.on("error", (error) => {
    console.error(`Error starting twilio-update: ${error}`);
  });

  updateProcess.on("exit", (code, signal) => {
    if (code !== 0) {
      console.error(
        `twilio-update process exited with code ${code} and signal ${signal}`,
      );
    } else {
      console.log("twilio-update completed successfully.");
    }
  });
}

main();
