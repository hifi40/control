let portOpen = false; // tracks whether a port is corrently open
let portPromise; // promise used to wait until port succesfully closed
let holdPort = null; // use this to park a SerialPort object when we change settings so that we don't need to ask the user to select it again
let port; // current SerialPort object
let reader; // current port reader object so we can call .cancel() on it to interrupt port reading

let micEqOnOffStat = false; // tracks mic eq on and off
let micCompOnOffStat = false;
let lineEqOnOffStat  = false;
let autoShutdownOnOffStat = false; // tracks auto shutdown timer on and off
let autoShutdownTimerMins = 60; // last selected (or current) auto shutdown duration, restored when switching back on

// Constants for the HIFI40 commands
const HIFI40_WRITE_REGISTER_COMMAND = "96"; // command to write a register
const HIFI40_TIMEOUT_LENGTH_CMD = "19"; // command to write the auto shutdown timer length setting

const HIFI40_WRITE_COMP_POINT_GRAPH_ARRAY_MH_CMD = "92"; // command to write compression point graph array mic, high band
const HIFI40_WRITE_COMP_POINT_GRAPH_ARRAY_ML_CMD = "93"; // command to write compression point graph array mic, low band

const HIFI40_WRITE_COMP_THRESH_MH_CMD = "89";
const HIFI40_WRITE_COMP_THRESH_ML_CMD = "90";

// Do these things when the window is done loading
window.onload = function () {
  // Check to make sure we can actually do serial stuff
  if ("serial" in navigator) {
    // The Web Serial API is supported.
    // Connect event listeners to DOM elements
    document
      .getElementById("openclose_port")
      .addEventListener("click", openClose);
    //document.getElementById("change").addEventListener("click", changeSettings);
    document.getElementById("clear").addEventListener("click", clearTerminal);
    document.getElementById("send").addEventListener("click", sendString);
    //document.getElementById("send1").addEventListener("click", sendString1);
    // connect the enable and disable compression buttons
    document
      .getElementById("mic_eq_onoff")
      .addEventListener("click", onoff_mic_eq);
    document
      .getElementById("mic_comp_onoff")
      .addEventListener("click", onoff_mic_comp);      
    document
      .getElementById("line_eq_onoff")
      .addEventListener("click", onoff_line_eq);
    document
      .getElementById("auto_shutdown_onoff")
      .addEventListener("click", onoff_auto_shutdown);
    document
      .getElementById("auto_shutdown_timer_30")
      .addEventListener("click", function () { setAutoShutdownTimer(30); });
    document
      .getElementById("auto_shutdown_timer_60")
      .addEventListener("click", function () { setAutoShutdownTimer(60); });
    document
      .getElementById("auto_shutdown_timer_90")
      .addEventListener("click", function () { setAutoShutdownTimer(90); });
    document
      .getElementById("auto_shutdown_timer_120")
      .addEventListener("click", function () { setAutoShutdownTimer(120); });
    document
      .getElementById("term_input")
      .addEventListener("keydown", detectEnter);

    // Clear the term_window textarea
    clearTerminal();

    // See if there's a prefill query string on the URL
    const params = new Proxy(new URLSearchParams(window.location.search), {
      get: (searchParams, prop) => searchParams.get(prop),
    });
    // Get the value of "some_key" in eg "https://example.com/?some_key=some_value"
    let preFill = params.prefill; // "some_value"
    if (preFill != null) {
      // If there's a prefill string then pop it into the term_input textarea
      document.getElementById("term_input").value = preFill;
    }

    // The raw terminal window (outDiv/inDiv) is a dev/debug tool, not something meant for
    // customers to see on the live site. It's hidden by default and only shown when
    // "?debug=1" is on the URL, so the same file can be used here in dev and copied as-is
    // into the live control repo without needing to strip it out each time.
    if (params.debug != "1") {
      document.getElementById("outDiv").style.display = "none";
      document.getElementById("inDiv").style.display = "none";
    }
  } else {
    // The Web Serial API is not supported.
    // Warn the user that their browser won't do stupid serial tricks
    alert("The Web Serial API is not supported by your browser");
  }
};

// This function is bound to the "Open" button, which also becomes the "Close" button
// and it detects which thing to do by checking the portOpen variable
async function openClose() {
  // Is there a port open already?
  if (portOpen) {
    // Port's open. Call reader.cancel() forces reader.read() to return done=true
    // so that the read loop will break and close the port
    reader.cancel();
    console.log("attempt to close");
  } else {
    // No port is open so we should open one.
    // We write a promise to the global portPromise var that resolves when the port is closed
    portPromise = new Promise((resolve) => {
      // Async anonymous function to open the port
      (async () => {
        // Check to see if we've stashed a SerialPort object
        if (holdPort == null) {
          // If we haven't stashed a SerialPort then ask the user to select one
          port = await navigator.serial.requestPort();
        } else {
          // If we have stashed a SerialPort then use it and clear the stash
          port = holdPort;
          holdPort = null;
        }
        // Grab the currently selected baud rate from the drop down menu
        //var baudSelected = parseInt(document.getElementById("baud_rate").value);
        var baudSelected = 115200; // hardcoded for now, we can change this later
        // Open the serial port with the selected baud rate
        await port.open({ baudRate: baudSelected });

        // Create a textDecoder stream and get its reader, pipe the port reader to it
        const textDecoder = new TextDecoderStream();
        reader = textDecoder.readable.getReader();
        const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);

        // If we've reached this point then we're connected to a serial port
        // Set a bunch of variables and enable the appropriate DOM elements
        portOpen = true;
        document.getElementById("openclose_port").innerText = "Close";
        document.getElementById("term_input").disabled = false;
        document.getElementById("send").disabled = false;
        document.getElementById("clear").disabled = false;
        //document.getElementById("change").disabled = false;
        //document.getElementById("send1").disabled = false;
        //document.getElementById("clear1").disabled = false;
        // Note: live-control elements (EQ/comp/timer sliders and switches) stay disabled here.
        // They're only enabled once the device's current settings are actually received and
        // displayed (see the "S" branch in parseMessage), so the UI never shows/allows editing
        // of stale defaults before a live connection is confirmed.

        // NOT SUPPORTED BY ALL ENVIRONMENTS
        // Get port info and display it to the user in the port_info span
        let portInfo = port.getInfo();
        document.getElementById("port_info").innerText =
          "Connected to device with VID " +
          portInfo.usbVendorId +
          " and PID " +
          portInfo.usbProductId;

        // Serial read loop. We'll stay here until the serial connection is ended externally or reader.cancel() is called
        // It's OK to sit in a while(true) loop because this is an async function and it will not block while it's await-ing
        // When reader.cancel() is called by another function, reader will be forced to return done=true and break the loop
        let newConnection = 1; // used to know when we need to retreive current settings upon opening a new connection
        while (true) {
          if(newConnection == 1)
          {
            sendString1("<9100>"); // command to print settings as data array
            newConnection = 0; // so we only do this once on a new connection opening
          }          
          const { value, done } = await reader.read();
          if (done) {
            reader.releaseLock(); // release the lock on the reader so the owner port can be closed
            break;
          }
          document.getElementById("term_window").value += value; // write the incoming string to the term_window textarea
          let terminalWindowTextComplete = document.getElementById("term_window").value; // get the complete text in the term_window textarea
          let messageArray = [];
          messageArray = terminalWindowTextComplete.split("\n"); // split the text into an array of lines
          let lastMessage = " ";
          lastMessage = messageArray[messageArray.length - 2]; // get the last line of the array
          parseMessage(lastMessage);
          
          // Once the term_window textarea has reach 10 lines, we clear it,
          // but we want to store the last message in the term_window, so that
          // it will be an array of at least 2 lines.
          // This is done to avoid the textarea from getting too long and slowing down the browser.
          if (messageArray.length > 100) {
            // Clear the term_window textarea
            document.getElementById("term_window").value = ""; // clear the term_window textarea
            // Add the last message to the term_window textarea on its own new line
            document.getElementById("term_window").value += lastMessage + "\n";
          }          
          //console.log(value);
        }

        // If we've reached this point then we're closing the port
        // first step to closing the port was releasing the lock on the reader
        // we did this before exiting the read loop.
        // That should have broken the textDecoder pipe and propagated an error up the chain
        // which we catch when this promise resolves
        await readableStreamClosed.catch(() => {
          /* Ignore the error */
        });
        // Now that all of the locks are released and the decoder is shut down, we can close the port
        await port.close();

        // Set a bunch of variables and disable the appropriate DOM elements
        portOpen = false;
        document.getElementById("openclose_port").innerText = "Open";
        document.getElementById("term_input").disabled = true;
        document.getElementById("send").disabled = true;
        //document.getElementById("change").disabled = true;
        document.getElementById("port_info").innerText = "Status: Disconnected";
        // Grey out and disable all live-control elements again now that we're disconnected,
        // so the last-known settings aren't left editable/misleading after the connection drops
        enableElementsByClass("live-control", false);
        // Tone the whole MICS/LINE/GENERAL SETTINGS area back down too
        document.getElementById("settingsSections").classList.add("awaiting-connection");

        console.log("port closed");

        // Resolve the promise that we returned earlier. This helps other functions know the port status
        resolve();
      })();
    });
  }

  return;
}

// Change settings that require a connection reset.
// Currently this only applies to the baud rate
async function changeSettings() {
  holdPort = port; // stash the current SerialPort object
  reader.cancel(); // force-close the current port
  console.log("changing setting...");
  console.log("waiting for port to close...");
  await portPromise; // wait for the port to be closed
  console.log("port closed, opening with new settings...");
  openClose(); // open the port again (it will grab the new settings while opening the port)
}

// Send a string over the serial port.
// This is easier than listening because we know when we're done sending
async function sendString() {
  let outString = document.getElementById("term_input").value; // get the string to send from the term_input textarea
  document.getElementById("term_input").value = ""; // clear the term_input textarea for the next user input

  // Get a text encoder, pipe it to the SerialPort object, and get a writer
  const textEncoder = new TextEncoderStream();
  const writableStreamClosed = textEncoder.readable.pipeTo(port.writable);
  const writer = textEncoder.writable.getWriter();

  // write the outString to the writer
  await writer.write(outString);
  // add the outgoing string to the term_window textarea on its own new line denoted by a ">"
  document.getElementById("term_window").value += "\n>" + outString + "\n";

  // close the writer since we're done sending for now
  writer.close();
  await writableStreamClosed;
}

// Send a string over the serial port.
// This is easier than listening because we know when we're done sending
async function sendString1(stringToSend) {
  //let outString = document.getElementById("term_input").value; // get the string to send from the term_input textarea
  let outString = "1";
  document.getElementById("term_input").value = ""; // clear the term_input textarea for the next user input

          // Grab the currently selected baud rate from the drop down menu
          var eqSelected = parseInt(document.getElementById("myRange1").value);

  // Get a text encoder, pipe it to the SerialPort object, and get a writer
  const textEncoder = new TextEncoderStream();
  const writableStreamClosed = textEncoder.readable.pipeTo(port.writable);
  const writer = textEncoder.writable.getWriter();

  // write the outString to the writer
  await writer.write(stringToSend);
  //await writer.write("1");

  // add the outgoing string to the term_window textarea on its own new line denoted by a ">"
  document.getElementById("term_window").value += "\n>" + stringToSend + "\n";

  // close the writer since we're done sending for now
  writer.close();
  await writableStreamClosed;
}

// Clear the contents of the term_window textarea
function clearTerminal() {
  document.getElementById("term_window").value = "";
}

// This function in bound to "keydown" in the term_input textarea.
// It intercepts Enter keystrokes and calls the sendString function
function detectEnter(e) {
  var key = e.keyCode;

  // If the user has pressed enter
  if (key == 13) {
    e.preventDefault();
    sendString();
  }
  return;
}

// sliderMicB functionality
var sliderMicB = document.getElementById("myRange1");
var sliderMicBoutput = document.getElementById("demo1");
sliderMicBoutput.innerHTML = sliderMicB.value;
sliderMicB.oninput = function() {
  sliderMicBoutput.innerHTML = this.value;
  setting = faderValToCommandVal(parseInt(this.value));
  sendString1("<02" + setting +">");
}

// sliderMicM functionality
var sliderMicM = document.getElementById("myRange2");
var sliderMicMoutput = document.getElementById("demo2");
sliderMicMoutput.innerHTML = sliderMicM.value;
sliderMicM.oninput = function() {
  sliderMicMoutput.innerHTML = this.value;
  setting = faderValToCommandVal(this.value);
  sendString1("<04" + setting +">");
}

// sliderMicT functionality
var sliderMicT = document.getElementById("myRange3");
var sliderMicToutput = document.getElementById("demo3");
sliderMicToutput.innerHTML = sliderMicT.value;
sliderMicT.oninput = function() {
  sliderMicToutput.innerHTML = this.value;
  setting = faderValToCommandVal(this.value);
  sendString1("<06" + setting +">");
}



// slider_mic_comp_threshold_low_band functionality
var slider_mic_comp_threshold_low_band = document.getElementById("myRange_Mic_LOWBAND_threshold");
var output_mic_comp_threshold_low_band = document.getElementById("myRange_Mic_LOWBAND_threshold_text_display_val");
output_mic_comp_threshold_low_band.innerHTML = slider_mic_comp_threshold_low_band.value + " dB";
slider_mic_comp_threshold_low_band.oninput = function() {
  output_mic_comp_threshold_low_band.innerHTML = this.value + " dB";
  // also need to send the comment to set the threshold choice in the settings array, this is used for syncing with user interface
  sendString1("<" + HIFI40_WRITE_COMP_THRESH_ML_CMD + FaderValToCommandVal_thresh(this.value) +">");  
  setTimeout(function() {
  //console.log("This message appears after a 100ms delay.");
  sendCpga("mic", "low", slider_mic_comp_threshold_low_band.value); // call the function to send the cpga for the mic low band
  }, 100); // Delay in milliseconds (2000ms = 2 seconds)
}

// slider_mic_comp_threshold_high_band functionality
var slider_mic_comp_threshold_high_band = document.getElementById("myRange_Mic_HIGHBAND_threshold");
var output_mic_comp_threshold_high_band = document.getElementById("myRange_Mic_HIGHBAND_threshold_text_display_val");
output_mic_comp_threshold_high_band.innerHTML = slider_mic_comp_threshold_high_band.value + " dB";
slider_mic_comp_threshold_high_band.oninput = function() {
  output_mic_comp_threshold_high_band.innerHTML = this.value + " dB";
  // also need to send the comment to set the threshold choice in the settings array, this is used for syncing with user interface
  sendString1("<" + HIFI40_WRITE_COMP_THRESH_MH_CMD + FaderValToCommandVal_thresh(this.value) +">");   
  setTimeout(function() {
  //console.log("This message appears after a 100ms delay.");
  sendCpga("mic", "low", slider_mic_comp_threshold_high_band.value); // call the function to send the cpga for the mic low band
  }, 100); // Delay in milliseconds (2000ms = 2 seconds)
}

// slider_mic_comp_makeup_gain_low_band functionality
var slider_mic_comp_makeup_gain_low_band = document.getElementById("myRange_Mic_LOWBAND_makeupGain");
var output_mic_comp_makeup_gain_low_band = document.getElementById("myRange_Mic_LOWBAND_makeupGain_text_display_val");
output_mic_comp_makeup_gain_low_band.innerHTML = slider_mic_comp_makeup_gain_low_band.value + " dB";
slider_mic_comp_makeup_gain_low_band.oninput = function() {
  output_mic_comp_makeup_gain_low_band.innerHTML = this.value + " dB";
  //sendString1("<94" + this.value +">"); // send the makeup gain value to the device, 94 is the command to set the makeup gain for the mic low band
  // use the function to set the makeup gain for the mic low band
  setMakeupGain(this.value, "low"); // call the function to set the makeup gain for the mic low band
}

// slider_mic_comp_makeup_gain_high_band functionality
var slider_mic_comp_makeup_gain_high_band = document.getElementById("myRange_Mic_HIGHBAND_makeupGain");
var output_mic_comp_makeup_gain_high_band = document.getElementById("myRange_Mic_HIGHBAND_makeupGain_text_display_val");
output_mic_comp_makeup_gain_high_band.innerHTML = slider_mic_comp_makeup_gain_high_band.value + " dB";
slider_mic_comp_makeup_gain_high_band.oninput = function() {
  output_mic_comp_makeup_gain_high_band.innerHTML = this.value + " dB";
  //sendString1("<95" + this.value +">"); // send the makeup gain value to the device, 95 is the command to set the makeup gain for the mic high band
  // use the function to set the makeup gain for the mic high band
  setMakeupGain(this.value, "high"); // call the function to set the makeup gain for the mic high band
}

// sliderLineB functionality
var sliderLineB = document.getElementById("myRange5");
var sliderLineBoutput = document.getElementById("demo5");
sliderLineBoutput.innerHTML = sliderLineB.value;
sliderLineB.oninput = function() {
  sliderLineBoutput.innerHTML = this.value;
  setting = faderValToCommandVal(this.value);
  sendString1("<11" + setting +">");
}
// sliderLineM functionality
var sliderLineM = document.getElementById("myRange6");
var sliderLineMoutput = document.getElementById("demo6");
sliderLineMoutput.innerHTML = sliderLineM.value;
sliderLineM.oninput = function() {
  sliderLineMoutput.innerHTML = this.value;
  setting = faderValToCommandVal(this.value);
  sendString1("<13" + setting +">");
}
// sliderLineT functionality
var sliderLineT = document.getElementById("myRange7");
var sliderLineToutput = document.getElementById("demo7");
sliderLineToutput.innerHTML = sliderLineT.value;
sliderLineT.oninput = function() {
  sliderLineToutput.innerHTML = this.value;
  setting = faderValToCommandVal(this.value);
  sendString1("<15" + setting +">");
}
// sliderMicOUTLVL functionality
var sliderMicOUTLVL = document.getElementById("myRangeMicOutputLevel");
var sliderMicOUTLVLoutput = document.getElementById("myRange_demo1MicOutputLevel_text_display_val");
sliderMicOUTLVLoutput.innerHTML = sliderMicOUTLVL.value + " dB";
sliderMicOUTLVL.oninput = function() {
  sliderMicOUTLVLoutput.innerHTML = this.value + " dB";
  setting = faderValToCommandVal_MicOutputLevel(this.value);
  sendString1("<29" + setting +">");
}




function faderValToCommandVal(faderVal) {
  setting = "00";
  if (faderVal == "10") setting = "20";
  if (faderVal == "9") setting = "19";
  if (faderVal == "8") setting = "18";
  if (faderVal == "7") setting = "17";
  if (faderVal == "6") setting = "16";
  if (faderVal == "5") setting = "15";
  if (faderVal == "4") setting = "14";
  if (faderVal == "3") setting = "13";
  if (faderVal == "2") setting = "12";
  if (faderVal == "1") setting = "11";
  if (faderVal == "0") setting = "10";
  if (faderVal == "-1") setting = "09";
  if (faderVal == "-2") setting = "08";
  if (faderVal == "-3") setting = "07";
  if (faderVal == "-4") setting = "06";
  if (faderVal == "-5") setting = "05";
  if (faderVal == "-6") setting = "04";
  if (faderVal == "-7") setting = "03";
  if (faderVal == "-8") setting = "02";
  if (faderVal == "-9") setting = "01";
  if (faderVal == "-10") setting = "00";
  return setting;
}

function CommandValToFaderVal(commandVal) {
  setting = "00";
  if (commandVal == "20") setting = "10";
  if (commandVal == "19") setting = "9";
  if (commandVal == "18") setting = "8";
  if (commandVal == "17") setting = "7";
  if (commandVal == "16") setting = "6";
  if (commandVal == "15") setting = "5";
  if (commandVal == "14") setting = "4";
  if (commandVal == "13") setting = "3";
  if (commandVal == "12") setting = "2";
  if (commandVal == "11") setting = "1";
  if (commandVal == "10") setting = "0";
  if (commandVal == "9") setting = "-1";
  if (commandVal == "8") setting = "-2";
  if (commandVal == "7") setting = "-3";
  if (commandVal == "6") setting = "-4";
  if (commandVal == "5") setting = "-5";
  if (commandVal == "4") setting = "-6";
  if (commandVal == "3") setting = "-7";
  if (commandVal == "2") setting = "-8";
  if (commandVal == "1") setting = "-9";
  if (commandVal == "0") setting = "-10";
  return setting;
}

function CommandValToFaderVal_thresh(commandVal) {
  setting = "0";
  if (commandVal == "10") setting = "0";
  if (commandVal == "9") setting = "-3";
  if (commandVal == "8") setting = "-6";
  if (commandVal == "7") setting = "-9";
  if (commandVal == "6") setting = "-12";
  if (commandVal == "5") setting = "-15";
  if (commandVal == "4") setting = "-18";
  if (commandVal == "3") setting = "-21";
  if (commandVal == "2") setting = "-24";
  if (commandVal == "1") setting = "-27";
  if (commandVal == "0") setting = "-30";
  return setting;
}

function FaderValToCommandVal_thresh(faderVal) {
  setting = "0";
  if (faderVal == "0") setting = "10";
  if (faderVal == "-3") setting = "09";
  if (faderVal == "-6") setting = "08";
  if (faderVal == "-9") setting = "07";
  if (faderVal == "-12") setting = "06";
  if (faderVal == "-15") setting = "05";
  if (faderVal == "-18") setting = "04";
  if (faderVal == "-21") setting = "03";
  if (faderVal == "-24") setting = "02";
  if (faderVal == "-27") setting = "01";
  if (faderVal == "-30") setting = "00";
  return setting;
}

// Convert display fader values to command values
function faderValToCommandVal_MicOutputLevel(faderVal) {
  // command vals are 0-63
  // fader vals are -57 to +6
  // to convert from fader to cmd, all we have to do is add 57
  // these are all strings, so we need to convert to ints and then back.
  let cmdVal = Number(faderVal) + 57;
  return cmdVal.toString();
}

function CommandValToFaderVal_MICOUTLEVEL(cmdVal)
{
  // command vals are 0-63
  // fader vals are -57 to +6
  // to convert from command to fader, all we have to do is sutract 57
  // these are all strings, so we need to convert to ints and then back.
  let fadVal = Number(cmdVal) - 57;
  return fadVal.toString();
}

const compressionPointGraphArray_thr_neg10_ratio_6t1 = [
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x7F, 	0xFF, 	0x29,
0x00, 	0x7E, 	0xC7, 	0x4A,
0x00, 	0x79, 	0x25, 	0x72,
0x00, 	0x6E, 	0x32, 	0x00,
0x00, 	0x5F, 	0x3E, 	0x65,
0x00, 	0x4E, 	0x8C, 	0xF8,
0x00, 	0x3E, 	0x75, 	0xC9,
0x00, 	0x30, 	0x49, 	0xE5,
0x00, 	0x24, 	0x9E, 	0x9D,
0x00, 	0x1B, 	0x7E, 	0x3A
]

const compressionPointGraphArray_thr_neg20_ratio_6t1 = [
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x80, 	0x00, 	0x00,
0x00, 	0x7F, 	0x7F, 	0x0B,
0x00, 	0x7C, 	0x6D, 	0x28,
0x00, 	0x75, 	0x77, 	0x57,
0x00, 	0x6A, 	0xB7, 	0x7D,
0x00, 	0x5D, 	0x50, 	0xCA,
0x00, 	0x4E, 	0x6E, 	0x2B,
0x00, 	0x3F, 	0xE4, 	0xC6,
0x00, 	0x32, 	0xAE, 	0x78,
0x00, 	0x27, 	0x56, 	0x30,
0x00, 	0x1E, 	0x06, 	0xFC,
0x00, 	0x16, 	0xA9, 	0x3F,
0x00, 	0x11, 	0x00, 	0x49
]

function sendCompressionSettings_MIC(setting) {
  if (setting == "0") {
    // do nothing for now 
  }
  if (setting == "1") {
    // send command to write the compression point graph array to the device at
    // register address 0x008E
    // first send the command to write a register,
    // followed by the register address, followed by the length of the data
    // followed by the data itself
    let command = "<";
    command += HIFI40_WRITE_REGISTER_COMMAND;
    command += "008E"; // register address
    // length of data for compression point graph array is 132 bytes
    command += "88"; // length of data, 136 bytes (aka 0x88 HEX)
    // now append the data itself
    for (let i = 0; i < compressionPointGraphArray_thr_neg10_ratio_6t1.length; i++) {
      command += compressionPointGraphArray_thr_neg10_ratio_6t1[i].toString(16).padStart(2, '0');
    }
    command += ">";
    console.log("compression command sent:");
    console.log(command);
    sendString1(command);
  }
  if (setting == "2") {
    // send command to write the compression point graph array to the device at
    // register address 0x008E
    // first send the command to write a register,
    // followed by the register address, followed by the length of the data
    // followed by the data itself
    let command = "<";
    command += HIFI40_WRITE_REGISTER_COMMAND;
    command += "008E"; // register address
    // length of data for compression point graph array is 132 bytes
    command += "88"; // length of data, 136 bytes (aka 0x88 HEX)
    // now append the data itself
    for (let i = 0; i < compressionPointGraphArray_thr_neg20_ratio_6t1.length; i++) {
      command += compressionPointGraphArray_thr_neg20_ratio_6t1[i].toString(16).padStart(2, '0');
    }
    command += ">";
    console.log("compression command sent:");
    console.log(command);
    sendString1(command);
  }


}

// send cpga
// compression point graphe array
// This function will send the command to set the compression point graph array (cpga) for the mic or aux signal channel
// micOrAux can be "mic" or "aux"
// band can be "low" or "high"
// cpga arrays are defined in the constants above
// cpga arrays are created using sigma studio, and they created using a combination of
// threshold and ratio. 
// For now, we are only going to have support for a variety of cpga that were created with
// 6 to 1 ratio, and a variety of thresholds (mainly 0 to -30 db, with 3 db steps).
// threshold can come from the slider, and will be a number between 0 and -30, with 3 db steps.
// for example: 0, -3, -6, -9, -12, -15, -18, -21, -24, -27, -30.

function sendCpga(micOrAux, band, threshold) {
  // the cpga arrays are defined in the constants above
  // so we must check each of the possible options coming in on threshold
  // (0, -3, -6, -9, -12, -15, -18, -21, -24, -27, -30) using a switch statement

  // the command to write a cpga is <92> for mic high band and <93> for mic low band
  // it must then be followed by the desired cpga array (which is determined by the incoming user threshold value)
  let command = "<";
  if (micOrAux == "mic") {
    if (band == "high") {
      command += HIFI40_WRITE_COMP_POINT_GRAPH_ARRAY_MH_CMD; // command for mic high band
    } else if (band == "low") {
      command += HIFI40_WRITE_COMP_POINT_GRAPH_ARRAY_ML_CMD; // command for mic low band
    }
  } else if (micOrAux == "aux") {
    // currently we do not support aux compression, so we will just return
    console.log("Aux compression not supported yet");
    return;
  }
  // now append the desired cpga array based on the threshold value
  switch (threshold) {
    case "0":
      // threshold is 0, so we will use the cpga array for 0 dB threshold
      // append the constant cpga array for 0 dB threshold, which lives in an external file
      for (let i = 0; i < compressionPointGraphArray_thr_0_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_0_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-3":
      // threshold is -3 dB, so we will use the cpga array for -3 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg3_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg3_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-6":
      // threshold is -6 dB, so we will use the cpga array for -6 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg6_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg6_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-9":
      // threshold is -9 dB, so we will use the cpga array for -9 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg9_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg9_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-12":
      // threshold is -12 dB, so we will use the cpga array for -12 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg12_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg12_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-15":
      // threshold is -15 dB, so we will use the cpga array for -15 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg15_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg15_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-18":
      // threshold is -18 dB, so we will use the cpga array for -18 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg18_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg18_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-21":
      // threshold is -21 dB, so we will use the cpga array for -21 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg21_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg21_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-24":
      // threshold is -24 dB, so we will use the cpga array for -24 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg24_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg24_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-27":
      // threshold is -27 dB, so we will use the cpga array for -27 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg27_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg27_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    case "-30":
      // threshold is -30 dB, so we will use the cpga array for -30 dB threshold
      for (let i = 0; i < compressionPointGraphArray_thr_neg30_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_neg30_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
    default:
      console.log("Invalid threshold value: " + threshold);
      console.log("Using default compression point graph array for threshold 0 dB");
      // set it to threshold 0 by default
      for (let i = 0; i < compressionPointGraphArray_thr_0_ratio_6t1.length; i++) {
        command += compressionPointGraphArray_thr_0_ratio_6t1[i].toString(16).padStart(2, '0');
      }
      break;
  }
  // now append the closing bracket
  command += ">";
  //console.log("Compression command sent:");
  //console.log(command);
  sendString1(command);
}

function onoff_mic_eq() {
  //console.log("mic eq button pressed");
 if(micEqOnOffStat == false)
 {
  micEqOnOffStat = true;
  //console.log("stat: true");
  document.getElementById("mic_eq_onoff_img").src="img/switchon.png";
  //console.log(document.getElementById("mic_eq_onoff_img").getAttribute("src"));
  sendString1("<0101>"); // send command to enable mic eq
 }
 else if(micEqOnOffStat == true)
 {
  micEqOnOffStat = false;
  //console.log("stat: false");
  document.getElementById("mic_eq_onoff_img").src="img/switchoff.png";
  sendString1("<0100>"); // send command to disable mic eq
 }
}

function onoff_mic_comp() {
 //console.log("mic comp button pressed");
 if(micCompOnOffStat == false)
 {
  micCompOnOffStat = true;
  //console.log("stat: true");
  document.getElementById("mic_comp_onoff_img").src="img/switchon.png";
  //console.log(document.getElementById("mic_eq_onoff_img").getAttribute("src"));
  sendString1("<0801>"); // send command to enable mic compression
 }
 else if(micCompOnOffStat == true)
 {
  micCompOnOffStat = false;
  //console.log("stat: false");
  document.getElementById("mic_comp_onoff_img").src="img/switchoff.png";
  sendString1("<0800>"); // send command to disable mic compression
 }
}

function onoff_line_eq() {
  //console.log("line eq button pressed");
 if(lineEqOnOffStat == false)
 {
  lineEqOnOffStat = true;
  //console.log("stat: true");
  document.getElementById("line_eq_onoff_img").src="img/switchon.png";
  //console.log(document.getElementById("mic_eq_onoff_img").getAttribute("src"));
  sendString1("<1001>"); // send command to enable line eq
 }
 else if(lineEqOnOffStat == true)
 {
  lineEqOnOffStat = false;
  //console.log("stat: false");
  document.getElementById("line_eq_onoff_img").src="img/switchoff.png";
  sendString1("<1000>"); // send command to disable line eq
 }
}

// Convert a timer duration in minutes (0, 30, 60, 90, 120) to the two-digit
// command argument expected by the HIFI40_TIMEOUT_LENGTH_CMD ("19") command
function timerMinsToCommandVal(mins) {
  if (mins == 30) return "01";
  if (mins == 60) return "02";
  if (mins == 90) return "03";
  if (mins == 120) return "04";
  return "00"; // 0 = off
}

// Convert a raw settings array value (0-4) back into minutes (0, 30, 60, 90, 120)
function commandValToTimerMins(commandVal) {
  let val = parseInt(commandVal);
  if (val == 1) return 30;
  if (val == 2) return 60;
  if (val == 3) return 90;
  if (val == 4) return 120;
  return 0; // off
}

// Update the on/off switch image and highlight the active duration button
// to reflect the current autoShutdownOnOffStat / autoShutdownTimerMins state
function updateAutoShutdownButtonsUI() {
  document.getElementById("auto_shutdown_onoff_img").src =
    autoShutdownOnOffStat ? "img/switchon.png" : "img/switchoff.png";

  let timerButtons = document.getElementsByClassName("timer-select-button");
  for (let i = 0; i < timerButtons.length; i++) {
    timerButtons[i].classList.remove("selected");
  }
  if (autoShutdownOnOffStat) {
    let activeButton = document.getElementById("auto_shutdown_timer_" + autoShutdownTimerMins);
    if (activeButton) activeButton.classList.add("selected");
  }
}

// Set the auto shutdown timer to the given duration in minutes (0 = off),
// update local state/UI, and send the command to the device
function setAutoShutdownTimer(mins) {
  autoShutdownOnOffStat = (mins != 0);
  if (mins != 0) {
    autoShutdownTimerMins = mins; // remember it so the on/off switch can restore it later
  }
  updateAutoShutdownButtonsUI();
  sendString1("<" + HIFI40_TIMEOUT_LENGTH_CMD + timerMinsToCommandVal(mins) + ">");
}

function onoff_auto_shutdown() {
  if (autoShutdownOnOffStat) {
    setAutoShutdownTimer(0); // turn off
  } else {
    setAutoShutdownTimer(autoShutdownTimerMins); // turn back on at the last selected duration
  }
}

function enableElementsByClass(className, enable) {
  var elements = document.getElementsByClassName(className); // 1. Get elements by class name
  for (var i = 0; i < elements.length; i++) { // 2. Iterate
    elements[i].disabled = !enable; // 3. Set disabled property based on enable parameter
  }
}

// Set compression settings using the simple slider
// setting comes from the slider max min value, so it will be a number between 0 and 10
// 0 = no compression, 10 = max compression
// This function will accept a setting value, and then determine the appropriate
// combination of compression settings to send to the device.
// For example, if the setting is 0, then we will send a command to disable mic compression.
// If the setting is 1, then we will set the threshold to -3 dB, and the makeup gain to 1 dB.
// If the settings is 2, then we will set the threshold to -6 dB, and the makeup gain to 2 dB.
// and so on.
// Note, we will also be updating the displayed slider position and values in the advanced settings section
// so that the user can see what the current settings are as they adjust the simple slider.
function setCompressionSettings_simple(setting) {
  if (setting == 0) {
    sendCompressionSettings_MIC("0"); // send command to disable mic compression
    // update the advanced settings sliders to reflect the simple setting (high and low bands)
    slider_mic_comp_threshold_low_band.value = 0; // set the low band threshold
    output_mic_comp_threshold_low_band.innerHTML = "0 dB"; // update the output text display
    slider_mic_comp_threshold_high_band.value = 0; // set the high band threshold
    output_mic_comp_threshold_high_band.innerHTML = "0 dB"; // update the output text display
    // set the makeup gain for the mic low and high band using the setMakeupGain function
    setMakeupGain(0, "low");
    setMakeupGain(0, "high");
  } else if (setting == 1) {
    sendCompressionSettings_MIC("1");
    // update the advanced settings sliders to reflect the simple setting
    slider_mic_comp_threshold_low_band.value = -3; // set the low band threshold
    output_mic_comp_threshold_low_band.innerHTML = "-3 dB"; // update the output text display
    slider_mic_comp_threshold_high_band.value = -3; // set the high band threshold
    output_mic_comp_threshold_high_band.innerHTML = "-3 dB"; // update the output text display
    // set the makeup gain for the mic low and high band using the setMakeupGain function
    setMakeupGain(1, "low");
    setMakeupGain(1, "high");
  } else if (setting == 2) {
    sendCompressionSettings_MIC("2");
    // update the advanced settings sliders to reflect the simple setting
    slider_mic_comp_threshold_low_band.value = -6; // set the low band threshold
    output_mic_comp_threshold_low_band.innerHTML = "-6 dB"; // update the output text display
    slider_mic_comp_threshold_high_band.value = -6; // set the high band threshold
    output_mic_comp_threshold_high_band.innerHTML = "-6 dB"; // update the output text display
    setMakeupGain(2, "low");
    setMakeupGain(2, "high");
  }

}

// set Makeup Gain for the mic compression
// setting comes from the slider max min value, so it will be a number between 0 and 10
// the second argument is the band, either "low" or "high"
// 0 = no makeup gain, 10 = max makeup gain
// This function will send the makeup gain value to the device
// The value will be between 0 and 10, where 0 is no makeup gain
// It will also update the slider position and value in the advanced settings section
function setMakeupGain(setting, band) {
  // update the band according to the input argument (high or low)
  // if setting is <10, add "0" to the front of the setting
  if (setting < 10) {
    settingToSend = "0" + setting.toString(); // convert to string and pad with 0
    // print the setting to the console for debugging
  }
  else {
    settingToSend = setting; // no padding needed
  }
  // print setting to the console for debugging
  console.log("Makeup gain settingToSend for " + band + " band: " + settingToSend);

  if (band == "low") {
    slider_mic_comp_makeup_gain_low_band.value = setting; // update the slider position
    output_mic_comp_makeup_gain_low_band.innerHTML = setting + " dB"; // update the output text display
    sendString1("<94" + settingToSend + ">"); // send the makeup gain value to the device, 94 is the command to set the makeup gain for the mic low band
  } else if (band == "high") {
    slider_mic_comp_makeup_gain_high_band.value = setting; // update the slider position
    output_mic_comp_makeup_gain_high_band.innerHTML = setting + " dB"; // update the output text display
    sendString1("<95" + settingToSend + ">"); // send the makeup gain value to the device, 95 is the command to set the makeup gain for the mic high band
  }
}

// set a compression point graph array
// this can be used to set the compression point graph array (aka "cpga") for 
// the mic signal channel or line signal channel compression
// Note, each signal channels has its own high and low band compression settings
function setCompressionPointGraphArray(signalChannel, band, array) {
  // signalChannel can be "mic" or "line"
  // band can be "low" or "high"
  // array is the compression point graph array to set
  // first we need to determine the register address to write to
  let registerAddress = "";
  if (signalChannel == "mic") {
    if (band == "low") {
      registerAddress = "00B9"; // mic low band compression point graph array
    } else if (band == "high") {
      registerAddress = "008E"; // mic high band compression point graph array
    }
  } else if (signalChannel == "line") {
    if (band == "low") {
      registerAddress = "0092"; // line low band compression point graph array
    } else if (band == "high") {
      registerAddress = "0094"; // line high band compression point graph array
    }
  }
  // now we can send the command to write the register
  let command = "<";
  command += HIFI40_WRITE_REGISTER_COMMAND;
  command += registerAddress; // register address
  command += "88"; // length of data, 136 bytes (aka 0x88 HEX)
  // now append the data itself
  for (let i = 0; i < array.length; i++) {
    command += array[i].toString(16).padStart(2, '0');
  }
  command += ">";

  console.log("compression command sent:");
  console.log(command);
  sendString1(command);
}

function validateString(inString) {
  // Make sure the string is correctly formatted with the exact right number of commas
  // and that the values are all numbers

  // First return false if the string is empty or not the right format
  if (inString == "" || inString == null) {
    console.log("inString is empty or null");
    return false;
  }

  // Make sure the string is a comma separated list of numbers (including negatives)
  // Optionally allow a trailing comma at the end
  // Example valid: "123,-456,789" or "123,-456,789,"
  // if (!/^\s*-?\d+(?:\s*,\s*-?\d+)*\s*,?\s*$/.test(inString)) {
  //   console.log("inString is not a comma separated list of numbers (optionally with trailing comma, negatives allowed)");
  //   return false;
  // }
  
  // Count the number of commas in the string
  //let commaCount = (inString.match(/,/g) || []).length;

  // If the number of commas is not less than or equal to the number of bars - 1, return false
  // if (commaCount < 0 || commaCount > number_of_bars - 1) {
  //   console.log("inString has too many commas!");
  //   console.log("commaCount: " + commaCount);
  //   console.log("number_of_bars: " + number_of_bars);
  //   return false;
  // }

  return true; // If we get here, the string is valid
}

function parseMessage(inString)
{
    if (!validateString(inString)) {
    console.log("inString is not valid: " + inString);
    return;
  }

  // removed whitespace from the end of the incoming string
  inString = inString.trimEnd();

  // Split the incoming string into an array of values
  let valueArray = inString.split(",");

  // print the length of the valueArray to the console
  console.log("valueArray length: " + valueArray.length);

  //addCurrentPlotlyLinePlot(valueArray); // add the current value to the Plotly graph

  if(valueArray[0] == "S")
  {
    console.log("valueArray[0] is an S");
    console.log("storing in local settingsArray")
    settingsArray = valueArray;
    updateDisplayFromSettingsArray();
    // Now that the device's live settings are actually displayed, it's safe to let the
    // user interact with them - enable/un-grey the EQ/comp/timer switches and sliders
    enableElementsByClass("live-control", true);
    // Bring the whole MICS/LINE/GENERAL SETTINGS area (titles, box borders, everything) up
    // to full brightness now that it's showing real, live settings
    document.getElementById("settingsSections").classList.remove("awaiting-connection");
  }

}

let settingsArray = [
0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
]

function updateDisplayFromSettingsArray()
{
  // mic eq bass fader
  sliderMicB.value = CommandValToFaderVal(settingsArray[3]);
  sliderMicBoutput.innerHTML = sliderMicB.value;

  // mic eq mid fader
  sliderMicM.value = CommandValToFaderVal(settingsArray[5]);
  sliderMicMoutput.innerHTML = sliderMicM.value;

  // mic eq treb fader
  sliderMicT.value = CommandValToFaderVal(settingsArray[7]);
  sliderMicToutput.innerHTML = sliderMicT.value;

  // mic comp thresh low band
  slider_mic_comp_threshold_low_band.value = CommandValToFaderVal_thresh(settingsArray[29]);
  output_mic_comp_threshold_low_band.innerHTML = slider_mic_comp_threshold_low_band.value + " dB";

  // mic comp thresh high band
  slider_mic_comp_threshold_high_band.value = CommandValToFaderVal_thresh(settingsArray[28]);
  output_mic_comp_threshold_high_band.innerHTML = slider_mic_comp_threshold_high_band.value + " dB";

  // mic comp makeup gain low band
  slider_mic_comp_makeup_gain_low_band.value = settingsArray[27];
  output_mic_comp_makeup_gain_low_band.innerHTML = slider_mic_comp_makeup_gain_low_band.value + " dB";

  // mic comp makeup gain low band
  slider_mic_comp_makeup_gain_high_band.value = settingsArray[26];
  output_mic_comp_makeup_gain_high_band.innerHTML = slider_mic_comp_makeup_gain_high_band.value + " dB";  

  // mic comp onoff button
 if(settingsArray[9] == "1")
 {
  document.getElementById("mic_comp_onoff_img").src="img/switchon.png";
  micCompOnOffStat = true;
 }
 else
 {
  document.getElementById("mic_comp_onoff_img").src="img/switchoff.png";
  micCompOnOffStat = false;
 }  

  // mic eq onoff button
 if(settingsArray[2] == "1")
 {
  document.getElementById("mic_eq_onoff_img").src="img/switchon.png";
  micEqOnOffStat = true;
 }
 else
 {
  document.getElementById("mic_eq_onoff_img").src="img/switchoff.png";
  micEqOnOffStat = false;
 }   

   // Line eq bass fader
  sliderLineB.value = CommandValToFaderVal(settingsArray[12]);
  sliderLineBoutput.innerHTML = sliderLineB.value;

  // Line eq mid fader
  sliderLineM.value = CommandValToFaderVal(settingsArray[14]);
  sliderLineMoutput.innerHTML = sliderLineM.value;

  // Line eq treb fader
  sliderLineT.value = CommandValToFaderVal(settingsArray[16]);
  sliderLineToutput.innerHTML = sliderLineT.value;

  // line eq onoff button
 if(settingsArray[11] == "1")
 {
  document.getElementById("line_eq_onoff_img").src="img/switchon.png";
  lineEqOnOffStat = true;
 }
 else
 {
  document.getElementById("line_eq_onoff_img").src="img/switchoff.png";
  lineEqOnOffStat = false;
 }     

   // mic output level fader
  sliderMicOUTLVL.value = CommandValToFaderVal_MICOUTLEVEL(settingsArray[30]);
  sliderMicOUTLVLoutput.innerHTML = sliderMicOUTLVL.value;

  // auto shutdown timer (settings array index 20 = HIFI40_TIMEOUT_LENGTH_MEM_ADD (19) + 1 for the leading "S")
  let autoShutdownMinsFromDevice = commandValToTimerMins(settingsArray[20]);
  autoShutdownOnOffStat = (autoShutdownMinsFromDevice != 0);
  if (autoShutdownMinsFromDevice != 0) {
    autoShutdownTimerMins = autoShutdownMinsFromDevice;
  }
  updateAutoShutdownButtonsUI();

}