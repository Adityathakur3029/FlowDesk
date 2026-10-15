import { app } from "./app";
import { connectDb } from "./db";

const PORT = Number(process.env.PORT) || 3000;

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
