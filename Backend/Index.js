require("dotenv/config");

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mqtt = require("mqtt");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const { createServer } = require("http");
const { WebSocketServer } = require("ws");

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const MONGO_URI =
  "mongodb://admin:password123456789@ac-7s8npij-shard-00-00.k9zdoh3.mongodb.net:27017,ac-7s8npij-shard-00-01.k9zdoh3.mongodb.net:27017,ac-7s8npij-shard-00-02.k9zdoh3.mongodb.net:27017/?ssl=true&replicaSet=atlas-tj4hd5-shard-0&authSource=admin&appName=Cluster0";

const MQTT_BROKER = "mqtt://localhost:1883";
const MQTT_TOPIC = "aquasense/sensors";

// READ FROM .env INSTEAD OF HARDCODING
const SERIAL_PORT_PATH = process.env.SERIAL_PORT || null;
const SERIAL_BAUD_RATE = 9600;

// ─────────────────────────────────────────────────────────────
// THRESHOLDS
// ─────────────────────────────────────────────────────────────

const THRESHOLDS = {
  ph: { min: 6.0, max: 9.0 },
  temperature: { min: 5, max: 35 },
  turbidity: { min: 0, max: 10 },
  dissolvedOxygen: { min: 5, max: 14 },
  conductivity: { min: 100, max: 1000 },
};

const FIELDS = [
  "ph",
  "temperature",
  "turbidity",
  "dissolvedOxygen",
  "conductivity",
];

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function computeStatus(doc) {
  // FIX: Handle missing values
  for (const [key, range] of Object.entries(THRESHOLDS)) {
    const value = doc[key];
    if (value === undefined || value === null) continue;
    if (value < range.min || value > range.max) {
      return "danger";
    }
  }
  return "safe";
}

function validateReading(body) {
  const errors = [];
  for (const field of FIELDS) {
    if (body[field] === undefined) {
      errors.push(`${field} missing`);
    }
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────────────────────

const readingSchema = new mongoose.Schema(
  {
    ph: Number,
    temperature: Number,
    turbidity: Number,
    dissolvedOxygen: Number,
    conductivity: Number,
    status: { type: String, default: "safe" },
    source: { type: String, default: "mqtt" },
    deviceId: { type: String, default: "arduino-01" },
  },
  { timestamps: true }
);

const Reading = mongoose.model("Reading", readingSchema);

// ─────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(rateLimit({ windowMs: 60000, max: 200 }));

// ─────────────────────────────────────────────────────────────
// HTTP + WS
// ─────────────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcastReading(reading) {
  const payload = JSON.stringify({ event: "new_reading", data: reading });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

wss.on("connection", async (ws) => {
  console.log("[WS] Client connected");
  try {
    const latest = await Reading.findOne().sort({ createdAt: -1 }).lean();
    if (latest) {
      ws.send(JSON.stringify({ event: "new_reading", data: latest }));
    }
  } catch (err) {
    console.log("[WS ERROR]", err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.send("AquaSense backend running"));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

app.get("/data", async (req, res) => {
  try {
    const data = await Reading.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// BOAT CONTROL
// ─────────────────────────────────────────────────────────────

let currentBoatCommand = { forward: 0, turn: 0 };

app.post("/boat/control", (req, res) => {
  const { forward, turn } = req.body;
  currentBoatCommand = { forward, turn };
  console.log(`[BOAT] Forward: ${forward}%, Turn: ${turn}%`);
  
  if (serialPort && serialPort.isOpen) {
    const command = `${forward},${turn}\n`;
    serialPort.write(command);
    console.log(`[SERIAL SENT] ${command.trim()}`);
  } else {
    console.log("[BOAT] Serial port not connected");
  }
  
  res.json({ status: "ok", forward, turn });
});

app.get("/boat/control", (req, res) => {
  res.json(currentBoatCommand);
});

// ─────────────────────────────────────────────────────────────
// MQTT
// ─────────────────────────────────────────────────────────────

function startMqtt() {
  const client = mqtt.connect(MQTT_BROKER);
  client.on("connect", () => {
    console.log("[MQTT] Connected");
    client.subscribe(MQTT_TOPIC, (err) => {
      if (err) console.log("[MQTT] Subscribe error", err.message);
      else console.log("[MQTT] Subscribed to", MQTT_TOPIC);
    });
  });
  client.on("message", async (topic, message) => {
    try {
      console.log("[MQTT RAW]", message.toString());
      const payload = JSON.parse(message.toString());
      const errors = validateReading(payload);
      if (errors.length) {
        console.log("[MQTT INVALID]", errors);
        return;
      }
      const reading = new Reading({
        ph: Number(payload.ph),
        temperature: Number(payload.temperature),
        turbidity: Number(payload.turbidity),
        dissolvedOxygen: Number(payload.dissolvedOxygen),
        conductivity: Number(payload.conductivity),
        source: "mqtt",
        deviceId: payload.deviceId || "arduino-01",
      });
      reading.status = computeStatus(reading);
      await reading.save();
      console.log("[DB] Saved reading from MQTT");
      broadcastReading(reading);
    } catch (err) {
      console.log("[MQTT ERROR]", err.message);
    }
  });
  client.on("error", (err) => console.log("[MQTT ERROR]", err.message));
}

// ─────────────────────────────────────────────────────────────
// SERIAL PORT
// ─────────────────────────────────────────────────────────────

let serialPort = null;

function startSerialPort() {
  // FIX: Check if port is specified
  if (!SERIAL_PORT_PATH) {
    console.log("[SERIAL] ⚠️ No SERIAL_PORT in .env. Run node find-port.js");
    return;
  }

  try {
    serialPort = new SerialPort({
      path: SERIAL_PORT_PATH,
      baudRate: SERIAL_BAUD_RATE,
      autoOpen: true,
    });
    
    const parser = serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));
    
    parser.on("data", async (line) => {
      try {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;
        console.log("[SERIAL RAW]", trimmedLine);
        
        let payload;
        try {
          payload = JSON.parse(trimmedLine);
        } catch (e) {
          if (!trimmedLine.includes("{") && !trimmedLine.includes("}")) {
            console.log("[SERIAL DEBUG]", trimmedLine);
          }
          return;
        }
        
        const errors = validateReading(payload);
        if (errors.length) {
          console.log("[SERIAL INVALID]", errors);
          return;
        }
        
        const reading = new Reading({
          ph: Number(payload.ph),
          temperature: Number(payload.temperature),
          turbidity: Number(payload.turbidity),
          dissolvedOxygen: Number(payload.dissolvedOxygen),
          conductivity: Number(payload.conductivity),
          source: "serial",
          deviceId: payload.deviceId || "arduino-serial",
        });
        reading.status = computeStatus(reading);
        await reading.save();
        console.log("[DB] Saved reading from Serial (Arduino)");
        broadcastReading(reading);
      } catch (err) {
        console.log("[SERIAL ERROR]", err.message);
      }
    });
    
    serialPort.on("open", () => {
      console.log(`[SERIAL] ✅ Connected to ${SERIAL_PORT_PATH} at ${SERIAL_BAUD_RATE} baud`);
    });
    
    serialPort.on("error", (err) => {
      console.log("[SERIAL ERROR]", err.message);
      serialPort = null;
    });
    
    serialPort.on("close", () => {
      console.log("[SERIAL] Port closed");
      serialPort = null;
    });
  } catch (err) {
    console.log("[SERIAL] Failed to open port:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log("[BOOT] Starting backend");
    await mongoose.connect(MONGO_URI);
    console.log("[DB] MongoDB connected");
    startMqtt();
    startSerialPort();
    server.listen(PORT, () => {
      console.log(`[HTTP] http://localhost:${PORT}`);
      console.log(`[WS] ws://localhost:${PORT}`);
      console.log(`[BOAT] Boat control: http://localhost:${PORT}/boat/control`);
    });
  } catch (err) {
    console.log("[BOOT ERROR]", err.message);
  }
}

main();
