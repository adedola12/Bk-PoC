import mongoose from "mongoose";

let connectPromise = null;

/** Idempotent Atlas connection (ADLM pattern) — safe to call more than once. */
export function connectDB(uri = process.env.MONGODB_URI) {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  if (!connectPromise) {
    mongoose.set("strictQuery", true);
    connectPromise = mongoose
      .connect(uri, { dbName: "bkIngest", serverSelectionTimeoutMS: 10000 })
      .then((conn) => {
        console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
        return conn.connection;
      })
      .catch((err) => {
        console.error(`MongoDB connection error: ${err.message}`);
        process.exit(1);
      });
    mongoose.connection.on("error", (err) => console.error("MongoDB error:", err.message));
  }
  return connectPromise;
}
