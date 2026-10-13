import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { pool, connectDb } from "./db";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Middleware: allow cross-origin requests and parse JSON bodies
app.use(cors());
app.use(express.json());

// Health check that also verifies the database connection
app.get("/health-check", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");
    res.json({ status: "ok", dbTime: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "Database unreachable" });
  }
});

// Connect to the database first, then start accepting requests
async function start(): Promise<void> {
  try {
    await connectDb();
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
