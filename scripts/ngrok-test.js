const { spawn } = require('child_process');

// Replace with the resolved path to ngrok
const ngrokExecutable = '/usr/local/Caskroom/ngrok/3.9.0,fcCEuUCV2S4,a/ngrok';

// Try to spawn the ngrok process
const ngrokProcess = spawn(ngrokExecutable, ['http', '3000', '--log', 'stdout'], { stdio: 'inherit', shell: true });

// Listen for standard output data
ngrokProcess.stdout.on('data', (data) => {
    console.log(`stdout: ${data.toString()}`);
});

// Listen for standard error data
ngrokProcess.stderr.on('data', (data) => {
    console.error(`stderr: ${data.toString()}`);
});

// Listen for any errors that occur when trying to spawn the command
ngrokProcess.on('error', (error) => {
    console.error(`Failed to start ngrok process: ${error}`);
});

// Listen for the close event of the process
ngrokProcess.on('close', (code) => {
    console.log(`ngrok process exited with code ${code}`);
});
