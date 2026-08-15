// ─────────────────────────────────────────────────────────────
// ARDUINO PORT DETECTOR
// Run: node find-port.js
// ─────────────────────────────────────────────────────────────

const { SerialPort } = require("serialport");
const fs = require("fs");
const path = require("path");

// Path to your .env file (same folder as this script)
const ENV_PATH = path.join(__dirname, ".env");

async function detectArduino() {
  try {
    console.log("\n🔍 Scanning for serial ports...\n");

    const ports = await SerialPort.list();

    if (ports.length === 0) {
      console.log("❌ No serial ports found.");
      return;
    }

    console.log("📋 All detected ports:");
    console.log("─────────────────────────────────────────────");
    ports.forEach((port, i) => {
      console.log(`${i + 1}. ${port.path}`);
      console.log(`   Manufacturer: ${port.manufacturer || "Unknown"}`);
      console.log(`   Vendor ID:    ${port.vendorId || "N/A"}`);
      console.log(`   Product ID:   ${port.productId || "N/A"}`);
      console.log("─────────────────────────────────────────────");
    });

    // Look for Arduino by common identifiers
    console.log("\n🔎 Searching for Arduino...");
    const arduino = ports.find((p) => {
      const manuf = (p.manufacturer || "").toLowerCase();
      const path = p.path.toLowerCase();
      const vid = (p.vendorId || "").toLowerCase();
      const pid = (p.productId || "").toLowerCase();

      return (
        manuf.includes("arduino") ||
        manuf.includes("ch340") ||
        manuf.includes("cp210") ||
        vid === "2341" || // Arduino vendor ID
        pid === "0043" || // Arduino Uno
        path.includes("ttyacm") ||
        path.includes("ttyusb") ||
        path.includes("cu.usbmodem")
      );
    });

    if (arduino) {
      console.log(`✅ Arduino detected at: ${arduino.path}`);
      console.log(`   Manufacturer: ${arduino.manufacturer || "Unknown"}`);

      // Optional: update .env file
      let envContent = "";
      if (fs.existsSync(ENV_PATH)) {
        envContent = fs.readFileSync(ENV_PATH, "utf8");
        if (envContent.includes("SERIAL_PORT=")) {
          envContent = envContent.replace(
            /SERIAL_PORT=.*/,
            `SERIAL_PORT=${arduino.path}`
          );
        } else {
          envContent += `\nSERIAL_PORT=${arduino.path}\n`;
        }
      } else {
        envContent = `SERIAL_PORT=${arduino.path}\n`;
      }
      fs.writeFileSync(ENV_PATH, envContent);
      console.log(`\n✅ Updated .env with SERIAL_PORT=${arduino.path}`);
      console.log("\n🚀 Now run: node server.js");
    } else {
      console.log("❌ No Arduino found.");
      console.log("\n💡 Make sure your Arduino is connected via USB.");
      console.log("💡 If using a clone, install CH340/CP210 drivers.");
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

detectArduino();
