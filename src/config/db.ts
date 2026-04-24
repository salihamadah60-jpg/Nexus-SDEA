import mongoose from "mongoose";

export async function connectDB() {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI missing — running in ephemeral mode");
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log("✅ Neural Memory Connected");
  } catch (err: any) {
    console.warn("⚠️ MongoDB:", err.message);
  }
}

export const isDbConnected = () => mongoose.connection.readyState === 1;
